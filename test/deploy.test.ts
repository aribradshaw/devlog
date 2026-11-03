import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildDefaultReleaseNotes,
  createMemoryReleaseStore,
  createPostgresReleaseStore,
  gitCommitRange,
  githubCommitRange,
  isMaintenanceOnlySource,
  MAINTENANCE_RELEASE_NOTE,
  nextBradshawVersion,
  parseDevLogTrailers,
  recordDeployRelease,
  resolveDevLogDeployContext,
  type DevLogCommit,
  type DevLogDeployRelease,
  type DevLogReleaseStore,
} from '../src/automation'
import { nextCalendarVersion, validateDevLogEntry, type BradshawVersionScheme } from '../src/index'

const phoenix: BradshawVersionScheme = { originYear: 2026, yearMode: 'one', timeZone: 'America/Phoenix' }
const sha = (char: string) => char.repeat(40)

function commit(char: string, subject: string, body = '', extra: Partial<DevLogCommit> = {}): DevLogCommit {
  return {
    sha: sha(char),
    subject,
    body,
    authorName: 'Ari Bradshaw',
    authorLogin: 'aribradshaw',
    committedAt: '2026-10-05T17:00:00.000Z',
    ...extra,
  }
}

describe('Bradshaw versioning', () => {
  it('starts at UPDATE 1 and increments within a month', () => {
    expect(nextBradshawVersion(null, { releaseAt: '2026-10-05T17:00:00Z', scheme: phoenix })).toBe('1.10.1')
    expect(nextBradshawVersion('1.10.1', { releaseAt: '2026-10-20T17:00:00Z', scheme: phoenix })).toBe('1.10.2')
  })

  it('rolls over months at the Phoenix boundary, including the last second of a month', () => {
    // 2026-10-31T23:59:59 in Phoenix (UTC-7, no DST)
    expect(nextBradshawVersion('1.10.7', { releaseAt: '2026-11-01T06:59:59Z', scheme: phoenix })).toBe('1.10.8')
    expect(nextBradshawVersion('1.10.7', { releaseAt: '2026-11-01T07:00:00Z', scheme: phoenix })).toBe('1.11.1')
  })

  it('rolls over years at the Phoenix boundary', () => {
    expect(nextBradshawVersion('1.12.4', { releaseAt: '2027-01-01T06:59:59Z', scheme: phoenix })).toBe('1.12.5')
    expect(nextBradshawVersion('1.12.4', { releaseAt: '2027-01-01T07:00:00Z', scheme: phoenix })).toBe('2.1.1')
  })

  it('supports zero-based and full calendar years', () => {
    expect(nextBradshawVersion(null, { releaseAt: '2027-03-02T12:00:00Z', scheme: { ...phoenix, yearMode: 'zero' } }))
      .toBe('1.3.1')
    expect(nextBradshawVersion('2026.12.9', {
      releaseAt: '2027-01-15T12:00:00Z',
      scheme: { yearMode: 'calendar', timeZone: 'America/Phoenix' },
    })).toBe('2027.1.1')
  })

  it('refuses a version that would not sort after the latest one', () => {
    expect(() => nextBradshawVersion('3.1.1', { releaseAt: '2026-10-05T17:00:00Z', scheme: phoenix }))
      .toThrow(/would not sort after/)
    expect(() => nextBradshawVersion(null, { releaseAt: '2025-12-01T17:00:00Z', scheme: phoenix }))
      .toThrow(/before the project origin year/)
    expect(() => nextBradshawVersion(null, { releaseAt: '2026-10-05T17:00:00Z', scheme: { yearMode: 'one', timeZone: 'UTC' } }))
      .toThrow(/originYear/)
  })

  it('leaves nextCalendarVersion unchanged', () => {
    expect(nextCalendarVersion('1.0.6', { latestReleaseDate: '2026-08-19', releaseAt: '2026-09-01', timeZone: 'America/Phoenix' }))
      .toBe('1.1.1')
  })
})

