/**
 * The README's quick start is the text of two files under tests/readmeQuickStart/, which
 * the typecheck covers. This suite fails when the README and those files differ.
 *
 * Run: npx tsx tests/readmeQuickStart.ts
 */

import fs from 'fs'
import { assert, reportResults } from './testHelpers.js'

const SPECIFIERS_BY_SOURCE_PATH: Record<string, string> = {
  "'../../src/client/index.js'": "'@dasasian/firebase-structured-logger/client'",
  "'../../src/functions/index.js'": "'@dasasian/firebase-structured-logger/functions'",
}

function quickStartBlocks(): string[] {
  const readme = fs.readFileSync('README.md', 'utf8')
  const section = readme.split('\n## Quick start\n')[1]?.split('\n## ')[0] ?? ''
  return [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1].trim())
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
reportResults()
