import { execFile } from 'node:child_process'

import {
  compareDevLogVersions,
  nextBradshawVersion,
  validateDevLogEntry,
  type BradshawVersionScheme,
  type DevLogAuthor,
  type DevLogCompatibility,
  type DevLogDeployment,
  type DevLogEntry,
  type DevLogIncludedCommit,
} from './index'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A normalized source commit, as returned by every commit range source. */
export type DevLogCommit = {
  sha: string
  subject: string
  body: string
  authorName: string
  authorLogin?: string | null
  committedAt: string | null
}

/** A release recorded at deploy time. Always a valid `DevLogEntry`. */
export type DevLogDeployRelease = DevLogEntry & {
  commit: string
  releasedAt: string
  includedCommits: DevLogIncludedCommit[]
  compatibility: DevLogCompatibility
  action: string | null
  deployment: DevLogDeployment | null
}

/** The fields of the newest release that version selection and range detection need. */
export type DevLogReleaseHead = {
  version: string
  commitSha: string | null
  releasedAt: string | null
}

export type DevLogReleaseInsertResult = 'inserted' | 'version-conflict' | 'commit-conflict'

/**
 * Durable release registry. Implementations must enforce uniqueness of both `version` and
 * `commit` so that two concurrent recorders cannot both succeed.
 */
export interface DevLogReleaseStore {
  findByCommit(commitSha: string): Promise<DevLogDeployRelease | null>
  /** Newest release by numeric version order, or null when the store is empty. */
  latest(): Promise<DevLogReleaseHead | null>
  /** Inserts atomically. A commit conflict takes precedence over a version conflict. */
  insert(release: DevLogDeployRelease): Promise<DevLogReleaseInsertResult>
  /** Releases newest first. */
  list(options?: { limit?: number }): Promise<DevLogDeployRelease[]>
}

export type DevLogCommitRange = { from: string | null; to: string }
export type DevLogCommitSource = (range: DevLogCommitRange) => Promise<DevLogCommit[]>

export type DevLogReleaseNotes = {
  title: string
  summary: string
  notes: string[]
  compatibility: DevLogCompatibility
  action: string | null
  maintenance: boolean
}

export type DevLogNotesGenerator = (input: {
  commits: DevLogCommit[]
  defaults: DevLogReleaseNotes
}) => Promise<{ title?: string; summary?: string; notes?: string[] } | null | undefined>

export type RecordDeployReleaseOptions = {
  store: DevLogReleaseStore
  commitSha: string
  /** Commits in this deploy, oldest first. Takes precedence over `commitSource`. */
  commits?: DevLogCommit[]
  /** Called with `{ from: previous deploy SHA | null, to: commitSha }`. */
  commitSource?: DevLogCommitSource
  /** Used as the single commit when no range can be read (for example from deploy env vars). */
  headCommit?: Partial<Omit<DevLogCommit, 'sha'>>
  releasedAt?: string | Date
  scheme: BradshawVersionScheme
  /** Used only while the store is empty. `commitSha` is the range start for the first deploy. */
  baseline?: { version: string; commitSha?: string | null } | null
  /** Overrides the head commit author on the release. */
  author?: DevLogAuthor | null
  deployment?: Partial<DevLogDeployment> | null
  generateNotes?: DevLogNotesGenerator
  /** Milliseconds before `generateNotes` is abandoned in favor of the default notes. */
  generateNotesTimeoutMs?: number
  ignoreCommitPrefixes?: string[]
  /** Bounded retries when another recorder wins the same version. */
  maxAttempts?: number
  /** Called with non-fatal problems such as a failed commit source or notes hook. */
  onWarning?: (message: string, error?: unknown) => void
}

