/**
 * `--help` prints the usage and exits 0, for the root and after any command, and runs
 * nothing. Drives the CLI as a real process (`npx tsx`, no build step), so stdin is a pipe:
 * the no-terminal path of `install-skills` is the real one.
 *
 * Run: npx tsx tests/cliHelp.ts
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'
import { tempProject } from './logsHelpers.js'

const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('npx', ['tsx', CLI, ...args], { cwd, encoding: 'utf-8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

function testRootHelpForms() {
  console.log('\nTest: --help, -h and help print the usage and exit 0')
  for (const form of ['--help', '-h', 'help']) {
    const run = runCli(tempProject(), [form])
    assert(`${form}: exit 0`, run.status === 0, `${run.status} ${run.stderr}`)
    assert(`${form}: prints the usage`, run.stdout.includes('firebase-structured-logger (fsl)') && run.stdout.includes('fsl install-skills'))
    assert(`${form}: nothing on stderr`, run.stderr === '', run.stderr)
  }
}

function testInstallSkillsHelpInstallsNothing() {
  console.log('\nTest: install-skills --help and -h print the usage and install nothing')
  for (const form of ['--help', '-h']) {
    const project = tempProject()
    const run = runCli(project, ['install-skills', form])
    assert(`${form}: exit 0`, run.status === 0, `${run.status} ${run.stderr}`)
    assert(`${form}: prints the usage`, run.stdout.includes('fsl install-skills [--global] [--force]'))
    assert(`${form}: no .claude folder`, !fs.existsSync(path.join(project, '.claude')))
  }
}

function testHelpAfterAnyCommand() {
  console.log('\nTest: --help after any command prints the usage and runs nothing')
  for (const command of ['doctor', 'logs', 'upload-sourcemaps']) {
    const run = runCli(tempProject(), [command, '--help'])
    assert(`${command} --help: exit 0`, run.status === 0, `${run.status} ${run.stderr}`)
    assert(`${command} --help: prints the usage`, run.stdout.includes('firebase-structured-logger (fsl)'))
  }
}

function testUnknownCommandStillFails() {
  console.log('\nTest: an unknown command still exits 1')
  const run = runCli(tempProject(), ['nope'])
  assert('exit 1', run.status === 1, String(run.status))
  assert('says which command', run.stderr.includes('Unknown command: nope'), run.stderr)
}

function testInstallSkillsWithoutTerminalExitsOne() {
  console.log('\nTest: install-skills run with no terminal and an old skill in place exits 1 with the --force hint')
  const project = tempProject()
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'logs'), { recursive: true })
  fs.writeFileSync(path.join(project, '.claude', 'skills', 'logs', 'SKILL.md'), 'planted')
  const run = runCli(project, ['install-skills'])
  assert('exit 1', run.status === 1, String(run.status))
  assert('stderr has the --force hint', run.stderr.includes('Run fsl install-skills --force to remove .claude/skills/logs'), run.stderr)
  assert('the old skill is still there', fs.existsSync(path.join(project, '.claude', 'skills', 'logs')))
  assert('the new skills were installed', fs.existsSync(path.join(project, '.claude', 'skills', 'fsl-review', 'SKILL.md')))
}

testRootHelpForms()
testInstallSkillsHelpInstallsNothing()
testHelpAfterAnyCommand()
testUnknownCommandStillFails()
testInstallSkillsWithoutTerminalExitsOne()
reportResults()
