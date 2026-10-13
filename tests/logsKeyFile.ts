/**
 * The key file: one resolver for `fsl logs`, `fsl logs attachments` and `fsl upload-sourcemaps`.
 * `gcloud` gets the override in its own environment only; the Storage client gets the path.
 * A key file's contents are never read: the files here hold a placeholder word.
 *
 * Run: npx tsx tests/logsKeyFile.ts
 */

import { storageConstructions } from './fakeStorage.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'
import { FAKE_BUCKET, FAKE_PROJECT, FIXED_NOW, runFsl, tempProject, withFirebaserc } from './logsHelpers.js'
import { runLogs } from '../src/tools/logs/command.js'
import { GcloudError, runGcloud } from '../src/tools/logs/gcloud.js'
import { resolveKeyFile } from '../src/tools/keyFile.js'
import { resetDeprecationWarnings } from '../src/shared/deprecate.js'
import { uploadSourceMaps } from '../src/tools/uploadSourceMaps.js'

const OVERRIDE = 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'
const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function keyFilePlaceholder(dir: string, name: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, 'placeholder, not a key')
  return file
}

function projectWithKeyFiles(): { cwd: string; current: string; deprecated: string; missing: string } {
  const cwd = tempProject()
  withFirebaserc(cwd)
  return { cwd, current: keyFilePlaceholder(cwd, 'current.json'), deprecated: keyFilePlaceholder(cwd, 'deprecated.json'), missing: path.join(cwd, 'not-there.json') }
}

function captureWarnings<T>(body: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')) }
  resetDeprecationWarnings()
  try {
    return { result: body(), warnings }
  } finally {
    console.warn = original
  }
}

async function captureWarningsAsync<T>(body: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')) }
  resetDeprecationWarnings()
  try {
    return { result: await body(), warnings }
  } finally {
    console.warn = original
  }
}

function testWhichNameWins() {
  console.log('\nTest: the deprecated name wins and warns once; empty is not set')
  const { cwd, current, deprecated } = projectWithKeyFiles()
  const both = captureWarnings(() => [
    resolveKeyFile({ GOOGLE_APPLICATION_CREDENTIALS: current, FIREBASE_SERVICE_ACCOUNT_PATH: deprecated }, cwd),
    resolveKeyFile({ GOOGLE_APPLICATION_CREDENTIALS: current, FIREBASE_SERVICE_ACCOUNT_PATH: deprecated }, cwd),
  ])
  assert('both set: the old name is used', both.result[0]?.path === deprecated && both.result[0]?.variable === 'FIREBASE_SERVICE_ACCOUNT_PATH')
  assert('both set: one warning for two calls, naming the new name', both.warnings.length === 1 && both.warnings[0].includes('GOOGLE_APPLICATION_CREDENTIALS'), both.warnings.join('\n'))
  const only = captureWarnings(() => resolveKeyFile({ FIREBASE_SERVICE_ACCOUNT_PATH: deprecated }, cwd))
  assert('only the old name: used, with the warning', only.result?.path === deprecated && only.warnings.length === 1)
  const newest = captureWarnings(() => resolveKeyFile({ GOOGLE_APPLICATION_CREDENTIALS: current }, cwd))
  assert('only the new name: used, no warning', newest.result?.path === current && newest.result.variable === 'GOOGLE_APPLICATION_CREDENTIALS' && newest.warnings.length === 0)
  const empty = captureWarnings(() => resolveKeyFile({ GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT_PATH: '' }, cwd))
  assert('empty values: not set, no warning', empty.result === undefined && empty.warnings.length === 0)
  const emptyOld = captureWarnings(() => resolveKeyFile({ GOOGLE_APPLICATION_CREDENTIALS: current, FIREBASE_SERVICE_ACCOUNT_PATH: '' }, cwd))
  assert('an empty old name does not hide the new one', emptyOld.result?.path === current && emptyOld.warnings.length === 0)
}

