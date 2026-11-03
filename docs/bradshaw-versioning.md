# Bradshaw Versioning 1.0

Author: Ari Bradshaw

Status: Active convention, used in production projects. Implementation conformance is assessed separately.

First published: October 12, 2026

Status updated: November 2, 2026

Bradshaw Versioning gives every production commit a permanent, chronological identity, with compatibility and deployment status made explicit.

It is a calendar-based release convention for continuously shipped software, including software developed by humans and AI agents together. It builds on [Calendar Versioning (CalVer)](https://calver.org/); it does not claim to invent date-based numbering or replace every use of [Semantic Versioning](https://semver.org/).

## 1. Version format and calendar

The format is `YEAR.MONTH.UPDATE`. All fields are integers without leading zeros. The update starts at `1` each month. Each project declares one month mode:

- **Calendar month:** the month is `1` through `12`.
- **Project-relative month:** the month counts from the project's origin month, which is `0`, and resets to `0` each January. A project that starts in August 2026 uses month `0` for August, `3` for November and `0` again for January 2027.

Each project declares one year mode:

| Mode | First calendar year | Following calendar year |
| --- | --- | --- |
| Zero-based project year | `0.MONTH.UPDATE` | `1.MONTH.UPDATE` |
| One-based project year | `1.MONTH.UPDATE` | `2.MONTH.UPDATE` |
| Full calendar year | `2026.MONTH.UPDATE` | `2027.MONTH.UPDATE` |

For project-relative years, record the project's origin calendar year. The year field equals the current calendar year minus that origin year, plus the chosen base (`0` or `1`). It advances each January, not on the project's anniversary. The first project year can therefore be a partial year.

Two-digit calendar-year notation such as `26` for 2026 is not supported. A project-relative year can eventually reach `26`; its declared mode distinguishes that counter from an abbreviated calendar year.

Declare one IANA timezone, such as `America/Phoenix`, for calendar boundaries. Record the year mode, origin year where applicable, and timezone alongside the release registry. Do not silently change them.

For a one-based project launched in October 2026:

```text
1.10.1   First production commit in October 2026
1.10.2   Second production commit in October 2026
1.11.1   First production commit in November 2026
2.1.1    First production commit in January 2027
```

Compare versions numerically by their three fields, not lexicographically. Versions identify chronology within one project and configuration, not relative maturity between projects. A zero-based year does not imply unstable software, and an update increment does not imply a backward-compatible patch.

## 2. Every production commit gets an update number

Every new commit entering the designated production branch receives the next update number, including feature, fix, documentation, and configuration commits. Development-only commits and unmerged pull requests do not advance the production sequence.

- A squash merge introduces one commit and receives one number.
- A merge that introduces multiple previously unrecorded commits assigns each one a number, including the merge commit. Use a stable parent-before-child ordering and record that ordering in the registry.
- A batch deployment identifies the version belonging to its deployed source commit. Intermediate assigned versions need not have been deployed individually.
- A previously recorded commit is not counted again when merged or redeployed.
- Generated metadata-only commits are still commits under this specification. Prefer storing generated release metadata outside the production source branch to avoid a numbering loop. An implementation that excludes such commits must disclose that deviation rather than claim strict conformance.

Use the trusted production-branch admission time, not the author's commit date or the build completion time, to determine the calendar period. Process admission events in order. If an event arrives late after later versions have already been assigned, stop for explicit reconciliation instead of guessing or rewriting existing identities.

Before adoption, declare the baseline production commit and cutover time. Historical commits before that baseline do not need to be retroactively numbered.

## 3. Assignment, deployments, and recovery

Version identity and deployment status are separate.

The production release coordinator must allocate numbers through one atomic, durable registry per project. Independent agents must not calculate and publish competing next versions. Enforce uniqueness for both commit identity and version within that registry, and serialize assignment in admission order.

| Event | Required behavior |
| --- | --- |
| New production commit | Allocate and persist its next version once. |
| Build or deployment failure | Keep the assigned version; record the failed attempt. |
| Retry of the same commit | Reuse its version and create a new deployment-attempt record. |
| Rollback to an existing artifact | Restore that artifact's original version and record a rollback event. |
| New revert commit | Assign a new version, like any other production commit. |
| Concurrent agents or builds | Serialize assignments; retries must not create duplicates. |
| Several commits, one deployment | Preserve every commit's assigned version; identify the deployed source commit and artifact. |

Never reuse an assigned version for different source code. Do not mark a release live merely because it was assigned, committed, or built. Deployment success requires evidence from the target environment. Failed or skipped versions may leave gaps in the list of versions that actually reached production.

Keep the latest assigned version distinct from the currently deployed version for each environment. An older deployment finishing late must not silently replace the expected newer deployment; serialize promotions or validate the intended target before promotion. Explicit rollbacks remain possible.

Each release record includes:

- Version, full source commit SHA, admission timestamp, and assignment sequence.
- Change summary and compatibility classification.
- The recorded calendar configuration or its immutable reference.

Each deployment attempt includes:

- Release version, environment, provider deployment identifier, and timestamps.
- Status and verification evidence where available.
- Exact artifact identifier or digest, plus the rollback target when applicable.

Rebuilding the same commit can produce a different artifact. The source version remains the same, but artifact identity and deployment history must distinguish those builds. Do not overwrite the historical deployment record.

## 4. Compatibility and breaking changes

The number does not promise backward compatibility. Every release declares one of:

| Classification | Meaning |
| --- | --- |
| Compatible | No consumer action is required for supported interfaces. |
| Action required | A documented configuration, migration, or other operational step is required. |
| Breaking | An existing supported interface or behavior no longer works. |

If a release contains several kinds of changes, use the highest-impact classification: breaking, then action required, then compatible. A breaking release must identify the affected interfaces, migration instructions, and rollback limitations. Announce deprecations and removal dates before removal whenever feasible.

Public APIs and SDKs still need explicit compatibility contracts and may retain independent SemVer or API versions. Bradshaw Versioning must not be presented as semantically interchangeable with SemVer just because both can use three numeric fields. In particular, consumers must not treat the update field as a safe SemVer patch range.

## 5. DevLog implementation status and adoption

Bradshaw Versioning is an active convention used in production projects. Adoption is optional, not a requirement for using DevLog. DevLog's presentation and release-history primitives remain usable with other schemes.

This status update changes documentation only. It does not add a Bradshaw configuration option, change `nextCalendarVersion`, migrate host applications, or publish a new npm package release.

Active use of the convention does not imply that every DevLog helper or consumer implements every requirement. The implementation caveats recorded at the October 12, 2026 publication remain separate from the convention's active status:

- `nextCalendarVersion` implements project-relative months: its tests show `1.0.6` becoming `1.1.1` across August to September and `1.4.8` becoming `2.0.1` across December to January. `nextBradshawVersion` implements calendar months.
- The automation documented at publication skips configured generated commit prefixes, including `chore(release):`, unlike the strict every-production-commit rule here.
- Atomic replacement of individual files alone does not establish the durable cross-process assignment coordinator required by this specification.
- Build-time recording of a source commit alone does not establish numbering of every admitted commit in a multi-commit push.
- DevLog 1.3.1 adds `nextBradshawVersion` and a deploy-time recorder (`recordDeployRelease`) that allocate `YEAR.MONTH.UPDATE` through a store with unique version and commit constraints. By owner decision it assigns one version per successful deploy and lists that deploy's commits on the release, rather than numbering every admitted commit, and it omits configured generated-commit prefixes from release notes. Those are disclosed deviations from section 2.

Before implementing or migrating a consumer:

1. Audit its current version rules, registry, CI triggers, production branch, and deployment metadata.
2. Choose and record its year mode, origin year, timezone, baseline commit, and cutover time.
3. Determine whether the proposed next version sorts after all existing versions. If not, design an explicit migration or separate version namespace; do not rewrite history to conceal the collision.
4. Preserve historical identifiers and declare which convention applies to each period. Do not retroactively reinterpret old versions as Bradshaw versions.
5. Test monthly and January rollover, timezone boundaries, inactive months, batch pushes, merge ordering, retries, concurrency, failures, and rollback identity.
6. Verify separately that the live environment exposes the correct version and artifact. Only then claim that consumer's implementation conforms.

Implementations must document their conformance and any deviations independently of the convention's active status. Any later change to these rules should be recorded as a specification revision, with migration guidance where behavior changes.

## References

- [Calendar Versioning](https://calver.org/): the broader family of date-based versioning conventions.
- [Ansible DevTools CalVer](https://docs.ansible.com/projects/team-devtools/guides/calver/): an existing year/month/micro scheme with different patch and rollover rules.
- [Semantic Versioning 2.0.0](https://semver.org/): versioning centered on public API compatibility.