describe('release notes', () => {
  it('parses repeatable DevLog-Note trailers and the highest compatibility', () => {
    const trailers = parseDevLogTrailers([
      'Detailed body.',
      '',
      'DevLog-Note: Calendar invites now include the meeting link.',
      'DevLog-Note: Invites show the organizer.',
      'DevLog-Compat: action-required',
      'DevLog-Action: Reconnect Google Calendar.',
    ].join('\n'))
    expect(trailers).toEqual({
      notes: ['Calendar invites now include the meeting link.', 'Invites show the organizer.'],
      compatibility: 'action-required',
      actions: ['Reconnect Google Calendar.'],
      body: 'Detailed body.',
    })
  })

  it('builds notes from subjects and trailers, ignoring configured prefixes', () => {
    const notes = buildDefaultReleaseNotes([
      commit('a', 'feat(chart): Add zoom controls'),
      commit('b', 'chore(release): publish DevLog'),
      commit('c', 'DevLog: 1.10.4'),
      commit('d', 'fix: Repair export', 'DevLog-Note: PDF export keeps page breaks.\nDevLog-Compat: breaking\nDevLog-Action: Re-export saved PDFs.'),
    ])
    expect(notes).toEqual({
      title: 'Repair export and 1 more update',
      summary: 'Production now includes 2 updates.',
      notes: ['Add zoom controls', 'PDF export keeps page breaks.'],
      compatibility: 'breaking',
      action: 'Re-export saved PDFs.',
      maintenance: false,
    })
    expect(buildDefaultReleaseNotes([commit('a', 'Ship it')], { ignoreCommitPrefixes: ['ship'] }).maintenance).toBe(true)
  })

  it('uses a merge commit body as its title', () => {
    expect(buildDefaultReleaseNotes([commit('a', 'Merge pull request #12 from x/y', 'feat: Add billing page')]).title)
      .toBe('Add billing page')
  })

  it('detects maintenance-only sources like Othello', () => {
    expect(isMaintenanceOnlySource({ subject: 'chore: bump production version to 1.0.5' })).toBe(true)
    expect(isMaintenanceOnlySource({ subject: 'Merge branch main', body: '' })).toBe(true)
    expect(isMaintenanceOnlySource({ subject: 'Merge pull request #3 from a/b', body: 'Add search' })).toBe(false)
    expect(isMaintenanceOnlySource({ subject: 'Add search' })).toBe(false)
  })
})

