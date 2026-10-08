import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'

const RETIRED_SKILLS = ['query-logs']

export interface InstallSkillsOptions {
  global?: boolean
  force?: boolean
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

function skillsTarget(global: boolean | undefined): SkillsTarget {
  return global
    ? { dir: path.join(os.homedir(), '.claude', 'skills'), label: '~/.claude/skills' }
    : { dir: path.join(process.cwd(), '.claude', 'skills'), label: '.claude/skills' }
}

async function removeRetiredSkills(target: SkillsTarget, force: boolean): Promise<void> {
  for (const skillName of RETIRED_SKILLS) {
    const installed = path.join(target.dir, skillName)
    if (!fs.existsSync(installed)) continue
    const answer = force ? 'y' : await prompt(`  ${target.label}/${skillName} is no longer shipped by this package.\n  Remove it? [y/N] `)
    if (isYes(answer)) {
      fs.rmSync(installed, { recursive: true })
      console.log(`  - removed ${target.label}/${skillName}`)
    } else {
      console.log(`  - kept ${target.label}/${skillName}`)
    }
  }
}

async function copySkill(srcDir: string, target: SkillsTarget, skillName: string, force: boolean): Promise<number> {
  const destDir = path.join(target.dir, skillName)
  let copied = 0
  for (const file of fs.readdirSync(srcDir)) {
    const dest = path.join(destDir, file)

    if (fs.existsSync(dest) && !force) {
      const answer = await prompt(`  Skill already exists: ${target.label}/${skillName}/${file}\n  Overwrite? [y/N] `)
      if (!isYes(answer)) {
        console.log(`  - skipped ${skillName}/${file}`)
        continue
      }
    }

    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(path.join(srcDir, file), dest)
    console.log(`  ✓ ${target.label}/${skillName}/${file}`)
    copied++
  }
  return copied
}

/** Copies the package's skills into `.claude/skills/` (or the global one), asking before it overwrites or removes anything unless `force` is set. */
export async function installSkills(options: InstallSkillsOptions = {}): Promise<void> {
  const force = options.force ?? false
  const packageSkillsDir = path.join(__dirname, '..', '..', 'skills')

  if (!fs.existsSync(packageSkillsDir)) {
    console.error('[fsl] Skills directory not found:', packageSkillsDir)
    process.exit(1)
  }

  const target = skillsTarget(options.global)
  fs.mkdirSync(target.dir, { recursive: true })

  let count = 0
  for (const entry of fs.readdirSync(packageSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    count += await copySkill(path.join(packageSkillsDir, entry.name), target, entry.name, force)
  }

  await removeRetiredSkills(target, force)

  console.log(`[fsl] Installed ${count} skill file(s) to ${target.label}/`)
}