async function testGcloudChildGetsTheOverrideAndTheParentDoesNot() {
  console.log('\nTest: the gcloud process of logs and attachments gets the override; the parent does not')
  const { cwd, current } = projectWithKeyFiles()
  delete process.env[OVERRIDE]
  const parentEnvironment = { GOOGLE_APPLICATION_CREDENTIALS: current }
  const query = await runFsl([], { cwd, cloud: [], env: parentEnvironment })
  assert('logs: the read carries the override', query.cloudRequests[0].childEnvironment?.[OVERRIDE] === current, JSON.stringify(query.cloudRequests[0].childEnvironment))
  const attachments = await runFsl(['attachments', '01JABC'], { cwd, env: { ...parentEnvironment, FIREBASE_STORAGE_BUCKET: FAKE_BUCKET }, gcloudOutput: (args) => (args[1] === 'ls' ? 'gs://b/x/a.txt\n' : '') })
  assert('attachments: both gcloud calls carry it', attachments.gcloudCalls.length === 2 && attachments.gcloudChildEnvironments.every((env) => env?.[OVERRIDE] === current), JSON.stringify(attachments.gcloudChildEnvironments))
  assert('the parent environment was not changed', !(OVERRIDE in parentEnvironment) && process.env[OVERRIDE] === undefined)
  const none = await runFsl([], { cwd, cloud: [], env: {} })
  assert('no name set: the child gets none', none.cloudRequests[0].childEnvironment === undefined)
  const noneAttachments = await runFsl(['attachments', '01JABC'], { cwd, env: { FIREBASE_STORAGE_BUCKET: FAKE_BUCKET }, gcloudOutput: (args) => (args[1] === 'ls' ? 'gs://b/x/a.txt\n' : '') })
  assert('attachments with no name set: the child gets none', noneAttachments.gcloudChildEnvironments.length === 2 && noneAttachments.gcloudChildEnvironments.every((env) => env === undefined))
  const { result: old } = await captureWarningsAsync(() => runFsl([], { cwd, cloud: [], env: { GOOGLE_APPLICATION_CREDENTIALS: current, FIREBASE_SERVICE_ACCOUNT_PATH: projectWithKeyFiles().deprecated } }))
  assert('both names: the old one reaches gcloud', old.cloudRequests[0].childEnvironment?.[OVERRIDE]?.endsWith('deprecated.json') === true)
  const local = await runFsl(['--local'], { cwd, env: { GOOGLE_APPLICATION_CREDENTIALS: path.join(cwd, 'not-there.json') } })
  assert('--local never needs the key file', !local.stderr.join('').includes('not-there.json'), local.stderr.join('\n'))
}

async function testRealRunnerGivesTheOverrideToTheChildOnly() {
  console.log('\nTest: runGcloud puts the override in the child process environment, not in this one')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-fake-gcloud-'))
  fs.writeFileSync(path.join(bin, 'gcloud'), '#!/bin/sh\necho "override=${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE}"\n', { mode: 0o755 })
  const originalPath = process.env.PATH
  delete process.env[OVERRIDE]
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  try {
    const given = await runGcloud(['anything'], { [OVERRIDE]: '/keys/one.json' })
    assert('the child saw the path', given.trim() === 'override=/keys/one.json', given)
    assert('this process did not', process.env[OVERRIDE] === undefined)
    const none = await runGcloud(['anything'])
    assert('with none given the child sees none', none.trim() === 'override=', none)
  } finally {
    process.env.PATH = originalPath
  }
}

async function testMissingFileIsAnErrorAndNothingIsSent() {
  console.log('\nTest: a named file that is not there is an error and nothing is sent')
  const { cwd, missing } = projectWithKeyFiles()
  for (const variable of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_SERVICE_ACCOUNT_PATH']) {
    const env = { [variable]: missing, FIREBASE_STORAGE_BUCKET: FAKE_BUCKET }
    const { result: logs } = await captureWarningsAsync(() => runFsl([], { cwd, cloud: [], env }))
    assert(`logs, ${variable}: exit 1 naming the variable and the path`, logs.code === 1 && logs.stderr[0].includes(variable) && logs.stderr[0].includes(missing), logs.stderr.join('\n'))
    assert(`logs, ${variable}: nothing sent`, logs.cloudRequests.length === 0)
    const { result: attachments } = await captureWarningsAsync(() => runFsl(['attachments', '01JABC'], { cwd, env }))
    assert(`attachments, ${variable}: exit 1 naming the variable and the path`, attachments.code === 1 && attachments.stderr[0].includes(variable) && attachments.stderr[0].includes(missing), attachments.stderr.join('\n'))
    assert(`attachments, ${variable}: nothing sent`, attachments.gcloudCalls.length === 0)
    assert('the bucket and project are not printed', !(logs.stderr.concat(attachments.stderr)).join('\n').includes(FAKE_BUCKET))
  }
}

