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

The README's older whole-dataset security description is historical. Current rules and sync store projects, tasks, meetings, and activities per record; reference collections still use whole-dataset documents. UI permission checks are not the server authorization boundary.

Passing local tests establishes the checked local behaviors. It does not establish that the hosted website has been deployed, that the deployed rules match this checkout, or that real Firebase authentication, Functions, and multi-device synchronization work. Validate those against a separate development Firebase project before production rollout. Do not run `tests/live-e2e.js` against production during local validation: it audits another hosted build and overwrites `TEST-REPORT.md`.

## Current validation

- Full jsdom suite: 1,036 passed, 0 failed.
- Smoke suite: passed with jsdom.
- Regression suite: 13 passed, covering retry recovery, concurrent saves, storage selection/corruption, reversible history, mutation rollback, listener cleanup, modal access, selective refresh, and mocked signup transactions.
- Chromium: 22 route checks across English/Arabic, all 8 settings sections, backup-refresh loop prevention, task create/update/delete and undo/redo, modal keyboard focus, mobile RTL/LTR sidebar behavior, IndexedDB reload and session persistence passed.
- Frozen dependency reinstall and Git whitespace checks passed.
- Firestore rules emulator: **5 tests passed, 0 failed**, after applying the network allowance for `storage.googleapis.com`. Verified protected profile fields, disabled-account restrictions, administrator assignment/reactivation, member signup restrictions, and atomic first-admin bootstrap against the isolated `demo-zms` emulator.
- Hosted site and real Firebase integration: not deployed or validated by this change.

## Project hierarchy recovery

Project parent links are validated at the repository boundary and the editor excludes the current pillar and its descendants. Loading and importing legacy data detach self-links, cycles, and nonexistent parents without changing record ids or task associations. Startup persists repaired local hierarchy data. This prevents a pillar such as Testing from disappearing from the root-based project tree. Cloud data is not directly rewritten by this repair; deploying the updated client makes loaded data display safely.
