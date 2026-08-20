export type DevLogVisibility = 'public' | 'private'

export type DevLogAuthor = {
  name: string
  githubLogin?: string | null
  avatarUrl?: string | null
  profileUrl?: string | null
}

export type DevLogIncludedCommit = {
  sha: string
  subject: string
  committedAt?: string | null
}

export type DevLogLifecycleStatus = 'building' | 'ready' | 'error' | 'canceled' | 'unknown'

export type DevLogLifecycle = {
  committedAt: string | null
  pushObservedAt: string | null
  buildStartedAt: string | null
  readyAt: string | null
  status: DevLogLifecycleStatus
}

export type DevLogEntry = {
  version: string
  date: string
  title: string
  notes: string[]
  summary?: string
  sourceSubject?: string
  commit?: string | null
  author?: DevLogAuthor | null
  includedCommits?: DevLogIncludedCommit[]
  releasedAt?: string
  lifecycle?: DevLogLifecycle | null
  [extension: string]: unknown
}

export type DevLogCapabilities = {
  visibility: DevLogVisibility
  author: boolean
  commit: boolean
  sourceSubject: boolean
  includedCommits: boolean
  lifecycle: boolean
  search: boolean
  pagination: boolean
}

export type DevLogSourceMeta = {
  author: (DevLogAuthor & { initials: string; avatarUrl: string | null; profileUrl: string | null }) | null
  commit: { sha: string; shortSha: string; url: string } | null
}

export type DevLogPaginationItem = number | 'ellipsis'

export type DevLogFilterOptions<T> = {
  getSearchValues?: (entry: T) => unknown[]
}

export type DevLogValidationOptions = {
  requireAuthor?: boolean
  requireCommit?: boolean
  requireReleasedAt?: boolean
  requireSourceSubject?: boolean
  rejectAuthorEmail?: boolean
  rejectTicketTitle?: boolean
}

export type DevLogReleaseAlignmentInput = {
  currentVersion: unknown
  latestDevLogVersion: unknown
  dependencyVersion?: unknown
  previousVersion?: unknown
  previousDependencyVersion?: unknown
}

export type DevLogReleaseAlignment = {
  currentVersion: string
  latestDevLogVersion: string
  dependencyChanged: boolean
  versionChanged: boolean
}

export type DevLogTextSegment = {
  text: string
  match: boolean
}

export type DevLogCollection<T extends DevLogEntry> = {
  query: string
  terms: string[]
  entries: T[]
  filteredEntries: T[]
  visibleEntries: T[]
  totalEntries: number
  filteredCount: number
  currentPage: number
  totalPages: number
  firstVisible: number
  lastVisible: number
  paginationItems: DevLogPaginationItem[]
}

export type DevLogResolvedCommit = DevLogIncludedCommit & {
  shortSha: string
  url: string
}

export type DevLogReleasePlan<T extends DevLogEntry> =
  | { kind: 'reuse'; version: string; release: T }
  | { kind: 'create'; version: string; release: null }

