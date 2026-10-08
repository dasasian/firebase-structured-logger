/**
 * `install-skills` ships `fsl-logs`, no longer ships `query-logs`, and removes an installed
 * copy of it. Runs in a temp folder as the project root.
 *
 * Run: npx tsx tests/installSkills.ts
 */

import fs from 'fs'
import path from 'path'
import { installSkills } from '../src/tools/installSkills.js'
import { assert, reportResults } from './testHelpers.js'
import { tempProject } from './logsHelpers.js'

async function testInstallsFslLogsAndRemovesQueryLogs() {
  console.log('\nTest: install-skills --force installs fsl-logs and removes an installed query-logs')
  const project = tempProject()
  const skills = path.join(project, '.claude', 'skills')
  fs.mkdirSync(path.join(skills, 'query-logs'), { recursive: true })
  fs.writeFileSync(path.join(skills, 'query-logs', 'SKILL.md'), 'old')
  const previous = process.cwd()
  const log = console.log
  process.chdir(project)
  console.log = () => {}
  try {
    await installSkills({ force: true })
  } finally {
    console.log = log
    process.chdir(previous)
  }
  assert('fsl-logs is installed', fs.existsSync(path.join(skills, 'fsl-logs', 'SKILL.md')))
  assert('query-logs is gone', !fs.existsSync(path.join(skills, 'query-logs')))
  assert('the package no longer ships query-logs', !fs.existsSync(path.join(process.cwd(), 'skills', 'query-logs')))
  const frontmatter = fs.readFileSync(path.join(skills, 'fsl-logs', 'SKILL.md'), 'utf-8').split('---')[1]
  assert('frontmatter has name, description and fsl-version', /^name: fsl-logs$/m.test(frontmatter) && /^description: .+/m.test(frontmatter) && /^fsl-version: <version>$/m.test(frontmatter), frontmatter)
}

async function testNothingToRemoveIsQuiet() {
  console.log('\nTest: with no query-logs installed nothing is asked or removed')
  const project = tempProject()
  const previous = process.cwd()
  const log = console.log
  const lines: string[] = []
  process.chdir(project)
  console.log = (line: string) => void lines.push(line)
  try {
    await installSkills({})
  } finally {
    console.log = log
    process.chdir(previous)
  }
  assert('no removal line', !lines.some((line) => line.includes('removed') || line.includes('kept')))
}

async function main() {
  await testInstallsFslLogsAndRemovesQueryLogs()
  await testNothingToRemoveIsQuiet()
  reportResults()
}

main()