describe('recordDeployRelease', () => {
  const base = { scheme: phoenix, releasedAt: '2026-10-05T17:00:00.000Z' }

  it('records one release per deploy listing every new commit, then is idempotent', async () => {
    const store = createMemoryReleaseStore()
    const first = await recordDeployRelease({
      ...base, store, commitSha: sha('a'), commits: [commit('a', 'Add zoom')],
    })
    expect(first.status).toBe('recorded')
    expect(first.release).toMatchObject({ version: '1.10.1', date: '2026-10-05', commit: sha('a'), title: 'Add zoom' })

    const source = vi.fn(async () => [commit('b', 'Add export'), commit('c', 'Fix colors')])
    const second = await recordDeployRelease({
      ...base, releasedAt: '2026-10-06T17:00:00Z', store, commitSha: sha('c'), commitSource: source,
    })
    expect(source).toHaveBeenCalledWith({ from: sha('a'), to: sha('c') })
    expect(second.release.version).toBe('1.10.2')
    expect(second.release.includedCommits.map((item) => item.sha)).toEqual([sha('b'), sha('c')])
    expect(second.release.notes).toEqual(['Add export', 'Fix colors'])
    expect(validateDevLogEntry(second.release, { requireCommit: true, requireReleasedAt: true })).toBeTruthy()

    const again = await recordDeployRelease({ ...base, store, commitSha: sha('c'), commitSource: source })
    expect(again).toEqual({ status: 'existing', release: second.release })
    expect(source).toHaveBeenCalledTimes(1)
    expect(await store.list()).toHaveLength(2)
  })

  it('uses the baseline version and commit while the store is empty', async () => {
    const store = createMemoryReleaseStore()
    const source = vi.fn(async () => [commit('b', 'Add export')])
    const result = await recordDeployRelease({
      ...base, store, commitSha: sha('b'), commitSource: source, baseline: { version: '1.10.4', commitSha: sha('a') },
    })
    expect(source).toHaveBeenCalledWith({ from: sha('a'), to: sha('b') })
    expect(result.release.version).toBe('1.10.5')
    const nextMonth = await recordDeployRelease({
      ...base, releasedAt: '2026-11-02T17:00:00Z', store: createMemoryReleaseStore(), commitSha: sha('b'),
      commits: [commit('b', 'x')], baseline: { version: '1.10.4' },
    })
    expect(nextMonth.release.version).toBe('1.11.1')
  })

  it('retries version selection when another recorder takes the version', async () => {
    const inner = createMemoryReleaseStore()
    let raced = false
    const store: DevLogReleaseStore = {
      ...inner,
      async insert(release) {
        if (!raced) {
          raced = true
          await inner.insert({ ...release, commit: sha('f') } as DevLogDeployRelease)
        }
        return inner.insert(release)
      },
    }
    const warnings: string[] = []
    const result = await recordDeployRelease({
      ...base, store, commitSha: sha('a'), commits: [commit('a', 'Add zoom')], onWarning: (message) => warnings.push(message),
    })
    expect(result).toMatchObject({ status: 'recorded', release: { version: '1.10.2' } })
    expect(warnings[0]).toMatch(/1\.10\.1 was taken/)
  })

  it('gives up after bounded version conflicts', async () => {
    const inner = createMemoryReleaseStore()
    const store: DevLogReleaseStore = { ...inner, insert: async () => 'version-conflict' }
    await expect(recordDeployRelease({ ...base, store, commitSha: sha('a'), commits: [], maxAttempts: 3 }))
      .rejects.toThrow(/after 3 attempts/)
  })

  it('returns the existing release on a commit conflict', async () => {
    const inner = createMemoryReleaseStore()
    let calls = 0
    const store: DevLogReleaseStore = {
      ...inner,
      async findByCommit(commitSha) {
        calls += 1
        return calls === 1 ? null : inner.findByCommit(commitSha)
      },
    }
    const winner = await recordDeployRelease({ ...base, store: inner, commitSha: sha('a'), commits: [commit('a', 'Winner')] })
    const loser = await recordDeployRelease({ ...base, store, commitSha: sha('a'), commits: [commit('a', 'Loser')] })
    expect(loser).toEqual({ status: 'existing', release: winner.release })
  })

  it('records a maintenance note for maintenance-only deploys without calling the notes hook', async () => {
    const generateNotes = vi.fn()
    const result = await recordDeployRelease({
      ...base,
      store: createMemoryReleaseStore(),
      commitSha: sha('b'),
      commits: [commit('a', 'chore: bump production version to 1.10.3'), commit('b', 'Merge branch main')],
      generateNotes,
    })
    expect(result.release).toMatchObject({ title: 'Maintenance release', notes: [MAINTENANCE_RELEASE_NOTE] })
    expect(generateNotes).not.toHaveBeenCalled()
  })

  it('uses hook notes, falling back to defaults when the hook fails or times out', async () => {
    const commits = [commit('a', 'feat: Add zoom', 'DevLog-Compat: action-required\nDevLog-Action: Refresh the page.')]
    const generated = await recordDeployRelease({
      ...base, store: createMemoryReleaseStore(), commitSha: sha('a'), commits,
      generateNotes: async ({ defaults }) => ({ title: 'Zoom in on charts', notes: [`${defaults.notes[0]} with a slider.`] }),
    })
    expect(generated.release).toMatchObject({
      title: 'Zoom in on charts', notes: ['Add zoom with a slider.'], compatibility: 'action-required', action: 'Refresh the page.',
    })

    const warnings: string[] = []
    const failed = await recordDeployRelease({
      ...base, store: createMemoryReleaseStore(), commitSha: sha('a'), commits,
      generateNotes: async () => { throw new Error('AI down') },
      onWarning: (message) => warnings.push(message),
    })
    expect(failed.status).toBe('recorded')
    expect(failed.release).toMatchObject({ title: 'Add zoom', notes: ['Add zoom'] })
    expect(warnings).toEqual(['DevLog notes hook failed; using default notes.'])

    const slow = await recordDeployRelease({
      ...base, store: createMemoryReleaseStore(), commitSha: sha('a'), commits,
      generateNotes: () => new Promise(() => {}), generateNotesTimeoutMs: 10,
    })
    expect(slow.release.title).toBe('Add zoom')
  })

  it('falls back to the head commit when the commit source fails', async () => {
    const result = await recordDeployRelease({
      ...base,
      store: createMemoryReleaseStore(),
      commitSha: sha('a'),
      commitSource: async () => { throw new Error('offline') },
      headCommit: { subject: 'Ship billing', authorName: 'Ari Bradshaw', authorLogin: 'aribradshaw' },
      deployment: { provider: 'railway', id: 'dep-1' },
    })
    expect(result.release).toMatchObject({
      title: 'Ship billing',
      includedCommits: [{ sha: sha('a'), subject: 'Ship billing' }],
      author: { name: 'Ari Bradshaw', githubLogin: 'aribradshaw' },
      deployment: { provider: 'railway', id: 'dep-1' },
    })
  })

  it('rejects abbreviated commit SHAs', async () => {
    await expect(recordDeployRelease({ ...base, store: createMemoryReleaseStore(), commitSha: 'abc1234' }))
      .rejects.toThrow(/40-character/)
  })
})