const FULL_COMMIT_RE = /^[a-f0-9]{40}$/i
const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const TICKET_PREFIX_RE = /^\s*(?:\[#?\d+\]|#\d+)\s*/
const LIFECYCLE_STATUSES = new Set<DevLogLifecycleStatus>(['building', 'ready', 'error', 'canceled', 'unknown'])

export const PUBLIC_DEVLOG_CAPABILITIES: DevLogCapabilities = {
  visibility: 'public',
  author: true,
  commit: true,
  sourceSubject: false,
  includedCommits: false,
  lifecycle: false,
  search: false,
  pagination: false,
}

export const PRIVATE_DEVLOG_CAPABILITIES: DevLogCapabilities = {
  visibility: 'private',
  author: true,
  commit: true,
  sourceSubject: true,
  includedCommits: true,
  lifecycle: true,
  search: true,
  pagination: true,
}

export function createDevLogCapabilities(overrides: Partial<DevLogCapabilities> = {}): DevLogCapabilities {
  const baseline = overrides.visibility === 'private' ? PRIVATE_DEVLOG_CAPABILITIES : PUBLIC_DEVLOG_CAPABILITIES
  return { ...baseline, ...overrides }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function normalizeIsoTimestamp(value: unknown): string | null {
  const text = cleanText(value)
  if (!text || !ISO_TIMESTAMP_RE.test(text)) return null
  const timestamp = new Date(text)
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString()
}

function isValidDateOnly(value: unknown): value is string {
  const match = DATE_ONLY_RE.exec(cleanText(value))
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function resolveDevLogLifecycle(input: {
  releasedAt?: unknown
  committedAt?: unknown
  pushObservedAt?: unknown
  buildStartedAt?: unknown
  readyAt?: unknown
  status?: unknown
} = {}): DevLogLifecycle {
  const releasedAt = normalizeIsoTimestamp(input.releasedAt)
  const committedAt = normalizeIsoTimestamp(input.committedAt)
  const pushObservedAt = normalizeIsoTimestamp(input.pushObservedAt)
  const explicitBuildStartedAt = normalizeIsoTimestamp(input.buildStartedAt)
  const buildStartedAt = explicitBuildStartedAt || releasedAt
  const readyAt = normalizeIsoTimestamp(input.readyAt)
  const requestedStatus = cleanText(input.status).toLowerCase() as DevLogLifecycleStatus

  let status: DevLogLifecycleStatus = 'unknown'
  if (readyAt) status = 'ready'
  else if (requestedStatus === 'error' || requestedStatus === 'canceled') status = requestedStatus
  else if (requestedStatus === 'building' || requestedStatus === 'ready' || explicitBuildStartedAt) status = 'building'

  return { committedAt, pushObservedAt, buildStartedAt, readyAt, status }
}

export function validateDevLogEntry(
  value: unknown,
  options: DevLogValidationOptions = {},
): DevLogEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<DevLogEntry>
  const version = cleanText(candidate.version)
  const date = cleanText(candidate.date)
  const title = cleanText(candidate.title)
  const notes = Array.isArray(candidate.notes) ? candidate.notes.map(cleanText) : []
  const summary = candidate.summary == null ? undefined : cleanText(candidate.summary)
  const sourceSubject = candidate.sourceSubject == null ? undefined : cleanText(candidate.sourceSubject)
  const commit = candidate.commit == null ? null : cleanText(candidate.commit).toLowerCase()
  const releasedAt = candidate.releasedAt == null
    ? undefined
    : normalizeIsoTimestamp(candidate.releasedAt) || undefined

  if (!SEMVER_RE.test(version) || !isValidDateOnly(date) || !title) return null
  if (!notes.length || notes.some((note) => !note)) return null
  if (candidate.summary != null && !summary) return null
  if (candidate.sourceSubject != null && !sourceSubject) return null
  if (options.requireSourceSubject && !sourceSubject) return null
  if (options.rejectTicketTitle && TICKET_PREFIX_RE.test(title)) return null
  if (commit !== null && !FULL_COMMIT_RE.test(commit)) return null
  if (options.requireCommit && !commit) return null
  if (candidate.releasedAt != null && !releasedAt) return null
  if (options.requireReleasedAt && !releasedAt) return null

  let author: DevLogAuthor | null | undefined
  if (candidate.author != null) {
    if (typeof candidate.author !== 'object' || Array.isArray(candidate.author)) return null
    const name = cleanText(candidate.author.name)
    const githubLogin = candidate.author.githubLogin == null ? null : cleanText(candidate.author.githubLogin)
    if (!name || (githubLogin && !GITHUB_LOGIN_RE.test(githubLogin))) return null
    if (options.rejectAuthorEmail && EMAIL_RE.test(name)) return null
    author = {
      ...candidate.author,
      name,
      githubLogin,
      avatarUrl: candidate.author.avatarUrl || null,
      profileUrl: candidate.author.profileUrl || null,
    }
  } else if (options.requireAuthor) return null

  let includedCommits: DevLogIncludedCommit[] | undefined
  if (candidate.includedCommits != null) {
    if (!Array.isArray(candidate.includedCommits)) return null
    includedCommits = []
    for (const raw of candidate.includedCommits) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const sha = cleanText(raw.sha).toLowerCase()
      const subject = cleanText(raw.subject)
      const committedAt = raw.committedAt == null ? null : normalizeIsoTimestamp(raw.committedAt)
      if (!FULL_COMMIT_RE.test(sha) || !subject || (raw.committedAt != null && !committedAt)) return null
      includedCommits.push({ sha, subject, committedAt })
    }
  }

  let lifecycle: DevLogLifecycle | null | undefined
  if (candidate.lifecycle != null) {
    if (typeof candidate.lifecycle !== 'object' || Array.isArray(candidate.lifecycle)) return null
    const requestedStatus = cleanText(candidate.lifecycle.status).toLowerCase() as DevLogLifecycleStatus
    if (!LIFECYCLE_STATUSES.has(requestedStatus)) return null
    for (const timestamp of ['committedAt', 'pushObservedAt', 'buildStartedAt', 'readyAt'] as const) {
      if (candidate.lifecycle[timestamp] != null && !normalizeIsoTimestamp(candidate.lifecycle[timestamp])) return null
    }
    lifecycle = resolveDevLogLifecycle({ ...candidate.lifecycle, releasedAt })
  }

  return {
    ...candidate,
    version,
    date,
    title,
    notes,
    ...(summary !== undefined ? { summary } : {}),
    ...(sourceSubject !== undefined ? { sourceSubject } : {}),
    commit,
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(includedCommits !== undefined ? { includedCommits } : {}),
    ...(lifecycle !== undefined ? { lifecycle } : {}),
  }
}

export function validateDevLogEntries(
  value: unknown,
  options: DevLogValidationOptions = {},
): DevLogEntry[] | null {
  if (!Array.isArray(value) || !value.length) return null
  const entries: DevLogEntry[] = []
  const versions = new Set<string>()
  for (const item of value) {
    const entry = validateDevLogEntry(item, options)
    if (!entry || versions.has(entry.version)) return null
    versions.add(entry.version)
    entries.push(entry)
  }
  return entries
}

export function authorInitials(name: string): string {
  return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]?.toUpperCase()).join('')
}

