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
import { DEPRECATED_DECLARATIONS, DEPRECATED_CLI_FLAGS, DEPRECATED_ENVIRONMENT_VARIABLES } from './deprecatedList.js'
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

function testTheLoggerAddsTheErrorBreadcrumbAndTheTextsSayWhy() {
  console.log('\nTest: the logger adds an error breadcrumb, and Breadcrumbs and Feedback say so')
  const handledErrorLine = mistakesOf(/^Breadcrumbs$/).split('\n').find((line) => line.includes('bc.handledError(` next to `logger.error('))
  assert('the handledError next to logger.error line exists', handledErrorLine !== undefined)
  assert('it gives the reason that the trail shows the error twice', handledErrorLine?.includes('the trail shows the error twice') === true, handledErrorLine)
  assert('it does not say the logs hold it in time order', handledErrorLine?.includes('time order') === false, handledErrorLine)
  assert('Breadcrumbs Gives names the error breadcrumb the logger adds', sectionPart('Breadcrumbs', 'Gives').includes('An `error` breadcrumb, named with the entry\'s `errorType`'))
  assert('Feedback Gives says the trail shows the errors logged before it', sectionPart('Feedback', 'Gives').includes('shows the errors logged before it'))
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

const ALLOWED_SKILL_CODE = ['CAPABILITIES.md', `node_modules/${PACKAGE_NAME}`, 'node_modules/.bin/fsl doctor --json']

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
  const flat = skill.replace(/\s+/g, ' ')
  assert('lists component files and conditional blocks before deciding', /list what is in the scope: each component file, and each block that is rendered on a condition/.test(flat))
  assert('says the Fits when words are not the limit of the search', /not the limit of the search/.test(flat))
  assert('says in one line what was read', /Say in one line what you read: how many files, and the kinds of place/.test(flat))
  assert('reads comments before proposing a removal', /Before you propose to remove code, read the comments at that place/.test(flat))
  assert('gives both sides and does not call the removal a fix', /give both sides and do not call the removal a fix/.test(flat))
}

function testReviewSkillNamesNoCapability() {
  console.log('\nTest: /fsl-review contains no capability title from CAPABILITIES.md')
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'fsl-review', 'SKILL.md'), 'utf-8')
  assert('there are capability titles to check', sections.length >= 10, `found ${sections.length}`)
  for (const { title } of sections) {
    assert(`the skill does not contain "${title}"`, !skill.toLowerCase().includes(title.toLowerCase()))
  }
}

function sectionPart(title: string, heading: string): string {
  return sections.find((s) => s.title === title)?.parts.get(heading) ?? ''
}

function testNewPlacesAreInTheirSections() {
  console.log('\nTest: the new places and lines are in Pages without a URL change and Views')
  const pages = sectionPart('Pages without a URL change', 'Fits when')
  assert('pages: the Vue chain', pages.includes('`v-if` / `v-else-if` / `v-else` chain'))
  assert('pages: the React early returns', pages.includes('chain of early returns'))
  const viewsFits = sectionPart('Views', 'Fits when')
  for (const word of ['role="menu"', 'role="alertdialog"', '<Teleport', 'createPortal(', 'next to a backdrop']) {
    assert(`views: ${word}`, viewsFits.includes(word))
  }
  assert('views: says which to mark first', /Mark first the dialogs, the overlays and the layout mode/.test(sectionPart('Views', 'Add')))
  assert(
    'views: regions always visible together are a mistake',
    /several regions that are always visible together.* →.* → mark the layout mode once, with a name from a fixed set, or mark nothing/.test(sectionPart('Views', 'Mistakes'))
  )
}

function testMarkedActionsSaysWhichToMarkFirst() {
  console.log('\nTest: Marked actions says which controls to mark first')
  const capabilities = fs.readFileSync(path.join(ROOT, 'CAPABILITIES.md'), 'utf-8')
  const section = capabilities.split('\n## ').find((s) => s.startsWith('Marked actions')) ?? ''
  assert('names the flows to mark first', /Mark first the controls of the flows where a failure costs the user most/.test(section))
}

