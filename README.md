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

## Install

```sh
npm install @aribradshaw/devlog
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
