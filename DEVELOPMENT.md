# Development and validation

The browser application remains static: no bundler, runtime npm dependencies, or build step. Development tests use Node 24.12+ (validated on 24.19). Install locked dependencies with:

```sh
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm test
npm run test:smoke
npm run test:regression
npm run test:browser
npm run test:rules
```

The cache argument is useful in the cloud workspace; on other machines it can be omitted. The browser suite needs Chromium at `/usr/bin/chromium`, or set `CHROMIUM_PATH` to its installed executable. It starts and stops its own local HTTP server and browser, disables the embedded Firebase configuration in memory, and uses isolated browser storage. It never writes to the configured real Firebase project.

The rules suite requires Java 21+ and downloads Google's Firestore emulator from `storage.googleapis.com`. It runs against the isolated `demo-zms` project using `firebase.test.json`. Firebase CLI validates the download checksum and size. Do not disable verification. The cloud network policy must allow that domain. Local emulator output and dependency caches are ignored by Git.

For manual local development, run `python3 -m http.server 8000 --bind 127.0.0.1` from the checkout. Use the existing checkout in isolated cloud tasks; do not create a worktree unless requested.

## Responsibilities

- `js/core/history.js`: reversible record edits, record ordering, and affected collection/id metadata.
- `js/core/store.js`: mutation boundary, undo/redo, serialized persistence, and save retry.
- `js/data/storage-idb.js`: local persistence and recovery from the newest primary/fallback copy. Save revisions live in `meta.localSaveRevision`; the dataset keeps its original shape for compatibility with older app builds.
- `js/services/sync-mirror.js`: local tracking of published records, independent of Firebase transport.
- `js/services/sync-firestore.js`: Firebase transport, cloud authentication, and synchronization.
- `js/views/settings-accounts.js`: account-management UI with explicit dependencies on the settings view.

Task/project views ignore unrelated collection changes and preserve input focus and scroll during applicable refreshes. History retains changed records and lightweight ordering lists; commit still examines the dataset, so it does not promise constant-time edits for arbitrarily large datasets.

## Cloud authorization and deployment

`role`, `active`, and `personId` determine authorization and cannot be self-edited. An active user may change their own display name. New member profiles cannot self-assign a person; administrators link accounts to people. A disabled bootstrap owner cannot use the migration write exception.

First-administrator signup creates the admin profile and bootstrap marker in one Firestore transaction. Both documents must agree on the authenticated uid. Deploy the updated client and Firestore rules together after emulator tests pass; the new first-admin transaction is incompatible with an old client that writes the two documents separately. Existing accounts do not need a data migration.

The README's older whole-dataset security description is historical. Current rules and sync store projects, tasks, meetings, subtasks, and activities per record; reference collections still use whole-dataset documents. UI permission checks are not the server authorization boundary.

Passing local tests establishes the checked local behaviors. It does not establish that the hosted website has been deployed, that the deployed rules match this checkout, or that real Firebase authentication, Functions, and multi-device synchronization work. Validate those against a separate development Firebase project before production rollout. Do not run `tests/live-e2e.js` against production during local validation: it audits another hosted build and overwrites `TEST-REPORT.md`.

## Current validation

- Full jsdom suite: 1,036 passed, 0 failed.
- Smoke suite: passed with jsdom.
- Regression suite: 28 passed, including dependency validation and cycle repair, typed milestone gates, cascade cleanup/undo, account invitations, scoped member pulls, concurrent field merges, conflict resolution, slower client clocks, remote deletion conflicts, and edits made during an in-flight write.
- Chromium: 22 route checks across English/Arabic, all 8 settings sections, backup-refresh loop prevention, task create/update/delete and undo/redo, dependency creation/type/lag/search/duplicate and cycle guards, table labels and Gantt arrows on desktop/mobile EN/AR, modal keyboard focus, mobile RTL/LTR sidebar behavior, IndexedDB reload and session persistence passed.
- Frozen dependency reinstall and Git whitespace checks passed.
- Firestore rules emulator: **9 tests passed, 0 failed**, including immutable creator attribution, scoped reads and queries, subtask inheritance, role checks independent of person linkage, signup/profile protections, and atomic first-admin bootstrap.
- Trusted Functions: 3 tests passed on Node 22.23.3 using the actual Functions v1 SDK with a mocked Admin transport. All five deployed callable definitions load on Node 22 against isolated emulator configuration; real authentication identities are not created by these tests.
- Production Functions dependency audit: **0 known vulnerabilities** after updating Firebase Admin/Functions and locking their dependencies.
- Hosted site and real Firebase integration: not deployed or validated by this change.

