# @aribradshaw/devlog

One DevLog engine, any product design.

`@aribradshaw/devlog` is a headless TypeScript package for software release histories. It shares release types, runtime validation, GitHub author and commit resolution, deployment lifecycle normalization, batched commit links, configurable search, compact pagination, release planning, and calendar versioning without imposing React, a stylesheet, a database, or a public/private access model.

## Why headless

A public game, a newspaper admin panel, and a medical operations platform should not look alike or expose the same metadata. They can still use the same well-tested release behavior.

The package owns portable logic. Each host keeps full control of:

- Rendering and visual styling
- Public or authenticated routing
- JSON, API, database, or build-time storage
- Which fields are safe to expose
- Deployment-provider lifecycle collection
- Project-specific release copy

## Versioning

This package is itself versioned with [Bradshaw Versioning](docs/bradshaw-versioning.md): `YEAR.MONTH.UPDATE` with a one-based project year from 2026 (2026 is year `1`), project-relative months from August 2026 (August is month `0`, resetting to `0` each January), and the America/Phoenix timezone, as computed by `nextCalendarVersion`. `1.3.1` is the first release of November 2026. The numbers are calendar identities, not SemVer: pin an exact version (or review the release notes) rather than relying on a caret range for compatibility.

## Install

```sh
npm install @aribradshaw/devlog
```

## Bradshaw Versioning

