import { describe, expect, it } from 'vitest'
import {
  assertDevLogReleaseAlignment,
  createDevLogCapabilities,
  compareDevLogVersions,
  filterDevLogEntries,
  formatDevLogDate,
  formatDevLogLifecycleLabel,
  getDevLogCollection,
  getDevLogPaginationItems,
  getDevLogSearchTerms,
  getDevLogTextSegments,
  getLatestDevLogRelease,
  nextCalendarVersion,
  paginateDevLogEntries,
  planDevLogRelease,
  resolveCurrentDevLogRelease,
  resolveDevLogIncludedCommits,
  resolveDevLogLifecycle,
  resolveDevLogSourceLink,
  resolveDevLogSourceMeta,
  validateDevLogEntries,
  validateDevLogEntry,
  type DevLogEntry,
} from '../src'

const release: DevLogEntry = {
  version: '1.0.2', date: '2026-08-19', title: 'Show the source',
  summary: 'Adds portable source metadata.', notes: ['Shows the author and commit.'],
  commit: 'a'.repeat(40), author: { name: 'Ari Bradshaw', githubLogin: 'aribradshaw' },
}

describe('capability policies', () => {
  it('keeps public and private features independently configurable', () => {
    expect(createDevLogCapabilities()).toMatchObject({ visibility: 'public', author: true, lifecycle: false })
    expect(createDevLogCapabilities({ visibility: 'private', commit: false }))
      .toMatchObject({ visibility: 'private', commit: false, lifecycle: true })
  })
})

describe('source metadata', () => {
  it('resolves a GitHub avatar, profile, and linked short commit', () => {
    expect(resolveDevLogSourceMeta(release, {
      repositoryUrl: 'https://github.com/aribradshaw/example', currentVersion: release.version,
    })).toMatchObject({
      author: { name: 'Ari Bradshaw', initials: 'AB', avatarUrl: 'https://github.com/aribradshaw.png?size=64' },
      commit: { shortSha: 'aaaaaaa', url: `https://github.com/aribradshaw/example/commit/${'a'.repeat(40)}` },
    })
  })

  it('uses the build SHA only for the current release', () => {
    const current = { ...release, commit: null }
    expect(resolveDevLogSourceMeta(current, {
      repositoryUrl: 'https://github.com/aribradshaw/example', currentVersion: current.version,
      buildCommit: 'b'.repeat(40),
    }).commit?.sha).toBe('b'.repeat(40))
    expect(resolveDevLogSourceMeta(current, {
      repositoryUrl: 'https://github.com/aribradshaw/example', currentVersion: '9.9.9',
      buildCommit: 'b'.repeat(40),
    }).commit).toBeNull()
  })
})

describe('collection helpers', () => {
  const entries = [release, { ...release, version: '1.0.1', title: 'First release', summary: 'Initial version.', notes: ['Published.'] }]
  it('filters across release and source metadata', () => expect(filterDevLogEntries(entries, 'ari source')).toEqual([release]))
  it('deduplicates normalized search terms', () => expect(getDevLogSearchTerms('  Ari ari SOURCE ')).toEqual(['ari', 'source']))
  it('supports project-specific search fields without prescribing UI or schema', () => {
    expect(filterDevLogEntries(entries, 'Aug 19', {
      getSearchValues: (entry) => [entry.version === '1.0.2' ? 'Aug 19, 2026' : '', entry.title],
    })).toEqual([release])
  })
  it('paginates without a UI framework', () => expect(paginateDevLogEntries(entries, 2, 1)).toEqual([entries[1]]))
  it('builds the established compact pagination window', () => {
    expect(getDevLogPaginationItems(6, 12)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 12])
    expect(getDevLogPaginationItems(1, 3)).toEqual([1, 2, 3])
  })
})

describe('Phoenix calendar versioning', () => {
  it('increments within a month', () => expect(nextCalendarVersion('1.0.6', { latestReleaseDate: '2026-08-01', releaseAt: '2026-08-19' })).toBe('1.0.7'))
  it('advances on a new month', () => expect(nextCalendarVersion('1.0.6', { latestReleaseDate: '2026-08-19', releaseAt: '2026-09-01' })).toBe('1.1.1'))
  it('advances on a new year', () => expect(nextCalendarVersion('1.4.8', { latestReleaseDate: '2026-12-01', releaseAt: '2027-01-01' })).toBe('2.0.1'))
})

describe('release alignment', () => {
  it('accepts an aligned application and DevLog release', () => {
    expect(assertDevLogReleaseAlignment({
      currentVersion: '1.1.53',
      latestDevLogVersion: '1.1.53',
      dependencyVersion: '1.0.2',
      previousVersion: '1.1.52',
      previousDependencyVersion: '1.0.1',
    })).toMatchObject({ dependencyChanged: true, versionChanged: true })
  })

  it('rejects a stale DevLog registry', () => {
    expect(() => assertDevLogReleaseAlignment({
      currentVersion: '1.1.53', latestDevLogVersion: '1.1.52',
    })).toThrow(/does not match latest DevLog version/)
  })

  it('rejects a dependency migration without an application release', () => {
    expect(() => assertDevLogReleaseAlignment({
      currentVersion: '1.1.52',
      latestDevLogVersion: '1.1.52',
      dependencyVersion: '1.0.2',
      previousVersion: '1.1.52',
      previousDependencyVersion: '1.0.1',
    })).toThrow(/without an application release/)
  })
})

