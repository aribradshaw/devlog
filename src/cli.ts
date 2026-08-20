#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  assertProductionDevLogReady,
  recordProductionDevLogRelease,
  type DevLogAutomationConfig,
} from './automation'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

async function readConfig(root: string): Promise<DevLogAutomationConfig> {
  const configPath = argument('--config') || 'devlog.config.json'
  const fullPath = path.resolve(root, configPath)
  try {
    return JSON.parse(await readFile(fullPath, 'utf8')) as DevLogAutomationConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`DevLog automation config not found: ${configPath}`)
    }
    throw error
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'prepare'
  const root = path.resolve(argument('--root') || process.cwd())
  const config = await readConfig(root)
  const context = {
    production: flag('--production') ? true : undefined,
    branch: argument('--branch') || undefined,
    commit: argument('--commit') || undefined,
    subject: argument('--subject') || undefined,
    body: argument('--body') || undefined,
    releasedAt: argument('--released-at') || undefined,
  }
  const result = command === 'check'
    ? await assertProductionDevLogReady({ root, config, context })
    : command === 'prepare'
      ? await recordProductionDevLogRelease({ root, config, context, dryRun: flag('--dry-run') })
      : (() => { throw new Error(`Unknown DevLog command: ${command}`) })()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