export function resolveDevLogAuthor(author?: DevLogAuthor | null): DevLogSourceMeta['author'] {
  const name = String(author?.name || '').trim()
  if (!name) return null
  const login = String(author?.githubLogin || '').trim()
  const githubLogin = GITHUB_LOGIN_RE.test(login) ? login : null
  return {
    name,
    githubLogin,
    initials: authorInitials(name),
    avatarUrl: author?.avatarUrl || (githubLogin ? `https://github.com/${githubLogin}.png?size=64` : null),
    profileUrl: author?.profileUrl || (githubLogin ? `https://github.com/${githubLogin}` : null),
  }
}

export function resolveDevLogCommit(
  entry: Pick<DevLogEntry, 'version' | 'commit'>,
  currentVersion: string,
  buildCommit = '',
): string | null {
  const recorded = String(entry.commit || '').trim().toLowerCase()
  if (FULL_COMMIT_RE.test(recorded)) return recorded
  const current = String(buildCommit || '').trim().toLowerCase()
  if (entry.version === currentVersion && FULL_COMMIT_RE.test(current)) return current
  return null
}

export function resolveDevLogSourceMeta(
  entry: DevLogEntry,
  options: {
    repositoryUrl: string
    currentVersion: string
    buildCommit?: string
    capabilities?: Partial<DevLogCapabilities>
  },
): DevLogSourceMeta {
  const capabilities = createDevLogCapabilities(options.capabilities)
  const author = capabilities.author ? resolveDevLogAuthor(entry.author) : null
  const sha = capabilities.commit ? resolveDevLogCommit(entry, options.currentVersion, options.buildCommit) : null
  return {
    author,
    commit: sha ? {
      sha,
      shortSha: sha.slice(0, 7),
      url: `${options.repositoryUrl.replace(/\/$/, '')}/commit/${sha}`,
    } : null,
  }
}

