import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { readPackageJson } from '../shared/nodeModules.js'

const RETIRED_SKILLS = ['logs', 'query-logs']
const VERSION_PLACEHOLDER = /^fsl-version: <version>$/m
const SKILL_FILE = 'SKILL.md'

export interface InstallSkillsOptions {
  global?: boolean
  force?: boolean
  /** Answers a yes/no question; defaults to reading the terminal. Tests pass a stub. */
  ask?: (question: string) => Promise<string>
  /** Whether a person can answer; defaults to whether stdin is a terminal. Ignored when `ask` is given. */
  isTTY?: boolean
}

type Ask = (question: string) => Promise<string>

interface Declined {
  what: string
  forceDoes: string
}

interface SkillsTarget {
  dir: string
  label: string
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

function isYes(answer: string): boolean {
  return answer === 'y' || answer === 'yes'
}

function ownVersion(packageRoot: string): string {
  const read = readPackageJson(packageRoot)
  if (!read.ok || typeof read.pkg.version !== 'string') throw new Error(`fsl install-skills could not read the version from ${packageRoot}/package.json`)
  return read.pkg.version
}

function skillsTarget(global: boolean | undefined): SkillsTarget {
  return global
    ? { dir: path.join(os.homedir(), '.claude', 'skills'), label: '~/.claude/skills' }
    : { dir: path.join(process.cwd(), '.claude', 'skills'), label: '.claude/skills' }
}

async function removeRetiredSkills(target: SkillsTarget, force: boolean, ask: Ask | null, declined: Declined[]): Promise<void> {
  for (const skillName of RETIRED_SKILLS) {
    const installed = path.join(target.dir, skillName)
    if (!fs.existsSync(installed)) continue
    if (!force && !ask) {
      declined.push({ what: `${target.label}/${skillName} was not removed`, forceDoes: `remove ${target.label}/${skillName}` })
      continue
    }
    const answer = force ? 'y' : await ask!(`  Remove ${target.label}/${skillName}, which fsl no longer ships? [y/N] `)
    if (isYes(answer)) {
      fs.rmSync(installed, { recursive: true })
      console.log(`  - removed ${target.label}/${skillName}`)
    } else {
      console.log(`  - kept ${target.label}/${skillName}`)
    }
  }
}

async function copySkill(srcDir: string, target: SkillsTarget, skillName: string, version: string, force: boolean, ask: Ask | null, declined: Declined[]): Promise<number> {
  const destDir = path.join(target.dir, skillName)
  let copied = 0
  for (const file of fs.readdirSync(srcDir)) {
    const dest = path.join(destDir, file)

    if (fs.existsSync(dest) && !force) {
      if (!ask) {
        declined.push({ what: `${target.label}/${skillName}/${file} was not overwritten`, forceDoes: `overwrite ${target.label}/${skillName}/${file}` })
        continue
      }
      const answer = await ask(`  Skill already exists: ${target.label}/${skillName}/${file}\n  Overwrite? [y/N] `)
      if (!isYes(answer)) {
        console.log(`  - skipped ${skillName}/${file}`)
        continue
      }
    }

    fs.mkdirSync(destDir, { recursive: true })
    if (file === SKILL_FILE) {
      fs.writeFileSync(dest, fs.readFileSync(path.join(srcDir, file), 'utf-8').replace(VERSION_PLACEHOLDER, `fsl-version: ${version}`))
    } else {
      fs.copyFileSync(path.join(srcDir, file), dest)
    }
    console.log(`  ✓ ${target.label}/${skillName}/${file}`)
    copied++
  }
  return copied
}

/**
 * Copies the package's skills into `.claude/skills/` (or the global one) and writes this
 * package's version into each skill's `fsl-version`. Asks before it overwrites a file or
 * removes a skill the package used to ship; `force` answers yes. With nobody to ask and no
 * `force` it asks nothing, does what needs no answer, names on stderr what it left undone,
 * and returns 1. Touches no other folder.
 *
 * @returns the process exit code
 */
export async function installSkills(options: InstallSkillsOptions = {}): Promise<number> {
  const force = options.force ?? false
  const ask = options.ask ?? ((options.isTTY ?? process.stdin.isTTY) ? prompt : null)
  const declined: Declined[] = []
  const packageRoot = path.join(__dirname, '..', '..')
  const packageSkillsDir = path.join(packageRoot, 'skills')

  if (!fs.existsSync(packageSkillsDir)) {
    console.error('[fsl] Skills directory not found:', packageSkillsDir)
    process.exit(1)
  }

  const version = ownVersion(packageRoot)
  const target = skillsTarget(options.global)
  fs.mkdirSync(target.dir, { recursive: true })

  let count = 0
  for (const entry of fs.readdirSync(packageSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    count += await copySkill(path.join(packageSkillsDir, entry.name), target, entry.name, version, force, ask, declined)
  }

  await removeRetiredSkills(target, force, ask, declined)

  console.log(`[fsl] Installed ${count} skill file(s) to ${target.label}/`)
  for (const item of declined) console.error(`[fsl] ${item.what}. Run fsl install-skills --force to ${item.forceDoes}.`)
  return declined.length > 0 ? 1 : 0
}