describe('runtime validation', () => {
  it('normalizes a rich release while preserving host extensions', () => {
    expect(validateDevLogEntry({
      ...release,
      releasedAt: '2026-08-19T12:30:00-07:00',
      includedCommits: [{ sha: 'b'.repeat(40), subject: 'Ship the source', committedAt: '2026-08-19T18:00:00Z' }],
      lifecycle: { status: 'ready', readyAt: '2026-08-19T19:00:00Z' },
      deploymentId: 'deploy-123',
    }, { requireAuthor: true, requireCommit: true })).toMatchObject({
      releasedAt: '2026-08-19T19:30:00.000Z',
      lifecycle: { status: 'ready', readyAt: '2026-08-19T19:00:00.000Z' },
      deploymentId: 'deploy-123',
    })
  })

  it('rejects impossible dates, malformed commits, duplicate versions, and unsafe author names', () => {
    expect(validateDevLogEntry({ ...release, date: '2026-02-30' })).toBeNull()
    expect(validateDevLogEntry({ ...release, commit: 'short' })).toBeNull()
    expect(validateDevLogEntry({ ...release, author: { name: 'ari@example.com' } }, { rejectAuthorEmail: true })).toBeNull()
    expect(validateDevLogEntries([release, release])).toBeNull()
  })
})

describe('lifecycle and source resolution', () => {
  it('normalizes lifecycle state and formats a viewer-time-zone label', () => {
    const lifecycle = resolveDevLogLifecycle({
      releasedAt: '2026-08-19T18:00:00Z', readyAt: '2026-08-19T19:15:00Z', status: 'building',
    })
    expect(lifecycle.status).toBe('ready')
    expect(formatDevLogLifecycleLabel(lifecycle, { timeZone: 'America/Phoenix' }))
      .toContain('Ready Aug 19, 2026')
  })

  it('links every included commit and offers a repository fallback', () => {
    expect(resolveDevLogIncludedCommits({
      includedCommits: [{ sha: 'b'.repeat(40), subject: 'Batch update' }],
    }, 'https://github.com/example/repo/')[0]).toMatchObject({ shortSha: 'bbbbbbb', url: `https://github.com/example/repo/commit/${'b'.repeat(40)}` })
    expect(resolveDevLogSourceLink({ version: '1.0.1', commit: null }, {
      repositoryUrl: 'https://github.com/example/repo/', currentVersion: '1.0.2',
    })).toMatchObject({ kind: 'repository', url: 'https://github.com/example/repo' })
  })
})

describe('release selection and planning', () => {
  const older = { ...release, version: '1.0.1', date: '2026-08-18', commit: 'b'.repeat(40) }
  it('selects a live release without silently hiding a mismatch', () => {
    expect(resolveCurrentDevLogRelease([release, older], '1.0.1')).toEqual({ release: older, matched: true })
    expect(resolveCurrentDevLogRelease([release, older], '9.9.9')).toEqual({ release, matched: false })
  })

  it('sorts numeric versions and reuses an already-recorded commit', () => {
    expect(compareDevLogVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(getLatestDevLogRelease([older, release])?.version).toBe('1.0.2')
    expect(planDevLogRelease({ entries: [release, older], commit: older.commit })).toMatchObject({ kind: 'reuse', version: '1.0.1' })
  })

  it('plans the next calendar update for a new commit', () => {
    expect(planDevLogRelease({
      entries: [release, older], commit: 'c'.repeat(40), releaseAt: '2026-08-20T12:00:00Z',
    })).toEqual({ kind: 'create', version: '1.0.3', release: null })
  })
})

describe('headless presentation helpers', () => {
  it('formats dates without shifting date-only releases across time zones', () => {
    expect(formatDevLogDate('2026-08-19', { month: 'long', timeZone: 'America/Phoenix' })).toBe('August 19, 2026')
  })

  it('returns framework-neutral search highlight segments', () => {
    expect(getDevLogTextSegments('Audio source metadata', 'audio metadata')).toEqual([
      { text: 'Audio', match: true },
      { text: ' source ', match: false },
      { text: 'metadata', match: true },
    ])
  })

  it('builds a complete, clamped collection model', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      ...release, version: `1.0.${12 - index}`, title: index < 3 ? 'Audio update' : 'Other update',
    }))
    expect(getDevLogCollection(entries, { query: 'audio', page: 99, pageSize: 2 })).toMatchObject({
      filteredCount: 3, currentPage: 2, totalPages: 2, firstVisible: 3, lastVisible: 3,
      paginationItems: [1, 2],
    })
  })
})
