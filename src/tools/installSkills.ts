import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'

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

export async function installSkills(options: InstallSkillsOptions = {}): Promise<void> {
  const { force = false } = options
  // Skills directory in this package
  const packageSkillsDir = path.join(__dirname, '..', '..', 'skills')

  if (!fs.existsSync(packageSkillsDir)) {
    console.error('[fsl] Skills directory not found:', packageSkillsDir)
    process.exit(1)
  }

  // Target: project-level by default, global with --global flag
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

  console.log(`[fsl] Installed ${count} skill file(s) to ${targetLabel}/`)
}