describe('githubCommitRange', () => {
  const payload = (char: string, parent: string, message: string) => ({
    sha: sha(char),
    parents: [{ sha: sha(parent) }],
    author: { login: 'aribradshaw' },
    commit: { message, author: { name: 'Ari Bradshaw' }, committer: { date: '2026-10-05T17:00:00Z' } },
  })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('reads the first-parent chain from the compare API', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => json(200, {
      status: 'ahead',
      commits: [payload('b', 'a', 'Side branch work'), payload('c', 'a', 'Add export\n\nBody'), payload('d', 'c', 'Merge pull request #2\n\nFix colors')],
    }))
    const commits = await githubCommitRange({ owner: 'ex', repo: 'app', from: sha('a'), to: sha('d'), token: 't', fetch: fetcher as typeof fetch })
    expect(commits.map((item) => item.sha)).toEqual([sha('c'), sha('d')])
    expect(commits[0]).toMatchObject({ subject: 'Add export', body: 'Body', authorLogin: 'aribradshaw' })
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://api.github.com/repos/ex/app/compare/${sha('a')}...${sha('d')}?per_page=250`)
  })

  it('falls back to the head commit when from is unknown, diverged, or missing', async () => {
    for (const compare of [json(404, { message: 'Not Found' }), json(200, { status: 'diverged', commits: [] })]) {
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/compare/')
        ? compare.clone()
        : json(200, payload('d', 'c', 'Head only')))
      const commits = await githubCommitRange({ owner: 'ex', repo: 'app', from: sha('9'), to: sha('d'), fetch: fetcher as typeof fetch })
      expect(commits).toEqual([expect.objectContaining({ sha: sha('d'), subject: 'Head only' })])
    }
    const fetcher = vi.fn(async () => json(200, payload('d', 'c', 'Head only')))
    await githubCommitRange({ owner: 'ex', repo: 'app', to: sha('d'), fetch: fetcher as typeof fetch })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('gitCommitRange', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reads a first-parent range and falls back to the head for unknown bases', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devlog-git-'))
    roots.push(root)
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Ari Bradshaw', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'Ari Bradshaw', GIT_COMMITTER_EMAIL: 'a@example.com' },
    }).trim()
    git('init', '-q', '-b', 'main')
    const shas: string[] = []
    for (const subject of ['First', 'Second', 'Third']) {
      await writeFile(path.join(root, 'file.txt'), subject)
      git('add', '.')
      git('commit', '-q', '-m', subject, '-m', `DevLog-Note: ${subject} note`)
      shas.push(git('rev-parse', 'HEAD'))
    }
    const range = await gitCommitRange({ cwd: root, from: shas[0], to: shas[2]! })
    expect(range.map((item) => item.subject)).toEqual(['Second', 'Third'])
    expect(range[0]).toMatchObject({ authorName: 'Ari Bradshaw', body: 'DevLog-Note: Second note' })
    expect((await gitCommitRange({ cwd: root, from: sha('9'), to: shas[2]! })).map((item) => item.sha)).toEqual([shas[2]])
    expect((await gitCommitRange({ cwd: root, from: shas[2], to: shas[0]! })).map((item) => item.sha)).toEqual([shas[0]])
    expect((await gitCommitRange({ cwd: root, to: shas[1]! })).map((item) => item.subject)).toEqual(['Second'])
  })
})

