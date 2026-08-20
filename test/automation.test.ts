import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertProductionDevLogReady,
  recordProductionDevLogRelease,
  resolveDevLogAutomationConfig,
} from '../src/automation'

const temporaryRoots: string[] = []
const firstCommit = 'a'.repeat(40)
const secondCommit = 'b'.repeat(40)

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'devlog-automation-'))
  temporaryRoots.push(root)
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'example', version: '1.0.1', dependencies: { '@example/core': '1.0.1' },
  }, null, 2)}\n`)
  await writeFile(path.join(root, 'core.package.json'), `${JSON.stringify({ name: '@example/core', version: '1.0.1' }, null, 2)}\n`)
  await writeFile(path.join(root, 'version.ts'), "export const VERSION = '1.0.1'\n")
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'example', version: '1.0.1', lockfileVersion: 3, packages: {
      '': { name: 'example', version: '1.0.1', dependencies: { '@example/core': '1.0.1' } },
      core: { name: '@example/core', version: '1.0.1' },
      'node_modules/external': { version: '9.9.9' },
    },
  }, null, 2)}\n`)
  await writeFile(path.join(root, 'releases.json'), `${JSON.stringify([{
    version: '1.0.1', date: '2026-08-18', releasedAt: '2026-08-18T18:00:00.000Z',
    title: 'First', summary: 'First release.', notes: ['First release.'], commit: firstCommit,
  }], null, 2)}\n`)
  return root
}

const config = {
  enabled: true,
  registryPath: 'releases.json',
  manifestPaths: ['package.json', 'core.package.json', 'package-lock.json'],
  versionFilePaths: ['version.ts'],
  productionBranches: ['main'],
  author: { name: 'Ari Bradshaw', githubLogin: 'aribradshaw' },
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('production automation policy', () => {
  it('is opt-in and fail-closed by default', () => {
    expect(resolveDevLogAutomationConfig()).toMatchObject({ enabled: false, failClosed: true })
  })

  it('does nothing when the rule is disabled', async () => {
    const root = await workspace()
    await expect(recordProductionDevLogRelease({ root })).resolves.toMatchObject({ status: 'disabled' })
  })

  it('iterates the version and writes one release for a production commit', async () => {
    const root = await workspace()
    const result = await recordProductionDevLogRelease({
      root,
      config,
      context: {
        production: true,
        branch: 'main',
        commit: secondCommit,
        subject: 'feat: make releases automatic',
        body: 'Every production update records its matching DevLog entry.',
        releasedAt: '2026-08-19T18:00:00.000Z',
      },
    })
    expect(result).toMatchObject({ status: 'created', version: '1.0.2', commit: secondCommit })
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const lockfile = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
    const core = JSON.parse(await readFile(path.join(root, 'core.package.json'), 'utf8'))
    const releases = JSON.parse(await readFile(path.join(root, 'releases.json'), 'utf8'))
    const versionSource = await readFile(path.join(root, 'version.ts'), 'utf8')
    expect(manifest.version).toBe('1.0.2')
    expect(manifest.dependencies['@example/core']).toBe('1.0.2')
    expect(core.version).toBe('1.0.2')
    expect(lockfile.packages[''].version).toBe('1.0.2')
    expect(lockfile.packages[''].dependencies['@example/core']).toBe('1.0.2')
    expect(lockfile.packages.core.version).toBe('1.0.2')
    expect(lockfile.packages['node_modules/external'].version).toBe('9.9.9')
    expect(versionSource).toContain("VERSION = '1.0.2'")
    expect(releases[0]).toMatchObject({
      version: '1.0.2',
      commit: secondCommit,
      title: 'make releases automatic',
      summary: 'Every production update records its matching DevLog entry.',
    })
  })

  it('reuses the same commit without another iteration', async () => {
    const root = await workspace()
    const options = {
      root,
      config,
      context: {
        production: true,
        branch: 'main',
        commit: secondCommit,
        subject: 'Ship once',
        releasedAt: '2026-08-19T18:00:00.000Z',
      },
    }
    await recordProductionDevLogRelease(options)
    await expect(recordProductionDevLogRelease(options)).resolves.toMatchObject({ status: 'reused', version: '1.0.2' })
    await expect(assertProductionDevLogReady(options)).resolves.toMatchObject({ status: 'reused', version: '1.0.2' })
  })

  it('splits provider commit messages into a title and release details', async () => {
    const root = await workspace()
    const result = await recordProductionDevLogRelease({
      root,
      config,
      context: { production: true, branch: 'main', commit: secondCommit, releasedAt: '2026-08-19T18:00:00.000Z' },
      env: {
        DEVLOG_COMMIT_SUBJECT: 'fix: keep the title short\n\nExplain the production behavior clearly.',
      },
    })
    expect(result.release).toMatchObject({
      title: 'keep the title short',
      summary: 'Explain the production behavior clearly.',
    })
  })

  it('ignores generated release commits to prevent an automation loop', async () => {
    const root = await workspace()
    await expect(recordProductionDevLogRelease({
      root,
      config,
      context: {
        production: true,
        branch: 'main',
        commit: secondCommit,
        subject: 'chore(release): publish DevLog',
      },
    })).resolves.toMatchObject({ status: 'skipped' })
  })

  it('fails a production check when release metadata is missing', async () => {
    const root = await workspace()
    await expect(assertProductionDevLogReady({
      root,
      config,
      context: { production: true, branch: 'main', commit: secondCommit },
    })).rejects.toThrow(/not aligned/i)
  })

  it('rejects production recording from an unapproved branch', async () => {
    const root = await workspace()
    await expect(recordProductionDevLogRelease({
      root,
      config,
      context: { production: true, branch: 'feature', commit: secondCommit, subject: 'Nope' },
    })).rejects.toThrow(/not allowed on branch/i)
  })
})