## Project hierarchy recovery

Project parent links are validated at the repository boundary and the editor excludes the current pillar and its descendants. Loading and importing legacy data detach self-links, cycles, and nonexistent parents without changing record ids or task associations. Startup persists repaired local hierarchy data. This prevents a pillar such as Testing from disappearing from the root-based project tree. Cloud data is not directly rewritten by this repair; deploying the updated client makes loaded data display safely.

## Dependencies

The edited task is the successor: choose the predecessor it waits on. Each predecessor appears once, with a relationship and a whole number of calendar days. Search accepts task names, numbers and pillar names. The picker excludes the edited task and disables duplicate/cyclic choices; the repository rechecks every write, including `setDependency` and new-task creation. Legacy string IDs remain readable as FS with zero lag.

| Type | Meaning | Status gate |
| --- | --- | --- |
| FS | Predecessor finishes before successor starts | Blocks starting until predecessor completes |
| SS | Predecessor starts before successor starts | Blocks starting until predecessor starts |
| FF | Predecessor finishes before successor finishes | Allows starting; blocks completion until predecessor completes |
| SF | Predecessor starts before successor finishes | Allows starting; blocks completion until predecessor starts |

Lag adjusts the **date constraint** and critical-path calculation: positive delays, negative allows overlap. It does not rewrite chosen dates or run an automatic timer for status transitions. A date violation is shown on the dependency/Gantt arrow. Arrows require both tasks to be visible on the chart and dated. Table chips show the predecessor name and open its details. Deleting tasks or pillars removes subtasks and incoming dependency/link references in the same undoable operation.

## Shared-data fixes and rollout

Creator attribution is immutable in Firestore, including its cloud UID. Managers fully edit tasks only in pillars they manage; assignees change status fields only. Being linked to a pillar's manager person does not give a **member** manager privileges. Member task/meeting reads use separate scoped queries for assignment/attendance, creator person and stable creator UID, then deduplicate results. Activity details are readable by managers/admins because they may mention private task titles. Flat subtasks inherit parent-task visibility and sync per record.

Per-record synchronization retains a full last-cloud baseline. Transactions merge edits to different top-level fields; competing edits to the same field and edit/delete conflicts are retained for explicit resolution in an automatic resolution dialog available to all roles after the current editor closes; conflicts also appear in Settings → Cloud sync. Successful writes remain tracked if another write fails. Pushes are serialized, and a newer local edit made during a request survives its completion. Arrays such as dependencies and comments are single fields for conflict detection, rather than guessing how to combine competing list edits. Legacy mirrors upgrade conservatively. Reference collections still use their existing whole-document write policy; these changes do not make those collections a collaborative field editor.

Account creation in Settings uses `adminCreateUser` and a password-reset invitation, preserving the administrator's Firebase session and selected person link. If the invitation fails, use the key/reset-password action beside the new account to retry. If profile creation fails, the function removes its newly created Auth identity. Disabling the last active admin is refused.

Functions now target **Node 22**, use the explicit Functions **v1** API to preserve existing callable contracts, and have their own lockfile. Install their dependencies before testing or deploying:

```sh
npm --prefix functions ci --cache /workspace/.npm-cache --no-audit --no-fund
npm run test:functions
```

Run these with Node 22 for the deployment runtime. The browser test workflow continues using Node 24.12+. Deploy the new client and rules in the same rollout: older clients issue broad member queries that the new rules intentionally reject. Creating managed accounts requires the trusted Functions to be deployed:

```sh
npx firebase deploy --only functions,firestore:rules --project YOUR_PROJECT_ID
```

Publish the static client through the site's existing hosting process and reload clients. No live deployment, production data mutation or real multi-device Firebase test was performed in this workspace.