[Bradshaw Versioning 1.0 specification](https://github.com/aribradshaw/devlog/blob/main/docs/bradshaw-versioning.md) defines a permanent `YEAR.MONTH.UPDATE` identity for every production commit, with compatibility and deployment status recorded separately. It builds on [Calendar Versioning (CalVer)](https://calver.org/) for continuously shipped, AI-assisted software.

The active convention is used in production projects and allows zero-based or one-based project years, or full calendar years; months are calendar months `1` through `12` or project-relative months that reset each January. DevLog remains versioning-scheme agnostic. Since 1.3.1, `nextBradshawVersion` and the deploy-time recorder below implement the `YEAR.MONTH.UPDATE` numbering; the older `nextCalendarVersion` helper is unchanged. Existing consumers must not migrate implicitly. See the specification's implementation status and migration requirements before adopting it.

```ts
import { nextBradshawVersion } from '@aribradshaw/devlog'

nextBradshawVersion('1.10.7', {
  releaseAt: '2026-11-01T07:00:00Z', // midnight, November 1 in Phoenix
  scheme: { originYear: 2026, yearMode: 'one', timeZone: 'America/Phoenix' },
}) // '1.11.1'
```

## Source metadata

```ts
import { resolveDevLogSourceMeta } from '@aribradshaw/devlog'

const source = resolveDevLogSourceMeta(release, {
  repositoryUrl: 'https://github.com/example/project',
  currentVersion: '1.0.6',
  buildCommit: process.env.GITHUB_SHA,
})
```

Historical entries use their recorded full SHA. The current entry may use the CI build SHA, allowing a release to link to the commit that contains the release itself.

## Public and private policies

```ts
import { createDevLogCapabilities } from '@aribradshaw/devlog'

const publicPolicy = createDevLogCapabilities({ visibility: 'public' })
const privatePolicy = createDevLogCapabilities({
  visibility: 'private',
  lifecycle: true,
  includedCommits: true,
})
```

Every capability can be overridden independently. Policies do not render or transmit data by themselves.

## Search, pagination, and versions

```ts
import {
  filterDevLogEntries,
  nextCalendarVersion,
  paginateDevLogEntries,
} from '@aribradshaw/devlog'

const matches = filterDevLogEntries(entries, 'audio safari')
const page = paginateDevLogEntries(matches, 2, 10)
const next = nextCalendarVersion('1.0.6', {
  latestReleaseDate: '2026-08-19',
  releaseAt: '2026-09-01',
  timeZone: 'America/Phoenix',
})
```

## Validate and select releases

```ts
import {
  resolveCurrentDevLogRelease,
  validateDevLogEntries,
} from '@aribradshaw/devlog'

const releases = validateDevLogEntries(untrustedData, {
  rejectAuthorEmail: true,
  rejectTicketTitle: true,
})

if (!releases) throw new Error('Invalid release history')
const current = resolveCurrentDevLogRelease(releases, deployedVersion)
if (!current.matched) throw new Error('Deployed version is missing from the DevLog')
```

## Lifecycle and batched commits

```ts
import {
  formatDevLogLifecycleLabel,
  resolveDevLogIncludedCommits,
  resolveDevLogLifecycle,
} from '@aribradshaw/devlog'

const lifecycle = resolveDevLogLifecycle({
  buildStartedAt: deployment.startedAt,
  readyAt: deployment.readyAt,
  status: deployment.status,
})

const label = formatDevLogLifecycleLabel(lifecycle, {
  timeZone: 'America/Phoenix',
})
const commits = resolveDevLogIncludedCommits(release, repositoryUrl)
```

## Headless collection model

```ts
import { getDevLogCollection, getDevLogTextSegments } from '@aribradshaw/devlog'

const collection = getDevLogCollection(releases, {
  query: search,
  page,
  pageSize: 10,
})
const titleSegments = getDevLogTextSegments(release.title, collection.terms)
```

The collection model supplies filtered and visible entries, result counts, a clamped current page, visible ranges, and compact pagination items. Text segments can be rendered by any framework.

## Design principle

Import behavior, not appearance. A successful migration should be visually indistinguishable before and after.

## Release alignment

Consumers can fail a build when their application version, latest DevLog entry, and DevLog dependency migration drift apart:

```ts
import { assertDevLogReleaseAlignment } from '@aribradshaw/devlog'

assertDevLogReleaseAlignment({
  currentVersion: packageJson.version,
  latestDevLogVersion: releases[0].version,
  dependencyVersion: packageJson.dependencies['@aribradshaw/devlog'],
  previousVersion,
  previousDependencyVersion,
})
```

The dependency comparison is optional. When previous values are supplied, changing the shared DevLog package without advancing the host application release throws an error.

## Deploy-time releases

Record a DevLog release **when a production deploy starts**, persisted to your database. Nothing is committed back to git: no bot commits, no `chore(release):` loop, no manifest rewrites. This is the model Othello uses.

- One release per successful deploy. A deploy that brings several new commits produces one release whose `includedCommits` lists all of them, oldest first (capped at 250).
- Versions follow Bradshaw Versioning `YEAR.MONTH.UPDATE` with your `originYear`, `yearMode` (`'zero' | 'one' | 'calendar'`), and IANA `timeZone`. UPDATE resets to `1` when the year or month changes.
- Idempotent per commit SHA, so every replica can call it at boot. The store's unique version and commit constraints make concurrent recorders safe: a version conflict retries (bounded), a commit conflict returns the release that won.
- The previous deploy's commit comes from the store's latest release; the range is read with `githubCommitRange` (no `.git` needed at runtime) or `gitCommitRange`. If the previous commit is unknown or not an ancestor, only the head commit is used.
- Commits that only bump versions or merge without a description get the standard maintenance note. Subjects starting with `chore(release):` or `DevLog:` are left out of the notes.
- Commit trailers shape the copy: `DevLog-Note:` (repeatable) replaces that commit's note; `DevLog-Compat: compatible | action-required | breaking` sets compatibility (highest wins); `DevLog-Action:` describes the required step.
- An optional `generateNotes` hook can supply AI-written copy. If it throws, times out, or returns nothing usable, the default notes are used. The deploy never fails because of notes.

Railway + Postgres, at server start (`pg` is your dependency, not DevLog's):

```ts
import pg from 'pg'
import {
  createPostgresReleaseStore,
  githubCommitRange,
  recordDeployRelease,
  resolveDevLogDeployContext,
} from '@aribradshaw/devlog/automation'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
export const releases = createPostgresReleaseStore({
  query: (sql, params) => pool.query(sql, params),
  table: 'devlog_releases',
})

export async function recordReleaseOnBoot() {
  const deploy = resolveDevLogDeployContext() // RAILWAY_GIT_*, VERCEL_GIT_*, GITHUB_*, DEVLOG_*
  if (!deploy.production || !deploy.commitSha) return
  await releases.ensureSchema()
  const { status, release } = await recordDeployRelease({
    store: releases,
    commitSha: deploy.commitSha,
    headCommit: deploy.headCommit,
    deployment: deploy.deployment,
    scheme: { originYear: 2026, yearMode: 'one', timeZone: 'America/Phoenix' },
    baseline: { version: '1.10.4' }, // optional: continue an existing history while the table is empty
    commitSource: deploy.repository
      ? (range) => githubCommitRange({ ...deploy.repository!, ...range, token: process.env.GITHUB_TOKEN })
      : undefined,
    onWarning: (message, error) => console.warn(message, error),
  })
  console.log(`DevLog ${status} ${release.version}`)
}

recordReleaseOnBoot().catch((error) => console.error('DevLog release recording failed', error))
```

Serve history with `releases.list({ limit: 50 })`; each item is a valid `DevLogEntry` with `includedCommits`, `compatibility`, `action`, and `deployment`. `createMemoryReleaseStore()` has the same interface for tests and local development, and any database can implement `DevLogReleaseStore`.

Postgres table (`ensureSchema()` is idempotent):

```sql
CREATE TABLE IF NOT EXISTS devlog_releases (
  version text PRIMARY KEY,               -- YEAR.MONTH.UPDATE
  commit_sha text NOT NULL UNIQUE,        -- full 40-character SHA
  released_at timestamptz NOT NULL,
  release_date text NOT NULL,             -- YYYY-MM-DD in the scheme time zone
  title text NOT NULL,
  summary text,
  notes jsonb NOT NULL,
  commits jsonb NOT NULL DEFAULT '[]',    -- includedCommits
  source_subject text,
  author jsonb,
  compatibility text NOT NULL DEFAULT 'compatible',
  action text,
  deployment_provider text,
  deployment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Bradshaw Versioning's draft numbers every production commit; this recorder deliberately numbers every deploy instead, listing the deployed commits on the release.

## Automatic production releases

Production automation is opt-in. Add `devlog.config.json` to a consuming project:

The CLI and the Node-only programmatic API live at `@aribradshaw/devlog/automation`, keeping the main package entry browser-safe.

```json
{
  "enabled": true,
  "failClosed": true,
  "productionBranches": ["main"],
  "ignoreCommitPrefixes": ["chore(release):"],
  "registryPath": "config/devlog-releases.json",
  "manifestPaths": ["package.json", "package-lock.json"],
  "versionFilePaths": ["src/lib/release.ts"],
  "timeZone": "America/Phoenix",
  "baselineVersion": "1.0.1",
  "author": {
    "name": "Ari Bradshaw",
    "githubLogin": "aribradshaw"
  }
}
```

Set `enabled` to `false` to retain validation and presentation helpers without automatic iteration. When enabled, run the recorder before a production build:

```sh
npx devlog-release prepare --production
npx devlog-release check --production
```

`prepare` performs one idempotent release transaction:

- Requires an approved production branch and a full source commit SHA.
- Reuses a release already recorded for that commit.
- Ignores generated `chore(release):` commits so automation cannot loop.
- Otherwise calculates the next Phoenix-calendar version.
- Updates each configured manifest and prepends the matching DevLog entry.
- Synchronizes explicit source files that embed the previous version.
- Replaces each registry and manifest file atomically.

`check` is the deployment gate. With `failClosed: true`, production cannot continue unless the source commit, newest DevLog entry, and manifest version all match.

The recorder recognizes `DEVLOG_*`, GitHub Actions, Vercel, and Railway commit environment variables. A provider workflow should set `DEVLOG_PRODUCTION=true` explicitly. For GitHub Actions, commit the generated metadata with a bot-only `chore(release):` commit and skip the recorder for that bot commit to prevent a release loop.

This file-based flow writes release metadata back to the repository, which needs a bot commit. If your app has a database, the [deploy-time recorder](#deploy-time-releases) avoids bot commits entirely.

Example GitHub Actions integration:

```yaml
permissions:
  contents: write

jobs:
  release-and-deploy:
    if: github.actor != 'github-actions[bot]'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx devlog-release prepare --production
        env:
          DEVLOG_PRODUCTION: 'true'
          DEVLOG_BRANCH: ${{ github.ref_name }}
          DEVLOG_COMMIT_SHA: ${{ github.sha }}
          DEVLOG_COMMIT_SUBJECT: ${{ github.event.head_commit.message }}
          DEVLOG_AUTHOR_NAME: ${{ github.event.head_commit.author.name }}
      - run: npx devlog-release check --production
        env:
          DEVLOG_PRODUCTION: 'true'
          DEVLOG_BRANCH: ${{ github.ref_name }}
          DEVLOG_COMMIT_SHA: ${{ github.sha }}
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add package.json package-lock.json config/devlog-releases.json
          git diff --cached --quiet || git commit -m "chore(release): publish DevLog"
          git push origin "HEAD:${{ github.ref_name }}"
```

The host still owns release copy, storage, rendering, and deployment. The automation rule only guarantees that an enabled production update cannot silently skip its version and DevLog record.

## License

MIT
