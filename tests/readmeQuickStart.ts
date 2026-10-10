/**
 * The README's quick start is the text of two files under tests/readmeQuickStart/, which
 * the typecheck covers. This suite fails when the README and those files differ, and when
 * a name in code type in the "Say it once" table is not in src/.
 *
 * Run: npx tsx tests/readmeQuickStart.ts
 */

import fs from 'fs'
import { assert, reportResults } from './testHelpers.js'

const SPECIFIERS_BY_SOURCE_PATH: Record<string, string> = {
  "'../../src/client/index.js'": "'@dasasian/firebase-structured-logger/client'",
  "'../../src/functions/index.js'": "'@dasasian/firebase-structured-logger/functions'",
}

const WHERE_EACH_NAME_IN_THE_SAY_IT_ONCE_TABLE_LIVES: Record<string, { file: string; text: string }> = {
  setupGlobalErrorHandler: { file: 'src/client/errorHandler.ts', text: 'export function setupGlobalErrorHandler(' },
  setUser: { file: 'src/client/logger.ts', text: '  setUser(' },
  'data-fsl-action': { file: 'src/client/actions.ts', text: "'data-fsl-action'" },
  'data-fsl-view': { file: 'src/client/views.ts', text: "'data-fsl-view'" },
  withLogging: { file: 'src/functions/requestLogger.ts', text: 'export function withLogging<' },
  enableActions: { file: 'src/client/actions.ts', text: 'export function enableActions(' },
  enableViews: { file: 'src/client/views.ts', text: 'export function enableViews(' },
}

function readmeSection(heading: string): string {
  return fs.readFileSync('README.md', 'utf8').split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? ''
}

function quickStartBlocks(): string[] {
  return [...readmeSection('Quick start').matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1].trim())
}

function namesInCodeType(section: string): string[] {
  const spans = [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1])
  return [...new Set(spans.map((span) => /data-fsl-[a-z]+/.exec(span)?.[0] ?? /(\w+)\(/.exec(span)?.[1] ?? span))]
}

function fixtureFromFirstImport(file: string): string {
  let text = fs.readFileSync(file, 'utf8')
  for (const [sourcePath, packageName] of Object.entries(SPECIFIERS_BY_SOURCE_PATH)) {
    text = text.split(sourcePath).join(packageName)
  }
  return text.slice(text.search(/^import /m)).trim()
}

const blocks = quickStartBlocks()
assert('the quick start has two ts blocks', blocks.length === 2, `found ${blocks.length}`)
assert('the browser block is tests/readmeQuickStart/browser.ts', blocks[0] === fixtureFromFirstImport('tests/readmeQuickStart/browser.ts'))
assert('the backend block is tests/readmeQuickStart/backend.ts', blocks[1] === fixtureFromFirstImport('tests/readmeQuickStart/backend.ts'))

const namesInTheTable = namesInCodeType(readmeSection('Say it once, where it happens'))
assert('the "Say it once" section names what an app writes', namesInTheTable.length >= 5, `found ${namesInTheTable.length}`)
for (const name of namesInTheTable) {
  const home = WHERE_EACH_NAME_IN_THE_SAY_IT_ONCE_TABLE_LIVES[name]
  assert(`${name} has a check`, home !== undefined)
  assert(`${name} is in ${home?.file ?? 'src/'}`, home !== undefined && fs.readFileSync(home.file, 'utf8').includes(home.text))
}
reportResults()
