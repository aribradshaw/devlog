import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  getLatestDevLogRelease,
  nextCalendarVersion,
  validateDevLogEntry,
  validateDevLogEntries,
  type DevLogAuthor,
  type DevLogEntry,
} from './index'

export type DevLogAutomationConfig = {
  enabled?: boolean
  failClosed?: boolean
  productionBranches?: string[]
  ignoreCommitPrefixes?: string[]
  registryPath?: string
  manifestPaths?: string[]
  versionFilePaths?: string[]
  timeZone?: string
  baselineVersion?: string
  author?: DevLogAuthor
}

export type ResolvedDevLogAutomationConfig = {
  enabled: boolean
  failClosed: boolean
  productionBranches: string[]
  ignoreCommitPrefixes: string[]
  registryPath: string
  manifestPaths: string[]
  versionFilePaths: string[]
  timeZone: string
  baselineVersion: string
  author: DevLogAuthor | null
}

export type DevLogProductionContext = {
  production?: boolean
  branch?: string
  commit?: string
  subject?: string
  body?: string
  releasedAt?: string | Date
  author?: DevLogAuthor | null
}

export type DevLogAutomationResult = {
  status: 'disabled' | 'skipped' | 'reused' | 'created'
  version: string | null
  commit: string | null
  changedFiles: string[]
  release: DevLogEntry | null
}

const FULL_COMMIT_RE = /^[a-f0-9]{40}$/i
const DEFAULT_CONFIG: ResolvedDevLogAutomationConfig = {
  enabled: false,
  failClosed: true,
  productionBranches: ['main', 'master'],
  ignoreCommitPrefixes: ['chore(release):'],
  registryPath: 'config/devlog-releases.json',
  manifestPaths: ['package.json', 'package-lock.json'],
  versionFilePaths: [],
  timeZone: 'America/Phoenix',
  baselineVersion: '1.0.1',
  author: null,
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function booleanFromEnv(value: unknown): boolean | undefined {
  const normalized = cleanText(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

function uniqueStrings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const values = [...new Set(value.map(cleanText).filter(Boolean))]
  return values.length ? values : fallback
}

export function resolveDevLogAutomationConfig(
  config: DevLogAutomationConfig = {},
): ResolvedDevLogAutomationConfig {
  return {
    enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
    failClosed: config.failClosed ?? DEFAULT_CONFIG.failClosed,
    productionBranches: uniqueStrings(config.productionBranches, DEFAULT_CONFIG.productionBranches),
    ignoreCommitPrefixes: uniqueStrings(config.ignoreCommitPrefixes, DEFAULT_CONFIG.ignoreCommitPrefixes),
    registryPath: cleanText(config.registryPath) || DEFAULT_CONFIG.registryPath,
    manifestPaths: uniqueStrings(config.manifestPaths, DEFAULT_CONFIG.manifestPaths),
    versionFilePaths: Array.isArray(config.versionFilePaths)
      ? [...new Set(config.versionFilePaths.map(cleanText).filter(Boolean))]
      : DEFAULT_CONFIG.versionFilePaths,
    timeZone: cleanText(config.timeZone) || DEFAULT_CONFIG.timeZone,
    baselineVersion: cleanText(config.baselineVersion) || DEFAULT_CONFIG.baselineVersion,
    author: config.author?.name ? config.author : null,
  }
}

export function resolveDevLogProductionContext(
  context: DevLogProductionContext = {},
  env: NodeJS.ProcessEnv = process.env,
): Required<Omit<DevLogProductionContext, 'releasedAt' | 'author'>> & {
  releasedAt: string
  author: DevLogAuthor | null
} {
  const explicitProduction = context.production ?? booleanFromEnv(env.DEVLOG_PRODUCTION)
  const providerProduction = env.VERCEL_ENV === 'production'
    || env.RAILWAY_ENVIRONMENT_NAME === 'production'
    || env.NODE_ENV === 'production' && booleanFromEnv(env.CI) === true
  const releasedAt = context.releasedAt instanceof Date
    ? context.releasedAt.toISOString()
    : cleanText(context.releasedAt) || new Date().toISOString()
  const authorName = cleanText(env.DEVLOG_AUTHOR_NAME)
  const authorLogin = cleanText(env.DEVLOG_AUTHOR_LOGIN)
  const rawMessage = String(context.subject || env.DEVLOG_COMMIT_SUBJECT
    || env.VERCEL_GIT_COMMIT_MESSAGE || '')
  const [messageSubject = '', ...messageBody] = rawMessage.split(/\r?\n/)
  return {
    production: explicitProduction ?? providerProduction,
    branch: cleanText(context.branch) || cleanText(env.DEVLOG_BRANCH) || cleanText(env.GITHUB_REF_NAME),
    commit: (cleanText(context.commit) || cleanText(env.DEVLOG_COMMIT_SHA)
      || cleanText(env.GITHUB_SHA) || cleanText(env.VERCEL_GIT_COMMIT_SHA)
      || cleanText(env.RAILWAY_GIT_COMMIT_SHA)).toLowerCase(),
    subject: cleanText(messageSubject),
    body: cleanText(context.body) || cleanText(env.DEVLOG_COMMIT_BODY) || cleanText(messageBody.join('\n')),
    releasedAt,
    author: context.author ?? (authorName ? { name: authorName, githubLogin: authorLogin || null } : null),
  }
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relativePath)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`DevLog path must stay inside the project: ${relativePath}`)
  }
  return resolved
}