describe('createPostgresReleaseStore', () => {
  type Call = { sql: string; params: unknown[] }
  function fakeQuery(responses: Array<Array<Record<string, unknown>>> = []) {
    const calls: Call[] = []
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return { rows: responses.shift() ?? [] }
    }
    return { calls, query }
  }

  it('validates the interpolated table name', () => {
    const { query } = fakeQuery()
    for (const table of ['releases; DROP TABLE users', 'bad-name', '"quoted"', 'a.b.c', '1abc']) {
      expect(() => createPostgresReleaseStore({ query, table })).toThrow(/Invalid DevLog table name/)
    }
    expect(createPostgresReleaseStore({ query, table: 'public.app_releases' }).table).toBe('public.app_releases')
    expect(createPostgresReleaseStore({ query }).table).toBe('devlog_releases')
  })

  it('creates an idempotent schema with unique version and commit', async () => {
    const { calls, query } = fakeQuery()
    await createPostgresReleaseStore({ query, table: 'app_releases' }).ensureSchema()
    expect(calls[0]!.sql).toMatch(/^CREATE TABLE IF NOT EXISTS app_releases \(/)
    expect(calls[0]!.sql).toMatch(/version text PRIMARY KEY/)
    expect(calls[0]!.sql).toMatch(/commit_sha text NOT NULL UNIQUE/)
    expect(calls[0]!.sql).toMatch(/notes jsonb NOT NULL/)
    expect(calls[0]!.sql).toMatch(/commits jsonb NOT NULL/)
  })

  it('parameterizes inserts and classifies conflicts', async () => {
    const release = (await recordDeployRelease({
      store: createMemoryReleaseStore(), scheme: phoenix, releasedAt: '2026-10-05T17:00:00Z',
      commitSha: sha('a'), commits: [commit('a', "Robert'); DROP TABLE students;--")],
    })).release

    const inserted = fakeQuery([[{ version: release.version }]])
    expect(await createPostgresReleaseStore({ query: inserted.query }).insert(release)).toBe('inserted')
    expect(inserted.calls[0]!.sql).toContain('ON CONFLICT DO NOTHING')
    expect(inserted.calls[0]!.sql).not.toContain('DROP TABLE')
    expect(inserted.calls[0]!.params.slice(0, 5)).toEqual([release.version, sha('a'), release.releasedAt, '2026-10-05', release.title])
    expect(JSON.parse(String(inserted.calls[0]!.params[7]))[0].subject).toBe("Robert'); DROP TABLE students;--")

    const commitConflict = fakeQuery([[], [{ '?column?': 1 }]])
    expect(await createPostgresReleaseStore({ query: commitConflict.query }).insert(release)).toBe('commit-conflict')
    expect(commitConflict.calls[1]).toEqual({ sql: 'SELECT 1 FROM devlog_releases WHERE commit_sha = $1 LIMIT 1', params: [sha('a')] })

    const versionConflict = fakeQuery([[], []])
    expect(await createPostgresReleaseStore({ query: versionConflict.query }).insert(release)).toBe('version-conflict')
  })

  it('maps rows for lookups, latest, and list', async () => {
    const row = {
      version: '1.10.2', commit_sha: sha('b'), released_at: new Date('2026-10-06T17:00:00Z'), release_date: '2026-10-06',
      title: 'Add export', summary: 'Production now includes: Add export.', notes: ['Add export'],
      commits: JSON.stringify([{ sha: sha('b'), subject: 'Add export', committedAt: null }]), source_subject: 'Add export',
      author: { name: 'Ari Bradshaw', githubLogin: 'aribradshaw' }, compatibility: 'compatible', action: null,
      deployment_provider: 'railway', deployment_id: 'dep-2',
    }
    const { calls, query } = fakeQuery([[row], [{ version: '1.10.2', commit_sha: sha('b'), released_at: row.released_at }], [row, { ...row, notes: [] }]])
    const store = createPostgresReleaseStore({ query })
    expect(await store.findByCommit(sha('B'))).toMatchObject({
      version: '1.10.2', releasedAt: '2026-10-06T17:00:00.000Z', includedCommits: [{ sha: sha('b') }],
      deployment: { provider: 'railway', id: 'dep-2' },
    })
    expect(calls[0]!.params).toEqual([sha('b')])
    expect(await store.latest()).toEqual({ version: '1.10.2', commitSha: sha('b'), releasedAt: '2026-10-06T17:00:00.000Z' })
    expect(calls[1]!.sql).toContain("ORDER BY string_to_array(version, '.')::int[] DESC")
    expect(await store.list({ limit: 5000 })).toHaveLength(1)
    expect(calls[2]!.params).toEqual([1000])
  })
})