export function resolveDevLogSourceLink(
  entry: Pick<DevLogEntry, 'version' | 'commit'>,
  options: { repositoryUrl: string; currentVersion: string; buildCommit?: string },
): { kind: 'commit' | 'repository'; url: string; sha: string | null; shortSha: string | null } {
  const repositoryUrl = options.repositoryUrl.replace(/\/$/, '')
  const sha = resolveDevLogCommit(entry, options.currentVersion, options.buildCommit)
  return sha
    ? { kind: 'commit', url: `${repositoryUrl}/commit/${sha}`, sha, shortSha: sha.slice(0, 7) }
    : { kind: 'repository', url: repositoryUrl, sha: null, shortSha: null }
}

export function resolveDevLogIncludedCommits(
  entry: Pick<DevLogEntry, 'includedCommits'>,
  repositoryUrl: string,
): DevLogResolvedCommit[] {
  const base = repositoryUrl.replace(/\/$/, '')
  return (entry.includedCommits || []).filter((commit) => FULL_COMMIT_RE.test(commit.sha)).map((commit) => ({
    ...commit,
    sha: commit.sha.toLowerCase(),
    shortSha: commit.sha.slice(0, 7),
    url: `${base}/commit/${commit.sha.toLowerCase()}`,
  }))
}

export function resolveCurrentDevLogRelease<T extends DevLogEntry>(
  entries: T[],
  liveVersion?: string | null,
): { release: T | null; matched: boolean } {
  const release = liveVersion ? entries.find((entry) => entry.version === liveVersion) : undefined
  return { release: release || entries[0] || null, matched: Boolean(release) }
}

export function compareDevLogVersions(left: string, right: string): number {
  const leftMatch = SEMVER_RE.exec(cleanText(left))
  const rightMatch = SEMVER_RE.exec(cleanText(right))
  if (!leftMatch || !rightMatch) throw new Error('DevLog versions must use three numeric segments.')
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index])
    if (difference) return difference
  }
  return 0
}

export function sortDevLogEntries<T extends DevLogEntry>(entries: T[], direction: 'asc' | 'desc' = 'desc'): T[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...entries].sort((left, right) => compareDevLogVersions(left.version, right.version) * multiplier)
}

export function getLatestDevLogRelease<T extends DevLogEntry>(entries: T[]): T | null {
  return sortDevLogEntries(entries)[0] || null
}

export function planDevLogRelease<T extends DevLogEntry>(input: {
  entries: T[]
  commit?: string | null
  releaseAt?: string | Date
  timeZone?: string
  baselineVersion?: string
}): DevLogReleasePlan<T> {
  const commit = cleanText(input.commit).toLowerCase()
  if (commit && !FULL_COMMIT_RE.test(commit)) throw new Error('A release commit must be a full 40-character SHA.')
  const existing = commit
    ? input.entries.find((entry) => cleanText(entry.commit).toLowerCase() === commit)
    : undefined
  if (existing) return { kind: 'reuse', version: existing.version, release: existing }

  const latest = getLatestDevLogRelease(input.entries)
  const baselineVersion = cleanText(input.baselineVersion) || '1.0.0'
  if (!SEMVER_RE.test(baselineVersion)) throw new Error(`Invalid baseline version: ${baselineVersion}`)
  const version = latest
    ? nextCalendarVersion(latest.version, {
      latestReleaseDate: latest.releasedAt || latest.date,
      releaseAt: input.releaseAt,
      timeZone: input.timeZone,
    })
    : baselineVersion
  return { kind: 'create', version, release: null }
}

