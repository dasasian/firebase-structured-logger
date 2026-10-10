/**
 * CAPABILITIES.md and the /fsl-review skill that reads it.
 *
 * The file is read by an agent, so its shape is checked: four fixed headings per section,
 * sections that stand alone, code blocks whose imports are really exported from the entry
 * point they name, and the four known misuses named under Mistakes. The skill is checked
 * for frontmatter and for naming nothing a release could change.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/capabilities.ts
 */

import fs from 'fs'
import path from 'path'
import { assert, reportResults } from './testHelpers.js'
import * as client from '../src/client/index.js'
import * as navigation from '../src/client/navigation.js'
import * as reactRouterNavigation from '../src/client/navigation/react-router.js'
import * as vueRouterNavigation from '../src/client/navigation/vue-router.js'
import * as timing from '../src/client/timing.js'
import * as views from '../src/client/views.js'
import * as actions from '../src/client/actions.js'
import * as functions from '../src/functions/index.js'
import * as testing from '../src/testing.js'

const ROOT = process.cwd()
const PACKAGE_NAME = '@dasasian/firebase-structured-logger'
const HEADINGS = ['Gives', 'Fits when', 'Add', 'Mistakes']

const ENTRY_POINTS: Record<string, Record<string, unknown>> = {
  client,
  'client/navigation': navigation,
  'client/navigation/react-router': reactRouterNavigation,
  'client/navigation/vue-router': vueRouterNavigation,
  'client/timing': timing,
  'client/views': views,
  'client/actions': actions,
  functions,
  testing,
}

interface Section {
  title: string
  parts: Map<string, string>
  headings: string[]
  text: string
}

const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf-8')

function parseSections(markdown: string): Section[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [title, ...rest] = chunk.split('\n')
      const text = rest.join('\n')
      const parts = new Map<string, string>()
      const headings: string[] = []
      for (const piece of text.split(/^### /m).slice(1)) {
        const [heading, ...body] = piece.split('\n')
        headings.push(heading.trim())
        parts.set(heading.trim(), body.join('\n'))
      }
      return { title: title.trim(), parts, headings, text }
    })
}

function codeBlocks(markdown: string): { lang: string; code: string }[] {
  return [...markdown.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2] }))
}

function packageImports(code: string): { names: string[]; specifier: string }[] {
  return [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
    .filter((m) => m[2].startsWith(`${PACKAGE_NAME}/`))
    .map((m) => ({
      names: m[1].split(',').map((n) => n.trim()).filter(Boolean),
      specifier: m[2].slice(PACKAGE_NAME.length + 1),
    }))
}

const sections = parseSections(capabilities)

const CAPABILITY_TITLES = [
  'Error capture',
  'Breadcrumbs',
  'Navigation',
  'Pages without a URL change',
  'Views',
  'Marked actions',
  'User and labels',
  'Release ids and source maps',
  'Attachments',
  'Feedback',
  'Timing traces',
  'Testing what an app logs',
  'Cloud Functions logger',
  'withLogging and createHttpLogHandler',
]

function testSectionShape() {
  console.log('\nTest: every section has the four headings, in order')
  const titles = sections.map((section) => section.title)
  assert('the sections are exactly the capabilities an app adds', titles.join('|') === CAPABILITY_TITLES.join('|'), titles.join(' | '))
  for (const section of sections) {
    assert(`${section.title}: Gives, Fits when, Add, Mistakes`, section.headings.join('|') === HEADINGS.join('|'), section.headings.join('|'))
  }
}

function testSectionsStandAlone() {
  console.log('\nTest: no section points at another')
  const pointers = /\bsee above\b|\bas mentioned\b|\bsee below\b|\bsee section\b|\bsection "|\bthe previous section\b/i
  for (const section of sections) {
    assert(`${section.title} has no pointer to another section`, !pointers.test(section.text))
  }
}

function testExamplesImportRealSymbols() {
  console.log('\nTest: every code block names its entry point and imports only what it exports')
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { exports: Record<string, unknown> }
  for (const section of sections) {
    const adds = codeBlocks(section.parts.get('Add') ?? '').filter((b) => b.lang === 'ts')
    assert(`${section.title}: Add has no ts block or every ts block imports from the package`, adds.every((b) => packageImports(b.code).length > 0))
  }
  let checked = 0
  for (const { code } of codeBlocks(capabilities).filter((b) => b.lang === 'ts')) {
    for (const { names, specifier } of packageImports(code)) {
      assert(`entry point ./${specifier} is in package.json exports`, `./${specifier}` in packageJson.exports)
      const entry = ENTRY_POINTS[specifier]
      assert(`entry point ${specifier} is known to this test`, entry !== undefined)
      for (const name of names) {
        assert(`${specifier} exports ${name}`, entry !== undefined && name in entry)
        checked++
      }
    }
  }
  assert('some symbols were checked', checked > 20, String(checked))
}

function mistakesOf(titlePattern: RegExp): string {
  return sections.filter((s) => titlePattern.test(s.title)).map((s) => s.parts.get('Mistakes') ?? '').join('\n')
}

const KNOWN_MISTAKES = [
  { name: 'bc.nav with the adapter on', section: /^Navigation$/, mention: 'bc.nav(' },
  { name: 'setScreen with navigation on', section: /^Navigation$/, mention: 'setScreen(' },
  { name: 'a dialog with no data-fsl-view', section: /^Views$/, mention: 'with no `data-fsl-view`' },
  { name: '<Navigate> handled by hand', section: /^Navigation$/, mention: '<Navigate>' },
]

function testKnownMistakesAreNamed() {
  console.log('\nTest: the four known misuses are named under Mistakes')
  for (const mistake of KNOWN_MISTAKES) {
    assert(`${mistake.name}`, mistakesOf(mistake.section).includes(mistake.mention))
  }
}

function readTree(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? readTree(full) : [full]
  })
}

