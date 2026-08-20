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

const FULL_COMMIT_RE = /^[a-f0-9]{40}$/i
const GITHUB_LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

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
    ...entry.notes,
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