export function formatDevLogDate(
  value: string | Date,
  options: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string {
  const { locale = 'en-US', ...formatOptions } = options
  const date = value instanceof Date
    ? value
    : isValidDateOnly(value) ? new Date(`${value}T12:00:00Z`) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC', ...formatOptions,
  }).format(date)
}

export function formatDevLogDateTime(
  value: string | Date,
  options: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string {
  const { locale = 'en-US', ...formatOptions } = options
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short', ...formatOptions,
  }).format(date)
}

export function formatDevLogLifecycleLabel(
  lifecycle: DevLogLifecycle,
  options: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string {
  const stamp = lifecycle.readyAt || lifecycle.buildStartedAt
  const when = stamp ? formatDevLogDateTime(stamp, options) : 'time unavailable'
  if (lifecycle.status === 'ready') return `Ready ${when}`
  if (lifecycle.status === 'building') return `Building since ${when}`
  if (lifecycle.status === 'error') return `Failed ${when}`
  if (lifecycle.status === 'canceled') return `Canceled ${when}`
  return `Recorded ${when}`
}

export function getDevLogSearchTerms(value: unknown): string[] {
  return [...new Set(String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean))]
}

function defaultSearchValues(entry: DevLogEntry): unknown[] {
  return [
    entry.version,
    entry.date,
    entry.title,
    entry.summary || '',
    entry.sourceSubject || '',
    entry.commit || '',
    entry.author?.name || '',
    entry.author?.githubLogin || '',
    entry.releasedAt || '',
    ...entry.notes,
    ...(entry.includedCommits || []).flatMap((commit) => [commit.sha, commit.subject, commit.committedAt || '']),
    entry.lifecycle?.status || '',
    entry.lifecycle?.committedAt || '',
    entry.lifecycle?.pushObservedAt || '',
    entry.lifecycle?.buildStartedAt || '',
    entry.lifecycle?.readyAt || '',
  ]
}

export function filterDevLogEntries<T extends DevLogEntry>(
  entries: T[],
  query: unknown,
  options: DevLogFilterOptions<T> = {},
): T[] {
  const terms = getDevLogSearchTerms(query)
  if (!terms.length) return entries
  return entries.filter((entry) => {
    const searchable = (options.getSearchValues?.(entry) || defaultSearchValues(entry))
      .map((value) => String(value || ''))
      .join(' ')
      .toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
}

export function paginateDevLogEntries<T>(entries: T[], page: number, pageSize = 10): T[] {
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.max(1, Number(pageSize) || 10)
  return entries.slice((safePage - 1) * safePageSize, safePage * safePageSize)
}

export function getDevLogTextSegments(value: unknown, query: unknown): DevLogTextSegment[] {
  const text = String(value || '')
  const terms = Array.isArray(query)
    ? getDevLogSearchTerms(query.join(' '))
    : getDevLogSearchTerms(query)
  if (!text || !terms.length) return [{ text, match: false }]
  const escaped = terms.sort((left, right) => right.length - left.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  const matches = new Set(terms.map((term) => term.toLowerCase()))
  return text.split(pattern).filter(Boolean).map((part) => ({
    text: part,
    match: matches.has(part.toLowerCase()),
  }))
}

export function getDevLogCollection<T extends DevLogEntry>(
  entries: T[],
  options: DevLogFilterOptions<T> & { query?: unknown; page?: number; pageSize?: number } = {},
): DevLogCollection<T> {
  const query = String(options.query || '').trim()
  const terms = getDevLogSearchTerms(query)
  const filteredEntries = filterDevLogEntries(entries, query, options)
  const pageSize = Math.max(1, Number(options.pageSize) || 10)
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const currentPage = Math.min(Math.max(1, Number(options.page) || 1), totalPages)
  const visibleEntries = paginateDevLogEntries(filteredEntries, currentPage, pageSize)
  const firstVisible = filteredEntries.length ? (currentPage - 1) * pageSize + 1 : 0
  const lastVisible = Math.min(currentPage * pageSize, filteredEntries.length)
  return {
    query,
    terms,
    entries,
    filteredEntries,
    visibleEntries,
    totalEntries: entries.length,
    filteredCount: filteredEntries.length,
    currentPage,
    totalPages,
    firstVisible,
    lastVisible,
    paginationItems: getDevLogPaginationItems(currentPage, totalPages),
  }
}

export function getDevLogPaginationItems(currentPage: number, totalPages: number): DevLogPaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: Math.max(0, totalPages) }, (_, index) => index + 1)
  }
  const visiblePages = [...new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1])]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((left, right) => left - right)
  const items: DevLogPaginationItem[] = []
  visiblePages.forEach((page, index) => {
    if (index > 0 && page - (visiblePages[index - 1] || 0) > 1) items.push('ellipsis')
    items.push(page)
  })
  return items
}

