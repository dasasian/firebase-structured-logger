import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'

const RETIRED_SKILLS = ['query-logs']

export interface InstallSkillsOptions {
  global?: boolean
  force?: boolean
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

async function removeRetiredSkills(targetDir: string, targetLabel: string, force: boolean): Promise<void> {
  for (const skillName of RETIRED_SKILLS) {
    const installed = path.join(targetDir, skillName)
    if (!fs.existsSync(installed)) continue
    const answer = force ? 'y' : await prompt(`  ${targetLabel}/${skillName} is no longer shipped by this package.\n  Remove it? [y/N] `)
    if (answer === 'y' || answer === 'yes') {
      fs.rmSync(installed, { recursive: true })
      console.log(`  - removed ${targetLabel}/${skillName}`)
    } else {
      console.log(`  - kept ${targetLabel}/${skillName}`)
    }
  }
}

export async function installSkills(options: InstallSkillsOptions = {}): Promise<void> {
  const { force = false } = options
  const packageSkillsDir = path.join(__dirname, '..', '..', 'skills')

  if (!fs.existsSync(packageSkillsDir)) {
    console.error('[fsl] Skills directory not found:', packageSkillsDir)
    process.exit(1)
  }

  const targetDir = options.global
    ? path.join(os.homedir(), '.claude', 'skills')
    : path.join(process.cwd(), '.claude', 'skills')

  const targetLabel = options.global ? '~/.claude/skills' : '.claude/skills'

  fs.mkdirSync(targetDir, { recursive: true })

  let count = 0
  for (const entry of fs.readdirSync(packageSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const skillName = entry.name
    const srcDir = path.join(packageSkillsDir, skillName)
    const destDir = path.join(targetDir, skillName)

    for (const file of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, file)
      const dest = path.join(destDir, file)

      if (fs.existsSync(dest) && !force) {
        const answer = await prompt(`  Skill already exists: ${targetLabel}/${skillName}/${file}\n  Overwrite? [y/N] `)
        if (answer !== 'y' && answer !== 'yes') {
          console.log(`  - skipped ${skillName}/${file}`)
          continue
        }
      }

      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(src, dest)
      console.log(`  ✓ ${targetLabel}/${skillName}/${file}`)
      count++
    }
  }

  await removeRetiredSkills(targetDir, targetLabel, force)

  console.log(`[fsl] Installed ${count} skill file(s) to ${targetLabel}/`)
}
