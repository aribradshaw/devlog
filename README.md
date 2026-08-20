# @aribradshaw/devlog

One DevLog engine, any product design.

`@aribradshaw/devlog` is a headless TypeScript package for software release histories. It shares release types, GitHub author and commit resolution, capability policies, configurable search, compact pagination windows, and calendar versioning without imposing React, a stylesheet, a database, or a public/private access model.

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

## Design principle

Import behavior, not appearance. A successful migration should be visually indistinguishable before and after.

## License

MIT
