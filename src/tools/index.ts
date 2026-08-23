#!/usr/bin/env node
import * as fs from 'fs'
import * as path from 'path'
import { uploadSourceMaps, EXIT_UPLOAD_FAILED_BUT_EMBEDDED } from './uploadSourceMaps'
import { installSkills } from './installSkills'

const [, , command, ...rawArgs] = process.argv

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) {
      result[match[1]] = match[2]
    } else if (arg.startsWith('--')) {
      result[arg.slice(2)] = 'true'
    }
  }
  return result
}

function loadEnvFile(filePath: string): void {
  const resolved = path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(resolved)) return
  for (const line of fs.readFileSync(resolved, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

async function main() {
  const args = parseArgs(rawArgs)

  // Auto-load .env.local from cwd if present
  loadEnvFile('.env.local')

  switch (command) {
    case 'upload-sourcemaps': {
      const bucket = args.bucket ?? process.env.VITE_FIREBASE_STORAGE_BUCKET ?? process.env.FIREBASE_STORAGE_BUCKET
      if (!bucket) {
        console.error('Usage: fsl upload-sourcemaps [--bucket=<name>] [--functions=<path>] [--embed-sourcemaps] [--release=<id>] [--dist=<path>]')
        console.error('Bucket can also be set via VITE_FIREBASE_STORAGE_BUCKET or FIREBASE_STORAGE_BUCKET env var (loaded from .env.local automatically).')
        process.exit(1)
      }
      const result = await uploadSourceMaps({
        bucket,
        release: args.release,
        distDir: args.dist,
        functionsDir: args.functions,
        embedSourcemaps: args['embed-sourcemaps'] === 'true',
      })
      // Distinct code so a deploy chain can choose to continue:
      //   npx fsl upload-sourcemaps … || [ $? -eq 3 ]
      if (!result.uploaded) process.exit(EXIT_UPLOAD_FAILED_BUT_EMBEDDED)
      break
    }

    case 'install-skills': {
      await installSkills({ global: args.global === 'true', force: args.force === 'true' })
      break
    }

    default: {
      console.log(`
firebase-structured-logger (fsl)

Commands:
  fsl upload-sourcemaps [--bucket=<name>] [--functions=<path>] [--embed-sourcemaps] [--release=<id>] [--dist=<path>]
      Upload .map files from dist/ to Cloud Storage and delete them locally.
      --bucket defaults to VITE_FIREBASE_STORAGE_BUCKET or FIREBASE_STORAGE_BUCKET (loaded from .env.local automatically).
      --functions path to Cloud Functions directory (e.g. ./functions or ./backend).
      --embed-sourcemaps copies maps to {functions}/sourcemaps/current/ for fast lookup of current release.
      Authenticates via FIREBASE_SERVICE_ACCOUNT_PATH if set, otherwise uses ADC.
      Release ID defaults to git rev-parse --short HEAD.

  fsl install-skills [--global] [--force]
      Copy skills/ to .claude/skills/ (project) or ~/.claude/skills/ (--global).
      Prompts before overwriting existing skills. Use --force to skip prompts.


`)
      if (command) {
        console.error(`Unknown command: ${command}`)
        process.exit(1)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