export function assertDevLogReleaseAlignment(
  input: DevLogReleaseAlignmentInput,
): DevLogReleaseAlignment {
  const currentVersion = String(input.currentVersion || '').trim()
  const latestDevLogVersion = String(input.latestDevLogVersion || '').trim()
  if (!SEMVER_RE.test(currentVersion)) {
    throw new Error(`Invalid current application version: ${currentVersion || '(empty)'}`)
  }
  if (!SEMVER_RE.test(latestDevLogVersion)) {
    throw new Error(`Invalid latest DevLog version: ${latestDevLogVersion || '(empty)'}`)
  }
  if (currentVersion !== latestDevLogVersion) {
    throw new Error(
      `Application version ${currentVersion} does not match latest DevLog version ${latestDevLogVersion}.`,
    )
  }

  const dependencyVersion = String(input.dependencyVersion || '').trim()
  const previousDependencyVersion = String(input.previousDependencyVersion || '').trim()
  const previousVersion = String(input.previousVersion || '').trim()
  const dependencyChanged = Boolean(
    dependencyVersion && previousDependencyVersion && dependencyVersion !== previousDependencyVersion,
  )
  const versionChanged = Boolean(previousVersion && currentVersion !== previousVersion)
  if (dependencyChanged && !versionChanged) {
    throw new Error(
      `DevLog dependency changed from ${previousDependencyVersion} to ${dependencyVersion} without an application release.`,
    )
  }

  return { currentVersion, latestDevLogVersion, dependencyChanged, versionChanged }
}

function calendarMonth(value: string | Date, timeZone: string): { year: number; month: number } {
  const dateOnly = DATE_ONLY_RE.exec(String(value).trim())
  if (dateOnly) return { year: Number(dateOnly[1]), month: Number(dateOnly[2]) }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid release date: ${value}`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(date)
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  }
}

export function nextCalendarVersion(
  currentVersion: string,
  options: { latestReleaseDate?: string; releaseAt?: string | Date; timeZone?: string } = {},
): string {
  const match = SEMVER_RE.exec(String(currentVersion).trim())
  if (!match) throw new Error(`Invalid three-part version: ${currentVersion}`)
  const current = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
  if (!options.latestReleaseDate) return `${current.major}.${current.minor}.${current.patch + 1}`
  const timeZone = options.timeZone || 'America/Phoenix'
  const previous = calendarMonth(options.latestReleaseDate, timeZone)
  const next = calendarMonth(options.releaseAt || new Date(), timeZone)
  const monthDelta = (next.year - previous.year) * 12 + next.month - previous.month
  if (monthDelta <= 0) return `${current.major}.${current.minor}.${current.patch + 1}`
  if (next.year > previous.year) return `${current.major + (next.year - previous.year)}.${next.month - 1}.1`
  return `${current.major}.${current.minor + monthDelta}.1`
}
