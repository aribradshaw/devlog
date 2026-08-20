import { describe, expect, it } from 'vitest'
import {
  createDevLogCapabilities,
  filterDevLogEntries,
  nextCalendarVersion,
  paginateDevLogEntries,
  resolveDevLogSourceMeta,
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
  it('paginates without a UI framework', () => expect(paginateDevLogEntries(entries, 2, 1)).toEqual([entries[1]]))
})

describe('Phoenix calendar versioning', () => {
  it('increments within a month', () => expect(nextCalendarVersion('1.0.6', { latestReleaseDate: '2026-08-01', releaseAt: '2026-08-19' })).toBe('1.0.7'))
  it('advances on a new month', () => expect(nextCalendarVersion('1.0.6', { latestReleaseDate: '2026-08-19', releaseAt: '2026-09-01' })).toBe('1.1.1'))
  it('advances on a new year', () => expect(nextCalendarVersion('1.4.8', { latestReleaseDate: '2026-12-01', releaseAt: '2027-01-01' })).toBe('2.0.1'))
})