export type RecordDeployReleaseResult = {
  status: 'recorded' | 'existing'
  release: DevLogDeployRelease
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FULL_COMMIT_RE = /^[a-f0-9]{40}$/i
const SHA_RE = /^[a-f0-9]{7,40}$/i
const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/
const MAINTENANCE_SUBJECT_RE = /^(?:chore:\s*)?(?:bump|update)\s+(?:the\s+)?(?:production\s+)?version\b/i
const MERGE_SUBJECT_RE = /^merge (?:branch|remote-tracking branch|pull request)\b/i
const CONVENTIONAL_PREFIX_RE = /^(?:feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(?:\([^)]*\))?!?:\s*/i
const TRAILER_RE = /^(DevLog-(?:Note|Compat|Action)):\s*(.*)$/i
const COMPATIBILITY_RANK: Record<DevLogCompatibility, number> = {
  compatible: 0,
  'action-required': 1,
  breaking: 2,
}

export const DEFAULT_DEPLOY_IGNORE_PREFIXES = ['chore(release):', 'DevLog:']
export const DEFAULT_COMMIT_RANGE_LIMIT = 250
export const MAINTENANCE_RELEASE_TITLE = 'Maintenance release'
export const MAINTENANCE_RELEASE_NOTE =
  'Completed internal release maintenance with no user-facing workflow change recorded.'

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function toIso(value: unknown): string | null {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function normalizeCommit(raw: Partial<DevLogCommit> & { sha: string }): DevLogCommit {
  const login = cleanText(raw.authorLogin)
  return {
    sha: cleanText(raw.sha).toLowerCase(),
    subject: cleanText(raw.subject),
    body: String(raw.body ?? '').replace(/\r\n/g, '\n').trim(),
    authorName: cleanText(raw.authorName),
    authorLogin: GITHUB_LOGIN_RE.test(login) ? login : null,
    committedAt: toIso(raw.committedAt),
  }
}

function capNewest<T>(commits: T[], limit: number): T[] {
  return commits.length > limit ? commits.slice(commits.length - limit) : commits
}

function calendarDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

// ---------------------------------------------------------------------------
// Commit range sources
// ---------------------------------------------------------------------------

function runGit(cwd: string | undefined, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || '') })
    })
  })
}

const GIT_LOG_FORMAT = '%H%x1f%s%x1f%an%x1f%cI%x1f%b%x1e'

function parseGitLog(raw: string): DevLogCommit[] {
  return raw.split('\x1e').map((record) => record.replace(/^\s+/, '')).filter(Boolean).flatMap((record) => {
    const [sha = '', subject = '', authorName = '', committedAt = '', body = ''] = record.split('\x1f')
    if (!FULL_COMMIT_RE.test(sha.trim())) return []
    return [normalizeCommit({ sha, subject, authorName, committedAt, body })]
  })
}

/**
 * Reads `from..to` (first-parent) from a local git checkout, oldest first, keeping the newest
 * `limit` commits. Falls back to the `to` commit alone when `from` is missing, unknown, or not an
 * ancestor of `to`.
 */
export async function gitCommitRange(options: {
  from?: string | null
  to: string
  cwd?: string
  limit?: number
}): Promise<DevLogCommit[]> {
  const to = cleanText(options.to)
  if (!to) throw new Error('gitCommitRange requires a `to` commit.')
  const limit = clampLimit(options.limit, DEFAULT_COMMIT_RANGE_LIMIT, 10_000)
  const from = cleanText(options.from)
  if (from && from.toLowerCase() !== to.toLowerCase()) {
    const ancestor = await runGit(options.cwd, ['merge-base', '--is-ancestor', from, to])
    if (ancestor.ok) {
      const range = await runGit(options.cwd, [
        'log', '--first-parent', `--max-count=${limit}`, `--format=${GIT_LOG_FORMAT}`, `${from}..${to}`, '--',
      ])
      const commits = range.ok ? parseGitLog(range.stdout).reverse() : []
      if (commits.length) return commits
    }
  }
  const head = await runGit(options.cwd, ['log', '-1', `--format=${GIT_LOG_FORMAT}`, to, '--'])
  if (!head.ok) throw new Error(`git could not read commit ${to}.`)
  return parseGitLog(head.stdout)
}

type GitHubCommitPayload = {
  sha?: string
  parents?: Array<{ sha?: string }>
  author?: { login?: string } | null
  commit?: {
    message?: string
    author?: { name?: string; date?: string } | null
    committer?: { date?: string } | null
  }
}

function fromGitHubCommit(payload: GitHubCommitPayload): DevLogCommit | null {
  const sha = cleanText(payload.sha).toLowerCase()
  if (!FULL_COMMIT_RE.test(sha)) return null
  const message = String(payload.commit?.message ?? '').replace(/\r\n/g, '\n')
  const [subject = '', ...body] = message.split('\n')
  return normalizeCommit({
    sha,
    subject,
    body: body.join('\n'),
    authorName: payload.commit?.author?.name || payload.author?.login || '',
    authorLogin: payload.author?.login ?? null,
    committedAt: payload.commit?.committer?.date || payload.commit?.author?.date || null,
  })
}