describe('resolveDevLogDeployContext', () => {
  it('reads Railway deploy metadata', () => {
    expect(resolveDevLogDeployContext({
      RAILWAY_GIT_COMMIT_SHA: sha('A'), RAILWAY_GIT_COMMIT_MESSAGE: 'Add export\n\nDevLog-Note: Export works.',
      RAILWAY_GIT_AUTHOR: 'aribradshaw', RAILWAY_GIT_REPO_OWNER: 'ex', RAILWAY_GIT_REPO_NAME: 'app',
      RAILWAY_GIT_BRANCH: 'main', RAILWAY_DEPLOYMENT_ID: 'dep-1', RAILWAY_ENVIRONMENT_NAME: 'production',
    })).toEqual({
      provider: 'railway', production: true, commitSha: sha('a'), subject: 'Add export', body: 'DevLog-Note: Export works.',
      branch: 'main', author: { name: 'aribradshaw', githubLogin: 'aribradshaw' }, repository: { owner: 'ex', repo: 'app' },
      deployment: { provider: 'railway', id: 'dep-1' },
      headCommit: { subject: 'Add export', body: 'DevLog-Note: Export works.', authorName: 'aribradshaw', authorLogin: 'aribradshaw' },
    })
  })

  it('reads Vercel and GitHub Actions metadata and honors DEVLOG overrides', () => {
    expect(resolveDevLogDeployContext({
      VERCEL_GIT_COMMIT_SHA: sha('b'), VERCEL_GIT_COMMIT_MESSAGE: 'Fix', VERCEL_GIT_COMMIT_AUTHOR_NAME: 'Ari Bradshaw',
      VERCEL_GIT_COMMIT_AUTHOR_LOGIN: 'aribradshaw', VERCEL_GIT_REPO_OWNER: 'ex', VERCEL_GIT_REPO_SLUG: 'web',
      VERCEL_GIT_COMMIT_REF: 'main', VERCEL_DEPLOYMENT_ID: 'dpl_1', VERCEL_ENV: 'preview',
    })).toMatchObject({
      provider: 'vercel', production: false, commitSha: sha('b'), author: { name: 'Ari Bradshaw', githubLogin: 'aribradshaw' },
      repository: { owner: 'ex', repo: 'web' }, deployment: { provider: 'vercel', id: 'dpl_1' },
    })
    expect(resolveDevLogDeployContext({
      GITHUB_ACTIONS: 'true', GITHUB_SHA: sha('c'), GITHUB_REPOSITORY: 'ex/api', GITHUB_REF_NAME: 'main',
      GITHUB_ACTOR: 'aribradshaw', GITHUB_RUN_ID: '42', DEVLOG_PRODUCTION: 'true', DEVLOG_COMMIT_SHA: sha('d'),
      DEVLOG_COMMIT_MESSAGE: 'Override\nBody', DEVLOG_DEPLOYMENT_ID: 'custom',
    })).toMatchObject({
      provider: 'github-actions', production: true, commitSha: sha('d'), subject: 'Override', body: 'Body',
      repository: { owner: 'ex', repo: 'api' }, deployment: { provider: 'github-actions', id: 'custom' },
    })
    expect(resolveDevLogDeployContext({})).toMatchObject({ provider: null, production: false, commitSha: '', deployment: null })
  })
})
