/**
 * `install-skills` ships `fsl-logs` and `fsl-review`, stamps the package version into each
 * skill's frontmatter, and removes an installed copy of a skill it no longer ships — after
 * asking, unless `--force`. Runs in a temp folder as the project root.
 *
 * Run: npx tsx tests/installSkills.ts
 */

import fs from 'fs'
import path from 'path'
import { installSkills } from '../src/tools/installSkills.js'
import { assert, reportResults } from './testHelpers.js'
import { tempProject } from './logsHelpers.js'

const PACKAGE_VERSION = (JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string }).version

interface Install {
  skills: string
  questions: string[]
  lines: string[]
}

async function installInto(project: string, options: { force?: boolean; answer?: string }): Promise<Install> {
  const questions: string[] = []
  const lines: string[] = []
  const previous = process.cwd()
  const log = console.log
  process.chdir(project)
  console.log = (line: string) => void lines.push(line)
  try {
    await installSkills({
      force: options.force,
      ask: async (question) => {
        questions.push(question)
        return options.answer ?? 'n'
      },
    })
  } finally {
    console.log = log
    process.chdir(previous)
  }
  return { skills: path.join(project, '.claude', 'skills'), questions, lines }
}

function plant(skills: string, name: string): void {
  fs.mkdirSync(path.join(skills, name), { recursive: true })
  fs.writeFileSync(path.join(skills, name, 'SKILL.md'), 'planted')
}

function frontmatterOf(file: string): string {
  return fs.readFileSync(file, 'utf-8').split('---')[1]
}

async function testStampsTheVersion() {
  console.log('\nTest: every installed skill carries fsl-version equal to package.json')
  const { skills } = await installInto(tempProject(), {})
  for (const name of ['fsl-logs', 'fsl-review']) {
    const frontmatter = frontmatterOf(path.join(skills, name, 'SKILL.md'))
    assert(`${name} has name and description`, new RegExp(`^name: ${name}$`, 'm').test(frontmatter) && /^description: .+/m.test(frontmatter))
    assert(`${name} fsl-version is ${PACKAGE_VERSION}`, new RegExp(`^fsl-version: ${PACKAGE_VERSION.replace(/\./g, '\\.')}$`, 'm').test(frontmatter), frontmatter)
  }
}

async function testEveryShippedSkillCanBeStamped() {
  console.log('\nTest: every shipped skill has the fsl-version placeholder')
  const shipped = fs.readdirSync('skills', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  assert('the package ships fsl-logs and fsl-review only', shipped.sort().join(',') === 'fsl-logs,fsl-review', shipped.join(','))
  for (const name of shipped) {
    assert(`${name} has fsl-version: <version>`, /^fsl-version: <version>$/m.test(frontmatterOf(path.join('skills', name, 'SKILL.md'))))
  }
}

async function testRetiredSkillsAreAskedAbout() {
  console.log('\nTest: an installed logs or query-logs is removed only on y')
  for (const retired of ['logs', 'query-logs']) {
    const declined = tempProject()
    plant(path.join(declined, '.claude', 'skills'), retired)
    const no = await installInto(declined, { answer: 'n' })
    assert(`${retired}: asked once, naming it`, no.questions.length === 1 && no.questions[0].includes(`${retired}, which fsl no longer ships? [y/N]`), no.questions.join('|'))
    assert(`${retired}: kept on n`, fs.existsSync(path.join(no.skills, retired)))

    const accepted = tempProject()
    plant(path.join(accepted, '.claude', 'skills'), retired)
    const yes = await installInto(accepted, { answer: 'y' })
    assert(`${retired}: removed on y`, !fs.existsSync(path.join(yes.skills, retired)))
  }
}

async function testForceRemovesWithoutAsking() {
  console.log('\nTest: --force removes without asking and overwrites without asking')
  const project = tempProject()
  const skills = path.join(project, '.claude', 'skills')
  plant(skills, 'logs')
  plant(skills, 'fsl-logs')
  const { questions } = await installInto(project, { force: true })
  assert('nothing was asked', questions.length === 0, questions.join('|'))
  assert('logs is gone', !fs.existsSync(path.join(skills, 'logs')))
  assert('fsl-logs was overwritten', fs.readFileSync(path.join(skills, 'fsl-logs', 'SKILL.md'), 'utf-8') !== 'planted')
}

async function testNeverTouchesWhatItDidNotShip() {
  console.log('\nTest: a folder the package never shipped is left alone, even with --force')
  const project = tempProject()
  const skills = path.join(project, '.claude', 'skills')
  plant(skills, 'my-own-skill')
  await installInto(project, { force: true })
  assert('my-own-skill is untouched', fs.readFileSync(path.join(skills, 'my-own-skill', 'SKILL.md'), 'utf-8') === 'planted')
}

async function testNothingToRemoveIsQuiet() {
  console.log('\nTest: with nothing retired installed, nothing is asked or removed')
  const { questions, lines } = await installInto(tempProject(), {})
  assert('nothing asked', questions.length === 0)
  assert('no removal line', !lines.some((line) => line.includes('removed') || line.includes('kept')))
}

async function main() {
  await testStampsTheVersion()
  await testEveryShippedSkillCanBeStamped()
  await testRetiredSkillsAreAskedAbout()
  await testForceRemovesWithoutAsking()
  await testNeverTouchesWhatItDidNotShip()
  await testNothingToRemoveIsQuiet()
  reportResults()
}

main()