function runUploadCli(cwd: string, env: Record<string, string>) {
  const out = spawnSync('npx', ['tsx', CLI, 'upload-sourcemaps', '--bucket=sentinel-bucket', '--release=r1'], { cwd, encoding: 'utf-8', env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT_PATH: '', ...env } })
  return { status: out.status, stderr: out.stderr, stdout: out.stdout }
}

function uploadProject(): { root: string; dist: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-upload-key-'))
  const dist = path.join(root, 'dist')
  fs.mkdirSync(dist)
  fs.writeFileSync(path.join(dist, 'app-abc.js.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }))
  return { root, dist }
}

function testUploadWithAMissingFileIsAnErrorAndKeepsTheMaps() {
  console.log('\nTest: upload-sourcemaps with a named file that is not there exits 1 and sends nothing')
  for (const variable of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_SERVICE_ACCOUNT_PATH']) {
    const { root, dist } = uploadProject()
    const missing = path.join(root, 'not-there.json')
    const out = runUploadCli(root, { [variable]: missing })
    assert(`${variable}: exit 1`, out.status === 1, String(out.status))
    assert(`${variable}: names the variable and the path`, out.stderr.includes(variable) && out.stderr.includes(missing), out.stderr)
    assert(`${variable}: no stack trace`, !/^\s+at /m.test(out.stderr), out.stderr)
    assert(`${variable}: the map is still in dist/ and nothing was uploaded`, fs.existsSync(path.join(dist, 'app-abc.js.map')) && !out.stdout.includes('Uploading'), out.stdout)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function uploadWith(env: NodeJS.ProcessEnv): Promise<Array<Record<string, unknown>>> {
  const { root, dist } = uploadProject()
  const saved = { ...process.env }
  Object.assign(process.env, { GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT_PATH: '', ...env })
  storageConstructions.length = 0
  const silent = console.log
  console.log = () => {}
  try {
    await captureWarningsAsync(() => uploadSourceMaps({ bucket: 'sentinel-bucket', release: 'r1', distDir: dist }))
  } finally {
    console.log = silent
    process.env = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
  return [...storageConstructions]
}

async function testStorageClientGetsThePathFromEitherName() {
  console.log('\nTest: the Storage client is given the key file from either name, and none when none is named')
  const { current, deprecated } = projectWithKeyFiles()
  const viaNew = await uploadWith({ GOOGLE_APPLICATION_CREDENTIALS: current })
  assert('new name', viaNew.length === 1 && viaNew[0].keyFilename === current, JSON.stringify(viaNew))
  const viaOld = await uploadWith({ FIREBASE_SERVICE_ACCOUNT_PATH: deprecated })
  assert('old name', viaOld.length === 1 && viaOld[0].keyFilename === deprecated, JSON.stringify(viaOld))
  const both = await uploadWith({ GOOGLE_APPLICATION_CREDENTIALS: current, FIREBASE_SERVICE_ACCOUNT_PATH: deprecated })
  assert('both: the old name wins', both.length === 1 && both[0].keyFilename === deprecated, JSON.stringify(both))
  const neither = await uploadWith({})
  assert('none named: no key file option', neither.length === 1 && !('keyFilename' in neither[0]), JSON.stringify(neither))
}

async function runWithFailure(message: string, env: NodeJS.ProcessEnv, argv: string[] = []): Promise<{ code: number; stderr: string[] }> {
  const cwd = tempProject()
  withFirebaserc(cwd)
  const stderr: string[] = []
  const code = await runLogs(argv, {
    readCloudEntries: async () => { throw new GcloudError(message) },
    runGcloud: async () => { throw new GcloudError(message) },
    now: () => FIXED_NOW,
    cwd,
    env: { FIREBASE_STORAGE_BUCKET: FAKE_BUCKET, ...env },
    printLine: () => {},
    printErrorLine: (line) => stderr.push(line),
  })
  return { code, stderr }
}

async function testFailuresSayWhatToDo() {
  console.log('\nTest: a permission failure under a key file names the variable and the role; a sign-in failure without one names the key file')
  const { current } = projectWithKeyFiles()
  const account = `fsl-reader@${FAKE_PROJECT}.iam.gserviceaccount.com`
  const denied = `gcloud failed: ERROR: (gcloud.logging.read) PERMISSION_DENIED: ${account} does not have permission`
  const logs = await runWithFailure(denied, { GOOGLE_APPLICATION_CREDENTIALS: current })
  const logsText = logs.stderr.join('\n')
  assert('logs: exit 1, gcloud\'s own text kept', logs.code === 1 && logsText.includes('PERMISSION_DENIED'), logsText)
  assert('logs: names the variable and roles/logging.viewer', logsText.includes('GOOGLE_APPLICATION_CREDENTIALS') && logsText.includes('roles/logging.viewer'), logsText)
  assert('logs: the service-account address does not leak the project id', !logsText.includes(FAKE_PROJECT), logsText)
  const { result: oldName } = await captureWarningsAsync(() => runWithFailure(denied, { FIREBASE_SERVICE_ACCOUNT_PATH: current }))
  assert('logs: names the variable that named the key', oldName.stderr.join('\n').includes('named by FIREBASE_SERVICE_ACCOUNT_PATH'), oldName.stderr.join('\n'))
  const storageDenied = `gcloud failed: ERROR: HTTPError 403: ${account} does not have storage.objects.list access to ${FAKE_BUCKET}`
  const attachments = await runWithFailure(storageDenied, { GOOGLE_APPLICATION_CREDENTIALS: current }, ['attachments', '01JABC'])
  const attachmentsText = attachments.stderr.join('\n')
  assert('attachments: names the variable and read access to the bucket', attachmentsText.includes('GOOGLE_APPLICATION_CREDENTIALS') && attachmentsText.includes('read access to the bucket'), attachmentsText)
  assert('attachments: the bucket is hidden', !attachmentsText.includes(FAKE_BUCKET), attachmentsText)
  assert('attachments: the project part of the address is hidden, the account name stays', attachmentsText.includes('fsl-reader@<hidden>.iam.gserviceaccount.com') && !attachmentsText.includes(FAKE_PROJECT), attachmentsText)
  const uploaderDenied = await runWithFailure(`gcloud failed: ERROR: HTTPError 403: uploader@${FAKE_PROJECT}.iam.gserviceaccount.com does not have storage.objects.list access`, { GOOGLE_APPLICATION_CREDENTIALS: current }, ['attachments', '01JABC'])
  assert('attachments: uploader@<hidden>.iam.gserviceaccount.com and no project id', uploaderDenied.stderr.join('\n').includes('uploader@<hidden>.iam.gserviceaccount.com') && !uploaderDenied.stderr.join('\n').includes(FAKE_PROJECT), uploaderDenied.stderr.join('\n'))
  assert('logs: the address keeps its account name', logsText.includes('fsl-reader@<hidden>.iam.gserviceaccount.com'), logsText)
  const noKeyDenied = await runWithFailure(denied, {})
  assert('a permission failure with no key file gets no addition', noKeyDenied.stderr.join('\n').split('\n').length === 1, noKeyDenied.stderr.join('\n'))
  for (const signInFailure of ['Reauthentication failed. cannot prompt during non-interactive execution.', 'You do not currently have an active account selected.']) {
    const signIn = await runWithFailure(`gcloud failed: ERROR: (gcloud.logging.read) ${signInFailure}`, {})
    const text = signIn.stderr.join('\n')
    assert(`sign-in failure "${signInFailure.slice(0, 24)}": gcloud's text kept and the key-file way named`, text.includes(signInFailure) && text.includes('set GOOGLE_APPLICATION_CREDENTIALS'), text)
  }
  const signInUnderKey = await runWithFailure('gcloud failed: Reauthentication failed.', { GOOGLE_APPLICATION_CREDENTIALS: current })
  assert('a sign-in failure under a key file gets no key-file advice', !signInUnderKey.stderr.join('\n').includes('To sign in without'), signInUnderKey.stderr.join('\n'))
  const other = await runWithFailure('gcloud failed: ERROR: something else', { GOOGLE_APPLICATION_CREDENTIALS: current })
  assert('another failure is left as it is', other.stderr.join('\n') === 'gcloud failed: ERROR: something else', other.stderr.join('\n'))
}

async function main() {
  testWhichNameWins()
  await testGcloudChildGetsTheOverrideAndTheParentDoesNot()
  await testRealRunnerGivesTheOverrideToTheChildOnly()
  await testMissingFileIsAnErrorAndNothingIsSent()
  testUploadWithAMissingFileIsAnErrorAndKeepsTheMaps()
  await testStorageClientGetsThePathFromEitherName()
  await testFailuresSayWhatToDo()
  reportResults()
}

main()