function firstParentChain(commits: GitHubCommitPayload[], head: string): GitHubCommitPayload[] {
  const bySha = new Map(commits.map((commit) => [cleanText(commit.sha).toLowerCase(), commit]))
  const chain: GitHubCommitPayload[] = []
  let cursor = bySha.get(head)
  while (cursor) {
    chain.push(cursor)
    cursor = bySha.get(cleanText(cursor.parents?.[0]?.sha).toLowerCase())
  }
  return chain.reverse()
}

/**
 * Reads `from...to` through the GitHub compare API, following the first-parent chain from `to`,
 * oldest first. Works unauthenticated for public repositories. Falls back to the `to` commit alone
 * when `from` is missing, unknown, or not an ancestor of `to`.
 */
export async function githubCommitRange(options: {
  owner: string
  repo: string
  from?: string | null
  to: string
  token?: string | null
  fetch?: typeof fetch
  apiUrl?: string
  limit?: number
}): Promise<DevLogCommit[]> {
  const owner = cleanText(options.owner)
  const repo = cleanText(options.repo)
  const to = cleanText(options.to).toLowerCase()
  if (!owner || !repo || !to) throw new Error('githubCommitRange requires owner, repo, and a `to` commit.')
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('githubCommitRange requires a fetch implementation.')
  const limit = clampLimit(options.limit, DEFAULT_COMMIT_RANGE_LIMIT, DEFAULT_COMMIT_RANGE_LIMIT)
  const base = `${(cleanText(options.apiUrl) || 'https://api.github.com').replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '@aribradshaw/devlog',
  }
  const token = cleanText(options.token)
  if (token) headers.Authorization = `Bearer ${token}`

  const from = cleanText(options.from).toLowerCase()
  if (from && from !== to && SHA_RE.test(from)) {
    try {
      const response = await fetcher(`${base}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}?per_page=${limit}`, { headers })
      if (response.ok) {
        const data = await response.json() as { status?: string; commits?: GitHubCommitPayload[] }
        if (data.status === 'ahead' && Array.isArray(data.commits) && data.commits.length) {
          const commits = firstParentChain(data.commits, to)
            .map(fromGitHubCommit)
            .filter((commit): commit is DevLogCommit => Boolean(commit))
          if (commits.length) return capNewest(commits, limit)
        }
      }
    } catch {
      // Fall back to the head commit below.
    }
  }

  const response = await fetcher(`${base}/commits/${encodeURIComponent(to)}`, { headers })
  if (!response.ok) throw new Error(`GitHub commit lookup for ${to} failed with HTTP ${response.status}.`)
  const commit = fromGitHubCommit(await response.json() as GitHubCommitPayload)
  if (!commit) throw new Error(`GitHub returned an invalid commit for ${to}.`)
  return [commit]
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export type DevLogCommitTrailers = {
  notes: string[]
  compatibility: DevLogCompatibility | null
  actions: string[]
  body: string
}

/** Extracts `DevLog-Note`, `DevLog-Compat`, and `DevLog-Action` trailers from a commit body. */
export function parseDevLogTrailers(body: string): DevLogCommitTrailers {
  const notes: string[] = []
  const actions: string[] = []
  let compatibility: DevLogCompatibility | null = null
  const remaining: string[] = []
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = TRAILER_RE.exec(line.trim())
    if (!match) {
      remaining.push(line)
      continue
    }
    const key = match[1]!.toLowerCase()
    const value = cleanText(match[2])
    if (!value) continue
    if (key === 'devlog-note') notes.push(value)
    else if (key === 'devlog-action') actions.push(value)
    else {
      const normalized = value.toLowerCase().replace(/[\s_]+/g, '-') as DevLogCompatibility
      if (normalized in COMPATIBILITY_RANK
        && (!compatibility || COMPATIBILITY_RANK[normalized] > COMPATIBILITY_RANK[compatibility])) {
        compatibility = normalized
      }
    }
  }
  return { notes, compatibility, actions, body: remaining.join('\n').trim() }
}

/** Ported from Othello: version bumps and empty merge commits carry no user-facing change. */
export function isMaintenanceOnlySource(source: { subject?: string | null; body?: string | null }): boolean {
  const subject = cleanText(source?.subject)
  const body = cleanText(parseDevLogTrailers(String(source?.body ?? '')).body)
  return MAINTENANCE_SUBJECT_RE.test(subject) || (MERGE_SUBJECT_RE.test(subject) && !body)
}

export function createMaintenanceReleaseNotes(): DevLogReleaseNotes {
  return {
    title: MAINTENANCE_RELEASE_TITLE,
    summary: MAINTENANCE_RELEASE_NOTE,
    notes: [MAINTENANCE_RELEASE_NOTE],
    compatibility: 'compatible',
    action: null,
    maintenance: true,
  }
}

function isIgnoredSubject(subject: string, prefixes: string[]): boolean {
  const normalized = cleanText(subject).toLowerCase()
  return prefixes.some((prefix) => prefix && normalized.startsWith(prefix.toLowerCase()))
}

/** Human title for one commit: strips conventional-commit prefixes and uses a merge's PR title. */
export function commitTitle(commit: Pick<DevLogCommit, 'subject' | 'body'>): string {
  const subject = cleanText(commit.subject)
  if (MERGE_SUBJECT_RE.test(subject)) {
    const firstBodyLine = parseDevLogTrailers(commit.body).body.split('\n').map(cleanText).find(Boolean)
    if (firstBodyLine) return cleanText(firstBodyLine.replace(CONVENTIONAL_PREFIX_RE, '')) || firstBodyLine
  }
  return cleanText(subject.replace(CONVENTIONAL_PREFIX_RE, '')) || subject || 'Product update'
}

/**
 * Default release copy for one deploy. Commits whose subject starts with an ignored prefix are
 * skipped; `DevLog-Note` trailers replace a commit's subject-derived note; the highest
 * `DevLog-Compat` wins; `DevLog-Action` values are joined. All-maintenance deploys get the standard
 * maintenance note.
 */
export function buildDefaultReleaseNotes(
  commits: DevLogCommit[],
  options: { ignoreCommitPrefixes?: string[]; maxNotes?: number } = {},
): DevLogReleaseNotes {
  const prefixes = options.ignoreCommitPrefixes ?? DEFAULT_DEPLOY_IGNORE_PREFIXES
  const maxNotes = clampLimit(options.maxNotes, 20, 100)
  const relevant = commits.filter((commit) => !isIgnoredSubject(commit.subject, prefixes))
  let compatibility: DevLogCompatibility = 'compatible'
  const actions: string[] = []
  const titles: string[] = []
  const notes: string[] = []
  for (const commit of relevant) {
    const trailers = parseDevLogTrailers(commit.body)
    if (trailers.compatibility && COMPATIBILITY_RANK[trailers.compatibility] > COMPATIBILITY_RANK[compatibility]) {
      compatibility = trailers.compatibility
    }
    actions.push(...trailers.actions)
    if (isMaintenanceOnlySource(commit) && !trailers.notes.length) continue
    const title = commitTitle(commit)
    titles.push(title)
    notes.push(...(trailers.notes.length ? trailers.notes : [title]))
  }
  const action = [...new Set(actions)].join(' ') || null
  if (!titles.length) {
    return { ...createMaintenanceReleaseNotes(), compatibility, action }
  }
  const uniqueNotes = [...new Set(notes)]
  const visibleNotes = uniqueNotes.slice(0, maxNotes)
  if (uniqueNotes.length > maxNotes) {
    const hidden = uniqueNotes.length - maxNotes
    visibleNotes.push(`Plus ${hidden} more ${hidden === 1 ? 'change' : 'changes'}.`)
  }
  const headTitle = titles[titles.length - 1]!
  const others = titles.length - 1
  return {
    title: others ? `${headTitle} and ${others} more ${others === 1 ? 'update' : 'updates'}` : headTitle,
    summary: others
      ? `Production now includes ${titles.length} updates.`
      : `Production now includes: ${headTitle}.`,
    notes: visibleNotes,
    compatibility,
    action,
    maintenance: false,
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

function resolveAuthor(override: DevLogAuthor | null | undefined, head: DevLogCommit | undefined): DevLogAuthor | null {
  if (override?.name) return override
  const name = cleanText(head?.authorName)
  const login = cleanText(head?.authorLogin)
  if (name && !EMAIL_RE.test(name)) return { name, githubLogin: login || null }
  if (login) return { name: login, githubLogin: login }
  return null
}

/**
 * Records one DevLog release for one production deploy. Idempotent per commit SHA; safe to call
 * from every replica at server start. Nothing is written to git.
 */
export async function recordDeployRelease(options: RecordDeployReleaseOptions): Promise<RecordDeployReleaseResult> {
  const { store } = options
  const commitSha = cleanText(options.commitSha).toLowerCase()
  if (!FULL_COMMIT_RE.test(commitSha)) {
    throw new Error('recordDeployRelease requires a full 40-character commit SHA.')
  }
  const warn = (message: string, error?: unknown) => options.onWarning?.(message, error)

  const existing = await store.findByCommit(commitSha)
  if (existing) return { status: 'existing', release: existing }

  const releasedAtDate = options.releasedAt instanceof Date
    ? options.releasedAt
    : new Date(options.releasedAt ?? Date.now())
  if (Number.isNaN(releasedAtDate.getTime())) throw new Error(`Invalid releasedAt: ${String(options.releasedAt)}`)
  const releasedAt = releasedAtDate.toISOString()
  const date = calendarDate(releasedAtDate, options.scheme.timeZone)

  const initialLatest = await store.latest()
  const baselineVersion = cleanText(options.baseline?.version) || null
  const previousSha = cleanText(initialLatest ? initialLatest.commitSha : options.baseline?.commitSha).toLowerCase() || null

  const fallbackCommit = normalizeCommit({
    sha: commitSha,
    subject: cleanText(options.headCommit?.subject) || 'Production deploy',
    body: options.headCommit?.body ?? '',
    authorName: options.headCommit?.authorName ?? '',
    authorLogin: options.headCommit?.authorLogin ?? null,
    committedAt: options.headCommit?.committedAt ?? null,
  })
  let commits: DevLogCommit[] = []
  if (options.commits) {
    commits = options.commits.map(normalizeCommit)
  } else if (options.commitSource) {
    try {
      commits = (await options.commitSource({ from: previousSha === commitSha ? null : previousSha, to: commitSha }))
        .map(normalizeCommit)
    } catch (error) {
      warn('DevLog commit source failed; recording the head commit only.', error)
    }
  }
  commits = commits.filter((commit) => FULL_COMMIT_RE.test(commit.sha) && commit.subject)
  commits = capNewest(commits, DEFAULT_COMMIT_RANGE_LIMIT)
  if (!commits.some((commit) => commit.sha === commitSha)) {
    commits.push(fallbackCommit)
  }

  const ignoreCommitPrefixes = options.ignoreCommitPrefixes ?? DEFAULT_DEPLOY_IGNORE_PREFIXES
  const defaults = buildDefaultReleaseNotes(commits, { ignoreCommitPrefixes })
  let copy: Pick<DevLogReleaseNotes, 'title' | 'summary' | 'notes'> = defaults
  if (options.generateNotes && !defaults.maintenance) {
    try {
      const generated = await withTimeout(
        Promise.resolve(options.generateNotes({ commits, defaults })),
        options.generateNotesTimeoutMs ?? 15_000,
      )
      const title = cleanText(generated?.title)
      const notes = Array.isArray(generated?.notes) ? generated.notes.map(cleanText).filter(Boolean) : []
      if (generated && title && notes.length) {
        copy = { title, notes, summary: cleanText(generated.summary) || notes[0]! }
      } else if (generated) {
        warn('DevLog notes hook returned no usable title and notes; using default notes.')
      }
    } catch (error) {
      warn('DevLog notes hook failed; using default notes.', error)
    }
  }

  const head = commits.find((commit) => commit.sha === commitSha)
  const deployment = options.deployment
    ? { provider: cleanText(options.deployment.provider) || null, id: cleanText(options.deployment.id) || null }
    : null
  const includedCommits: DevLogIncludedCommit[] = commits.map((commit) => ({
    sha: commit.sha,
    subject: commit.subject,
    committedAt: commit.committedAt,
    authorName: commit.authorName && !EMAIL_RE.test(commit.authorName) ? commit.authorName : null,
    authorLogin: commit.authorLogin ?? null,
  }))

  const maxAttempts = clampLimit(options.maxAttempts, 5, 50)
  let latest = initialLatest
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) latest = await store.latest()
    const version = nextBradshawVersion(latest?.version ?? baselineVersion, {
      releaseAt: releasedAtDate,
      scheme: options.scheme,
    })
    const candidate = validateDevLogEntry({
      version,
      date,
      releasedAt,
      commit: commitSha,
      sourceSubject: head?.subject || fallbackCommit.subject,
      title: copy.title,
      summary: copy.summary,
      notes: copy.notes,
      author: resolveAuthor(options.author, head),
      includedCommits,
      compatibility: defaults.compatibility,
      action: defaults.action,
      deployment,
    }, { rejectAuthorEmail: true })
    if (!candidate) throw new Error('Generated deploy DevLog release is invalid.')
    const release = candidate as DevLogDeployRelease

    const result = await store.insert(release)
    if (result === 'inserted') return { status: 'recorded', release }
    if (result === 'commit-conflict') {
      const raced = await store.findByCommit(commitSha)
      if (raced) return { status: 'existing', release: raced }
      throw new Error(`DevLog store reported a commit conflict for ${commitSha} but has no matching release.`)
    }
    warn(`DevLog version ${version} was taken by another recorder; retrying (${attempt}/${maxAttempts}).`)
  }
  throw new Error(`DevLog could not allocate a version for ${commitSha} after ${maxAttempts} attempts.`)
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

function cloneRelease(release: DevLogDeployRelease): DevLogDeployRelease {
  return JSON.parse(JSON.stringify(release)) as DevLogDeployRelease
}

/** In-process release store for tests and local development. */
export function createMemoryReleaseStore(initial: DevLogDeployRelease[] = []): DevLogReleaseStore & {
  releases: () => DevLogDeployRelease[]
} {
  const releases: DevLogDeployRelease[] = initial.map(cloneRelease)
  const sorted = () => [...releases].sort((left, right) => compareDevLogVersions(right.version, left.version))
  return {
    async findByCommit(commitSha) {
      const sha = cleanText(commitSha).toLowerCase()
      const found = releases.find((release) => release.commit === sha)
      return found ? cloneRelease(found) : null
    },
    async latest() {
      const newest = sorted()[0]
      return newest
        ? { version: newest.version, commitSha: newest.commit ?? null, releasedAt: newest.releasedAt ?? null }
        : null
    },
    async insert(release) {
      if (releases.some((item) => item.commit === release.commit)) return 'commit-conflict'
      if (releases.some((item) => item.version === release.version)) return 'version-conflict'
      releases.push(cloneRelease(release))
      return 'inserted'
    },
    async list(options = {}) {
      return sorted().slice(0, clampLimit(options.limit, 50, 1000)).map(cloneRelease)
    },
    releases: () => sorted().map(cloneRelease),
  }
}

/** Minimal query interface; a node-postgres `Pool` or `Client` satisfies it. */
export type DevLogSqlQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

export type DevLogPostgresReleaseStore = DevLogReleaseStore & {
  table: string
  ensureSchema(): Promise<void>
}

const RELEASE_COLUMNS = [
  'version', 'commit_sha', 'released_at', 'release_date', 'title', 'summary', 'notes', 'commits',
  'source_subject', 'author', 'compatibility', 'action', 'deployment_provider', 'deployment_id',
].join(', ')

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function rowToRelease(row: Record<string, unknown>): DevLogDeployRelease | null {
  const deploymentProvider = row.deployment_provider == null ? null : String(row.deployment_provider)
  const deploymentId = row.deployment_id == null ? null : String(row.deployment_id)
  const release = validateDevLogEntry({
    version: row.version,
    date: row.release_date instanceof Date ? row.release_date.toISOString().slice(0, 10) : row.release_date,
    releasedAt: toIso(row.released_at),
    commit: row.commit_sha,
    title: row.title,
    ...(row.summary != null ? { summary: row.summary } : {}),
    notes: parseJsonColumn(row.notes),
    includedCommits: parseJsonColumn(row.commits) ?? [],
    ...(row.source_subject != null ? { sourceSubject: row.source_subject } : {}),
    author: parseJsonColumn(row.author) ?? null,
    compatibility: row.compatibility ?? 'compatible',
    action: row.action ?? null,
    deployment: deploymentProvider || deploymentId ? { provider: deploymentProvider, id: deploymentId } : null,
  })
  return release as DevLogDeployRelease | null
}

/**
 * Postgres-backed release store. `query` receives parameterized SQL; the table name is validated
 * against an identifier pattern because it is interpolated. Does not depend on `pg`.
 */
export function createPostgresReleaseStore(options: { query: DevLogSqlQuery; table?: string }): DevLogPostgresReleaseStore {
  const table = cleanText(options.table) || 'devlog_releases'
  if (!TABLE_NAME_RE.test(table)) {
    throw new Error(`Invalid DevLog table name: ${table}. Use letters, digits, and underscores, optionally schema-qualified.`)
  }
  if (typeof options.query !== 'function') throw new Error('createPostgresReleaseStore requires a query function.')
  const query = options.query
  const versionOrder = `string_to_array(version, '.')::int[] DESC`

  return {
    table,
    async ensureSchema() {
      await query(`CREATE TABLE IF NOT EXISTS ${table} (
  version text PRIMARY KEY CHECK (version ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'),
  commit_sha text NOT NULL UNIQUE CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  released_at timestamptz NOT NULL,
  release_date text NOT NULL,
  title text NOT NULL,
  summary text,
  notes jsonb NOT NULL,
  commits jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_subject text,
  author jsonb,
  compatibility text NOT NULL DEFAULT 'compatible' CHECK (compatibility IN ('compatible', 'action-required', 'breaking')),
  action text,
  deployment_provider text,
  deployment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
)`)
    },
    async findByCommit(commitSha) {
      const result = await query(
        `SELECT ${RELEASE_COLUMNS} FROM ${table} WHERE commit_sha = $1 LIMIT 1`,
        [cleanText(commitSha).toLowerCase()],
      )
      const row = result.rows[0]
      return row ? rowToRelease(row) : null
    },
    async latest() {
      const result = await query(`SELECT version, commit_sha, released_at FROM ${table} ORDER BY ${versionOrder} LIMIT 1`, [])
      const row = result.rows[0]
      if (!row) return null
      return {
        version: String(row.version),
        commitSha: row.commit_sha == null ? null : String(row.commit_sha),
        releasedAt: toIso(row.released_at),
      }
    },
    async insert(release) {
      const result = await query(
        `INSERT INTO ${table} (${RELEASE_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14)
ON CONFLICT DO NOTHING
RETURNING version`,
        [
          release.version,
          release.commit,
          release.releasedAt,
          release.date,
          release.title,
          release.summary ?? null,
          JSON.stringify(release.notes),
          JSON.stringify(release.includedCommits ?? []),
          release.sourceSubject ?? null,
          release.author ? JSON.stringify(release.author) : null,
          release.compatibility ?? 'compatible',
          release.action ?? null,
          release.deployment?.provider ?? null,
          release.deployment?.id ?? null,
        ],
      )
      if (result.rows.length) return 'inserted'
      const commit = await query(`SELECT 1 FROM ${table} WHERE commit_sha = $1 LIMIT 1`, [release.commit])
      return commit.rows.length ? 'commit-conflict' : 'version-conflict'
    },
    async list(listOptions = {}) {
      const result = await query(
        `SELECT ${RELEASE_COLUMNS} FROM ${table} ORDER BY ${versionOrder} LIMIT $1`,
        [clampLimit(listOptions.limit, 50, 1000)],
      )
      return result.rows.map(rowToRelease).filter((release): release is DevLogDeployRelease => Boolean(release))
    },
  }
}

// ---------------------------------------------------------------------------
// Deploy environment
// ---------------------------------------------------------------------------

/** Detected providers are 'railway', 'vercel', 'github-actions'; `DEVLOG_DEPLOYMENT_PROVIDER` may set any label. */
export type DevLogDeployProvider = 'railway' | 'vercel' | 'github-actions' | 'devlog' | (string & {})

export type DevLogDeployContext = {
  provider: DevLogDeployProvider | null
  /** True when the provider or `DEVLOG_PRODUCTION` marks this as a production deploy. */
  production: boolean
  commitSha: string
  subject: string
  body: string
  branch: string
  author: DevLogAuthor | null
  repository: { owner: string; repo: string } | null
  deployment: DevLogDeployment | null
  /** Ready to pass as `recordDeployRelease({ headCommit })`. */
  headCommit: Partial<Omit<DevLogCommit, 'sha'>>
}

function envBoolean(value: unknown): boolean | undefined {
  const normalized = cleanText(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanText(value)
    if (text) return text
  }
  return ''
}

/**
 * Reads deploy metadata from Railway, Vercel, or GitHub Actions environment variables. Explicit
 * `DEVLOG_*` variables always win.
 */
export function resolveDevLogDeployContext(env: NodeJS.ProcessEnv = process.env): DevLogDeployContext {
  const railway = Boolean(env.RAILWAY_GIT_COMMIT_SHA || env.RAILWAY_DEPLOYMENT_ID)
  const vercel = Boolean(env.VERCEL_GIT_COMMIT_SHA || env.VERCEL_DEPLOYMENT_ID)
  const github = env.GITHUB_ACTIONS === 'true' || Boolean(env.GITHUB_SHA)
  const detected: DevLogDeployProvider | null = railway ? 'railway' : vercel ? 'vercel' : github ? 'github-actions' : null

  const providerMessage = railway ? env.RAILWAY_GIT_COMMIT_MESSAGE : vercel ? env.VERCEL_GIT_COMMIT_MESSAGE : ''
  const message = String(env.DEVLOG_COMMIT_MESSAGE || providerMessage || '').replace(/\r\n/g, '\n')
  const [messageSubject = '', ...messageBody] = message.split('\n')
  const subject = first(env.DEVLOG_COMMIT_SUBJECT, messageSubject)
  const body = String(env.DEVLOG_COMMIT_BODY || messageBody.join('\n')).trim()

  const commitSha = first(
    env.DEVLOG_COMMIT_SHA,
    railway ? env.RAILWAY_GIT_COMMIT_SHA : '',
    vercel ? env.VERCEL_GIT_COMMIT_SHA : '',
    github ? env.GITHUB_SHA : '',
  ).toLowerCase()
  const branch = first(
    env.DEVLOG_BRANCH,
    railway ? env.RAILWAY_GIT_BRANCH : '',
    vercel ? env.VERCEL_GIT_COMMIT_REF : '',
    github ? env.GITHUB_REF_NAME : '',
  )

  const login = first(
    env.DEVLOG_AUTHOR_LOGIN,
    railway ? env.RAILWAY_GIT_AUTHOR : '',
    vercel ? env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN : '',
    github ? env.GITHUB_ACTOR : '',
  )
  const githubLogin = GITHUB_LOGIN_RE.test(login) ? login : ''
  const authorName = first(env.DEVLOG_AUTHOR_NAME, vercel ? env.VERCEL_GIT_COMMIT_AUTHOR_NAME : '', githubLogin)
  const author = authorName && !EMAIL_RE.test(authorName) ? { name: authorName, githubLogin: githubLogin || null } : null

  const [githubOwner = '', githubRepo = ''] = github ? String(env.GITHUB_REPOSITORY || '').split('/') : []
  const owner = first(
    env.DEVLOG_REPO_OWNER,
    railway ? env.RAILWAY_GIT_REPO_OWNER : '',
    vercel ? env.VERCEL_GIT_REPO_OWNER : '',
    githubOwner,
  )
  const repo = first(
    env.DEVLOG_REPO_NAME,
    railway ? env.RAILWAY_GIT_REPO_NAME : '',
    vercel ? env.VERCEL_GIT_REPO_SLUG : '',
    githubRepo,
  )

  const provider = first(env.DEVLOG_DEPLOYMENT_PROVIDER, detected || (env.DEVLOG_COMMIT_SHA ? 'devlog' : ''))
  const deploymentId = first(
    env.DEVLOG_DEPLOYMENT_ID,
    railway ? env.RAILWAY_DEPLOYMENT_ID : '',
    vercel ? env.VERCEL_DEPLOYMENT_ID : '',
    github ? env.GITHUB_RUN_ID : '',
  )

  const production = envBoolean(env.DEVLOG_PRODUCTION)
    ?? (env.VERCEL_ENV === 'production'
      || env.RAILWAY_ENVIRONMENT_NAME === 'production'
      || (env.NODE_ENV === 'production' && envBoolean(env.CI) === true))

  return {
    provider: provider || null,
    production,
    commitSha,
    subject,
    body,
    branch,
    author,
    repository: owner && repo ? { owner, repo } : null,
    deployment: provider || deploymentId ? { provider: provider || null, id: deploymentId || null } : null,
    headCommit: {
      subject,
      body,
      authorName: author?.name ?? '',
      authorLogin: author?.githubLogin ?? null,
    },
  }
}