async function readJson(filePath: string): Promise<Record<string, unknown> | unknown[]> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown> | unknown[]
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.devlog-tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, filePath)
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.devlog-tmp`
  await writeFile(temporaryPath, value, 'utf8')
  await rename(temporaryPath, filePath)
}

function calendarDate(value: string, timeZone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid release timestamp: ${value}`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function releaseTitle(subject: string): string {
  const title = cleanText(subject)
    .replace(/^(?:feat|fix|chore|docs|refactor|test|build|ci|perf)(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/^merge (?:pull request|branch)\b[^:]*:?\s*/i, '')
  return title || 'Product update'
}

function releaseNotes(subject: string, body: string): { summary: string; notes: string[] } {
  const title = releaseTitle(subject)
  const details = String(body || '')
    .split(/\r?\n/)
    .map((line) => cleanText(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean)
    .slice(0, 3)
  const notes = details.length ? details : [title]
  const summary = details[0] || `Production now includes: ${title}.`
  return { summary, notes }
}

function gitValue(root: string, args: string[]): string {
  try {
    return String(execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim()
  } catch {
    return ''
  }
}

function completeContext(root: string, context: ReturnType<typeof resolveDevLogProductionContext>) {
  const message = gitValue(root, ['show', '-s', '--format=%s%n%n%b', context.commit || 'HEAD'])
  const [gitSubject = '', ...gitBody] = message.split(/\r?\n/)
  return {
    ...context,
    commit: context.commit || gitValue(root, ['rev-parse', 'HEAD']).toLowerCase(),
    branch: context.branch || gitValue(root, ['branch', '--show-current']),
    subject: context.subject || cleanText(gitSubject),
    body: context.body || cleanText(gitBody.join('\n')),
  }
}

function assertProductionContext(
  config: ResolvedDevLogAutomationConfig,
  context: ReturnType<typeof completeContext>,
): void {
  if (!FULL_COMMIT_RE.test(context.commit)) {
    throw new Error('Production DevLog automation requires a full 40-character commit SHA.')
  }
  if (!config.productionBranches.includes(context.branch)) {
    throw new Error(`Production DevLog automation is not allowed on branch ${context.branch || '(unknown)'}.`)
  }
}

function isIgnoredCommit(config: ResolvedDevLogAutomationConfig, subject: string): boolean {
  const normalized = cleanText(subject).toLowerCase()
  return config.ignoreCommitPrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()))
}

function updateDependencies(
  manifest: Record<string, unknown>,
  version: string,
  localPackageNames: Set<string>,
): boolean {
  let changed = false
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = manifest[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    const dependencyMap = dependencies as Record<string, unknown>
    for (const [name, current] of Object.entries(dependencyMap)) {
      if (!localPackageNames.has(name) || current === version) continue
      dependencyMap[name] = version
      changed = true
    }
  }
  return changed
}

function updateManifestVersion(
  manifest: Record<string, unknown>,
  version: string,
  localPackageNames: Set<string>,
): boolean {
  let changed = false
  if (manifest.version !== version) {
    manifest.version = version
    changed = true
  }
  if (updateDependencies(manifest, version, localPackageNames)) changed = true
  const packages = manifest.packages
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [packagePath, packageValue] of Object.entries(packages as Record<string, unknown>)) {
      if (packagePath.startsWith('node_modules/') || !packageValue
        || typeof packageValue !== 'object' || Array.isArray(packageValue)) continue
      const localPackage = packageValue as Record<string, unknown>
      if (localPackage.version !== version) {
        localPackage.version = version
        changed = true
      }
      if (updateDependencies(localPackage, version, localPackageNames)) changed = true
    }
  }
  return changed
}