function appSource(app: string): { file: string; text: string }[] {
  return readTree(path.join(ROOT, 'tests', 'fixtures', app)).map((file) => ({ file, text: fs.readFileSync(file, 'utf-8') }))
}

const MISUSE_DETECTORS: Record<string, (file: { text: string }) => boolean> = {
  'bc.nav with the adapter on': ({ text }) => /\bbc\.nav\(/.test(text),
  'setScreen with navigation on': ({ text }) => /\bsetScreen\(/.test(text),
  'a dialog with no data-fsl-view': ({ text }) => text.includes('role="dialog"') && !text.includes('data-fsl-view'),
  '<Navigate> handled by hand': ({ text }) => text.includes('<Navigate') && /\b(bc\.action|navigatedTo)\(/.test(text),
}

function testFixtureApps() {
  console.log('\nTest: the planted-miss app has the four misuses and the clean app has none')
  const planted = appSource('planted-miss-app')
  const clean = appSource('clean-app')
  for (const mistake of KNOWN_MISTAKES) {
    const detect = MISUSE_DETECTORS[mistake.name]
    assert(`planted-miss-app: ${mistake.name}`, planted.some(detect))
    assert(`clean-app: no ${mistake.name}`, !clean.some(detect))
  }
  const cleanText = clean.map((f) => f.text).join('\n')
  assert('clean-app uses the adapter and views', cleanText.includes('enableReactRouterNavigation(') && cleanText.includes('enableViews()'))
}

const ALLOWED_SKILL_CODE = ['CAPABILITIES.md', `node_modules/${PACKAGE_NAME}`, 'npx fsl doctor --json']

function testReviewSkillShape() {
  console.log('\nTest: /fsl-review has frontmatter and names nothing a release could change')
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'fsl-review', 'SKILL.md'), 'utf-8')
  const frontmatter = skill.split('---')[1]
  assert('name', /^name: fsl-review$/m.test(frontmatter))
  assert('description', /^description: .+/m.test(frontmatter))
  assert('fsl-version placeholder', /^fsl-version: <version>$/m.test(frontmatter))
  const backticked = [...skill.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  assert('only allowed identifiers in backticks', backticked.every((b) => ALLOWED_SKILL_CODE.includes(b)), backticked.join(' | '))
  assert('groups many places by user flow and asks which flows matter', /by user flow/.test(skill) && /which flows matter most/.test(skill))
}

function testMarkedActionsSaysWhichToMarkFirst() {
  console.log('\nTest: Marked actions says which controls to mark first')
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf-8')
  const section = capabilities.split('\n## ').find((s) => s.startsWith('Marked actions')) ?? ''
  assert('names the flows to mark first', /Mark first the controls of the flows where a failure costs the user most/.test(section))
}

function testPackaging() {
  console.log('\nTest: the package ships CAPABILITIES.md and skills/fsl-review, and not skills/logs')
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { files: string[] }
  assert('files lists CAPABILITIES.md', packageJson.files.includes('CAPABILITIES.md'))
  assert('files lists skills', packageJson.files.includes('skills'))
  assert('skills/fsl-review exists', fs.existsSync(path.join(ROOT, 'skills', 'fsl-review', 'SKILL.md')))
  assert('skills/logs is gone', !fs.existsSync(path.join(ROOT, 'skills', 'logs')))
}

testSectionShape()
testSectionsStandAlone()
testExamplesImportRealSymbols()
testKnownMistakesAreNamed()
testFixtureApps()
testReviewSkillShape()
testMarkedActionsSaysWhichToMarkFirst()
testPackaging()
reportResults()