function testClientInitExamplesPassEveryRequiredField() {
  console.log('\nTest: every client initLogger example passes releaseId and logFunction')
  const clientInits = codeBlocks(capabilities)
    .filter((b) => b.lang === 'ts')
    .filter((b) => /initLogger[^\n]*from '@dasasian\/firebase-structured-logger\/client'/.test(b.code))
    .filter((b) => /initLogger(<\w+>)?\(/.test(b.code))
  assert('the file has client initLogger examples to check', clientInits.length >= 4, `found ${clientInits.length}`)
  for (const { code } of clientInits) {
    const call = code.slice(code.search(/initLogger(<\w+>)?\(/))
    assert(`passes releaseId: ${call.split('\n')[0]}`, /\breleaseId\b/.test(call))
    assert(`passes logFunction: ${call.split('\n')[0]}`, /\blogFunction\b/.test(call))
  }
}

function testLabelsTypeIsAnAliasAndExpressExampleMountsWithAppAll() {
  console.log('\nTest: the labels type is a type alias and Express mounts with app.all')
  const labels = sections.find((s) => s.title === 'User and labels')?.text ?? ''
  assert('the labels example is a type alias', labels.includes('type MyAppLabels ='))
  assert('and not an interface', !labels.includes('interface MyAppLabels'))
  const handler = sections.find((s) => s.title === 'withLogging and createHttpLogHandler')?.text ?? ''
  assert("the Express example mounts with app.all('/log'", handler.includes("app.all('/log', createHttpLogHandler("))
  assert("and never with app.post('/log'", !/^app\.post\('\/log'/m.test(handler))
}

const MISTAKES_LINE_FOR_DEPRECATED_NAME: Record<string, { section: string; pattern: string }> = {
  minLogLevel: { section: 'Error capture', pattern: 'minLogLevel:' },
  bucketName: { section: 'withLogging and createHttpLogHandler', pattern: 'bucketName:' },
  sessionLimit: { section: 'Error capture', pattern: 'sessionLimit:' },
  refillPerMinute: { section: 'Error capture', pattern: 'refillPerMinute:' },
  errorReserve: { section: 'Error capture', pattern: 'errorReserve:' },
  ClientLogRequest: { section: 'withLogging and createHttpLogHandler', pattern: 'ClientLogRequest' },
  triggerTestLog: { section: 'Error capture', pattern: 'triggerTestLog(' },
  routeFor: { section: 'Navigation', pattern: 'routeFor' },
  cleanPath: { section: 'Navigation', pattern: 'cleanPath' },
  'path: false': { section: 'Navigation', pattern: 'path: false' },
  routeSource: { section: 'Navigation', pattern: 'routeSource' },
  'bc.nav': { section: 'Breadcrumbs', pattern: 'bc.nav(' },
  'bc.error': { section: 'Breadcrumbs', pattern: 'bc.error(' },
  'Logger.setScreen': { section: 'Navigation', pattern: 'setScreen(' },
  '--functions': { section: 'Release ids and source maps', pattern: '--functions=' },
  FIREBASE_SERVICE_ACCOUNT_PATH: { section: 'Release ids and source maps', pattern: 'FIREBASE_SERVICE_ACCOUNT_PATH' },
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function warnedReplacement(warnedAs: string): string | undefined {
  const call = new RegExp(`warnDeprecated\\('${escapeForRegExp(warnedAs)}', '([^']+)'\\)`)
  for (const file of readTree(path.join(ROOT, 'src'))) {
    const match = call.exec(fs.readFileSync(file, 'utf-8'))
    if (match) return match[1]
  }
  return undefined
}

function replacementOf(entry: { warnedAs: string } | { replacement: string }): string | undefined {
  return 'replacement' in entry ? entry.replacement : warnedReplacement(entry.warnedAs)
}

function hasMistakesLine(section: string, pattern: string, replacement: string): boolean {
  return mistakesOf(new RegExp(`^${escapeForRegExp(section)}$`))
    .replace(/`/g, '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .some((line) => {
      const [shown, why = '', fix = ''] = line.slice(2).split(' → ')
      return shown.includes(pattern) && /deprecated, removed in 2\.0/.test(why) && fix.includes(replacement)
    })
}

function testEveryDeprecatedNameHasAMistakesLine() {
  console.log('\nTest: every deprecated name has a Mistakes line with its replacement')
  const listed = [...DEPRECATED_DECLARATIONS, ...DEPRECATED_CLI_FLAGS, ...DEPRECATED_ENVIRONMENT_VARIABLES]
  for (const entry of listed) {
    const where = MISTAKES_LINE_FOR_DEPRECATED_NAME[entry.name]
    assert(`${entry.name}: this test knows where its Mistakes line is`, where !== undefined)
    const replacement = replacementOf(entry)
    assert(`${entry.name}: the code names its replacement`, replacement !== undefined, 'no warnDeprecated call for it in src/')
    if (where === undefined || replacement === undefined) continue
    assert(
      `${entry.name}: ${where.section} has a Mistakes line "${where.pattern} → deprecated, removed in 2.0 → ${replacement}"`,
      hasMistakesLine(where.section, where.pattern, replacement),
    )
  }
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
testTheLoggerAddsTheErrorBreadcrumbAndTheTextsSayWhy()
testFixtureApps()
testReviewSkillShape()
testReviewSkillNamesNoCapability()
testNewPlacesAreInTheirSections()
testMarkedActionsSaysWhichToMarkFirst()
testClientInitExamplesPassEveryRequiredField()
testLabelsTypeIsAnAliasAndExpressExampleMountsWithAppAll()
testEveryDeprecatedNameHasAMistakesLine()
testPackaging()
reportResults()