export async function recordProductionDevLogRelease(options: {
  root?: string
  config?: DevLogAutomationConfig
  context?: DevLogProductionContext
  env?: NodeJS.ProcessEnv
  dryRun?: boolean
} = {}): Promise<DevLogAutomationResult> {
  const root = path.resolve(options.root || process.cwd())
  const config = resolveDevLogAutomationConfig(options.config)
  if (!config.enabled) {
    return { status: 'disabled', version: null, commit: null, changedFiles: [], release: null }
  }

  const context = completeContext(root, resolveDevLogProductionContext(options.context, options.env))
  if (!context.production) {
    return { status: 'skipped', version: null, commit: context.commit || null, changedFiles: [], release: null }
  }
  assertProductionContext(config, context)
  if (isIgnoredCommit(config, context.subject)) {
    return { status: 'skipped', version: null, commit: context.commit, changedFiles: [], release: null }
  }

  const registryFile = resolveInside(root, config.registryPath)
  const rawEntries = await readJson(registryFile)
  const entries = validateDevLogEntries(rawEntries)
  if (!entries) throw new Error(`Invalid DevLog registry: ${config.registryPath}`)
  const existing = entries.find((entry) => entry.commit === context.commit)
  if (existing) {
    return { status: 'reused', version: existing.version, commit: context.commit, changedFiles: [], release: existing }
  }

  const latest = getLatestDevLogRelease(entries)
  const version = latest
    ? nextCalendarVersion(latest.version, {
      latestReleaseDate: latest.releasedAt || latest.date,
      releaseAt: context.releasedAt,
      timeZone: config.timeZone,
    })
    : config.baselineVersion
  const copy = releaseNotes(context.subject, context.body)
  const releaseCandidate: DevLogEntry = {
    version,
    date: calendarDate(context.releasedAt, config.timeZone),
    releasedAt: new Date(context.releasedAt).toISOString(),
    commit: context.commit,
    sourceSubject: context.subject || releaseTitle(context.subject),
    title: releaseTitle(context.subject),
    summary: copy.summary,
    notes: copy.notes,
    author: context.author || config.author,
  }
  const release = validateDevLogEntry(releaseCandidate, {
    rejectAuthorEmail: true,
    rejectTicketTitle: true,
  })
  if (!release) throw new Error('Generated production DevLog entry is invalid.')

  const changedFiles = [config.registryPath]
  const manifestWrites: Array<{ file: string; relative: string; value: Record<string, unknown> }> = []
  for (const relative of config.manifestPaths) {
    const file = resolveInside(root, relative)
    const manifest = await readJson(file)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`DevLog manifest must be a JSON object: ${relative}`)
    }
    manifestWrites.push({ file, relative, value: manifest })
  }
  const localPackageNames = new Set(manifestWrites
    .map((manifest) => cleanText(manifest.value.name))
    .filter(Boolean))
  for (const manifest of manifestWrites) {
    if (updateManifestVersion(manifest.value, version, localPackageNames)) changedFiles.push(manifest.relative)
  }
  const versionFileWrites: Array<{ file: string; relative: string; value: string }> = []
  for (const relative of config.versionFilePaths) {
    const file = resolveInside(root, relative)
    const current = await readFile(file, 'utf8')
    if (latest && !current.includes(latest.version)) {
      throw new Error(`Version file ${relative} does not contain current version ${latest.version}.`)
    }
    const value = latest ? current.split(latest.version).join(version) : current
    if (value !== current) changedFiles.push(relative)
    versionFileWrites.push({ file, relative, value })
  }

  if (!options.dryRun) {
    await writeJsonAtomic(registryFile, [release, ...entries])
    for (const manifest of manifestWrites) await writeJsonAtomic(manifest.file, manifest.value)
    for (const versionFile of versionFileWrites) await writeTextAtomic(versionFile.file, versionFile.value)
  }
  return { status: 'created', version, commit: context.commit, changedFiles, release }
}

export async function assertProductionDevLogReady(options: {
  root?: string
  config?: DevLogAutomationConfig
  context?: DevLogProductionContext
  env?: NodeJS.ProcessEnv
} = {}): Promise<DevLogAutomationResult> {
  const root = path.resolve(options.root || process.cwd())
  const config = resolveDevLogAutomationConfig(options.config)
  if (!config.enabled) {
    return { status: 'disabled', version: null, commit: null, changedFiles: [], release: null }
  }
  const context = completeContext(root, resolveDevLogProductionContext(options.context, options.env))
  if (!context.production) {
    return { status: 'skipped', version: null, commit: context.commit || null, changedFiles: [], release: null }
  }
  assertProductionContext(config, context)
  if (isIgnoredCommit(config, context.subject)) {
    return { status: 'skipped', version: null, commit: context.commit, changedFiles: [], release: null }
  }

  const entries = validateDevLogEntries(await readJson(resolveInside(root, config.registryPath)))
  if (!entries) throw new Error(`Invalid DevLog registry: ${config.registryPath}`)
  const release = entries.find((entry) => entry.commit === context.commit) || null
  const latest = getLatestDevLogRelease(entries)
  const manifest = await readJson(resolveInside(root, config.manifestPaths[0]))
  const version = manifest && !Array.isArray(manifest) ? cleanText(manifest.version) : ''
  if (!release || release.version !== version || latest?.version !== version) {
    const message = `Production commit ${context.commit.slice(0, 7)} is not aligned with the latest DevLog and manifest version.`
    if (config.failClosed) throw new Error(message)
    return { status: 'skipped', version: version || null, commit: context.commit, changedFiles: [], release }
  }
  for (const relative of config.versionFilePaths) {
    const value = await readFile(resolveInside(root, relative), 'utf8')
    if (!value.includes(version)) {
      const message = `Production version file ${relative} does not contain ${version}.`
      if (config.failClosed) throw new Error(message)
      return { status: 'skipped', version, commit: context.commit, changedFiles: [], release }
    }
  }
  return { status: 'reused', version, commit: context.commit, changedFiles: [], release }
}
