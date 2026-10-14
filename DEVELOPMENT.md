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
- Regression suite: 76 passed, including dependency validation and cycle repair, typed milestone gates, cascade cleanup/undo, account invitations, scoped member pulls, concurrent field merges, conflict resolution, slower client clocks, remote deletion conflicts, and edits made during an in-flight write.
- Chromium: 22 route checks across English/Arabic, all 8 settings sections, backup-refresh loop prevention, task create/update/delete and undo/redo, dependency creation/type/lag/search/duplicate and cycle guards, table labels and Gantt arrows on desktop/mobile EN/AR, modal keyboard focus, mobile RTL/LTR sidebar behavior, IndexedDB reload and session persistence passed.
- Frozen dependency reinstall and Git whitespace checks passed.
- Firestore rules emulator: **11 tests passed, 0 failed**, including immutable creator attribution, scoped reads and queries, subtask inheritance, role checks independent of person linkage, signup/profile protections, and atomic first-admin bootstrap.
- Trusted Functions: 3 tests passed on Node 22.23.3 using the actual Functions v1 SDK with a mocked Admin transport. All five deployed callable definitions load on Node 22 against isolated emulator configuration; real authentication identities are not created by these tests.
- Production Functions dependency audit: **0 known vulnerabilities** after updating Firebase Admin/Functions and locking their dependencies.
- Hosted static client: HTTPS HTML/assets and Chromium rendering were verified with production Firebase disabled. Actual authenticated multi-device Firebase data remains unverified.

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

Publish the static client through the site's existing hosting process. Existing users receive versioned client assets on their next normal opening once the new HTML is served. The static client was pushed and its published assets/rendering were verified. No production data mutation or real authenticated multi-device Firebase test was performed in this workspace.

## Compatibility with rules that have not yet been deployed

A permission denial reading the newly added `subtasks` collection must not cancel the task/project pull. The client records that collection as unavailable, keeps its local rows and cloud baseline, and skips its writes while primary tasks continue syncing. Members retain only subtasks of tasks they can read. Once rules permit access, polling retries even when the shared clock is unchanged. Primary collection permission errors and network failures remain hard failures, preserve local data, and appear in the existing save indicator; no toolbar button is added. `Saved` describes local persistence, not proof of a cloud upload.

Subtasks never had a whole-document legacy wrapper, so admin migration does not read `zms_subtasks/data`. Startup performs a merge reconciliation even if the stored clocks match, recovering tasks written before an interrupted push updated the shared clock. Deploy `firestore.rules` in Firebase Console → Firestore Database → Rules → Publish. The compatibility path does not replace deployment of the security rules.
Startup also checks per-record baselines after merging, so unpublished local tasks and offline edits upload even when reconciliation has made the dataset clock equal to the remote clock. Role and field permissions are still enforced by the record writer and Firestore.

## Client asset versions

After editing JavaScript or CSS, run `npm run version:assets` and commit the resulting `index.html` with the changed files. Every local JS/CSS URL includes a SHA-256 content version, so cached files from older releases cannot mask a changed file. This uses native Node APIs and requires no bundler. Run `npm run test:assets` before publishing: it checks all versions against the actual files, then uses Chromium with genuine HTTP caching to verify a normal reopening loads a new release, retains local user data, and keeps unchanged assets cacheable.

The hosting service must serve updated HTML on normal navigation/revalidation (avoid long immutable caching for `index.html`). Versioning does not replace HTML already running in an open tab, force a reload during editing, clear IndexedDB/localStorage, or publish Firebase rules. A tab already open on an older release will use the new code after its next normal opening or reload; a hard refresh is not part of the user workflow.


## Data preservation and cross-user activity review

Reference documents (people, departments, status definitions, priorities, custom fields and saved filters) now use transaction-based three-way merges by record id. Remote additions survive uploads from stale clients. Concurrent edits to different fields combine; overlapping edits and edit/delete collisions create explicit conflicts and retain both versions. Per-record offline deletions remain pending during startup reconciliation instead of being resurrected by a pull.

Activity entries are retained without the former 500-entry truncation. Missing cached rows never cause cloud history deletion; only the existing explicit clear action records the ids the admin chose to remove. New concurrent entries survive that clear. Unpublished offline activity survives newer cloud clocks and uploads at startup even on activity-only clients. Edits made while uploads are in flight retain newer local fields and remote-only fields/additions; unresolved conflicts pause subsequent uploads until explicit resolution. Successful writes are tracked before the shared clock update, and a legacy cleanup probe failure cannot hide successful writes or replay immutable entries. Activity rendering replaces the timeline during account-event refresh, avoiding duplicates. Subtask creation/status edits, comments and checklist changes enter the global timeline; sign-in events use the actual newly authenticated user's name/uid before local session adoption.

The added emulator check verifies activity creation by member, manager and admin, admin enumeration of all three, immutable events, and denied member/anonymous/inactive access. Independent client fixtures verify cross-user propagation. Existing Chromium checks exercise typed dependency fields, signed integer lag, search, duplicate/self/cycle guards, readable chips and Gantt arrows in English/Arabic and on mobile. FS/SS constrain starting; FF/SF constrain finishing. Lag describes calendar constraints and does not automatically reschedule tasks or create a timer.

The supplied 2026-10-11 backup was also exercised outside the checkout with fake IndexedDB: all array lengths and record ids survived normalization/save/load, including 19 pillars, 64 task records (parent and child tasks), 502 activities and 86 account events. Task titles, descriptions, dependency links, comments, checklists and assignees remained intact. The original backup was left untouched and never uploaded to production. This does not compare the backup with the current production database. Direct hosted-site access from this cloud instance returned a proxy 403; no assertion of zero historical production data loss or completed live multi-device verification is made.


## Pending uploads and critical-path presentation

The save indicator separates outstanding cloud writes from successful reads. A successful pull cannot clear a push error while local rows still differ from the cloud baseline. Polling retries pending uploads even when the shared timestamp matches, without requiring a second edit or reopening the app. Poll cycles are serialized. Local storage success remains distinct from cloud confirmation, using the existing indicator and no new button. An independent manager/admin fixture reproduces two manager-created tasks missing from an admin export after an upload failure, then verifies automatic propagation with all 52 existing tasks retained. The emulator also permits a manager to create tasks in another admin's pillar and assign them to that admin.

Critical path requires at least one real dependency edge: a list of unconnected dated tasks does not receive red critical markers or invented slack. Table/Gantt explain why no path is established. Networks with incomplete dates explicitly label their analysis as estimated; cycles have a separate unavailable-analysis notice. Critical Gantt arrows must be binding constraints between critical nodes, rather than merely joining two critical nodes. Calendar validation uses inclusive due dates consistently with CPM durations: FS with zero lag starts on the next day after a predecessor's due date; SF compares the end boundary of the successor's last day with the predecessor's start.

Read-only HTTPS requests confirmed the deployed HTML and sync source matched commit 95e1584 before this correction, reproducing the successful-pull error reset in the hosted source. Network access to cashappsy.github.io became available after the preserved-domain draft update. No production authentication or writes were performed. The two supplied backups retain all original task/pillar/person/department/meeting ids; the newer admin export contains 66 task records, two more than the older export. Four original activity ids are absent from that newer export. A separate recovery copy and comparison report were generated outside the checkout, keeping current tasks, users and settings intact; no automatic restore was performed. User-confirmed manager-only Task Test/Test 4 are absent from the admin export and require reconciliation from the manager's existing local data.

A legacy timestamp-only mirror cannot prove that a record absent from the cloud was deliberately deleted. Such records remain local and create an explicit reconciliation conflict; choosing the local version allows its upload. This protects manager-only tasks from older clients while modern acknowledged snapshots continue to propagate legitimate deletions.

Pending-state detection respects writable fields: harmless normalization of read-only tasks cannot leave a manager permanently awaiting synchronization. Assignee status edits still count as pending. Own-record deletion uses the stable creator UID as well as a linked person, matching Firestore authorization even for unlinked managers.

A full merge reconciliation runs every six hours of active polling, independent of shared-clock equality, and once on startup. Normal remote-clock changes still trigger a merge on the next minute poll. It recovers records successfully written before an interrupted metadata-clock update, even when the sender has restarted and no longer remembers a pending clock. Ordinary polls still check the clock and retry writable local changes.

After publication of the critical-path correction, a fresh isolated Chromium profile rendered the uploaded 66 task records using the hosted HTML/JS/CSS fetched over verified HTTPS. All 70 requested versioned assets (excluding the deliberately disabled cloud config) matched their content hashes. The zero-edge dataset produced zero critical markers and the no-network notice. Production Firebase configuration and every non-GET/external request were blocked. The final published HTML and sync source also matched the committed correction; these checks do not establish arrival of the two real manager-only tasks.


Quota protection (Spark): unchanged clocks no longer trigger a full dataset/history read merely because a previous upload failed. Foreground polling runs once per minute; hidden tabs stop polling. The clock read is reused within a poll. Unchanged reference datasets skip transactions. A resource-exhausted error pauses cloud reads and writes for 30 minutes, persists that deadline across reloads, and keeps pending local edits for automatic retry. It also works in memory if localStorage is unavailable. The SDK may finish requests already in flight before the cooldown takes effect. Existing exhausted daily quota must reset before synchronization can resume; application changes cannot reset Firebase quotas. Full pulls on remote changes and startup still incur document reads, so remaining capacity depends on team activity and dataset size. No billing or production database changes were made.


Incremental sync on Spark: manager/admin uploads now transactionally append bounded change hints to the existing shared metadata document. A foreground client with a contiguous journal cursor fetches only affected record documents (including deletions) and affected reference wrappers. Hints contain collection names and ids, never task descriptions or actor names. History is capped at 20 batches and 180,000 JSON characters; missing, malformed, expired, clock-only member or older-client hints cause a full safe merge. Startup and six-hour reconciliation remain full reads; incremental pulls do not postpone that safety reconciliation. No new collections or rule changes are required. Existing clients that replace metadata remain compatible through the full-pull fallback. A regression with 52 tasks and 502 activities verifies exactly three document reads for one changed task plus one new event, without collection queries. Deletion, conflicts, pending edits, interrupted clock writes and missed windows are covered.

Remote-only merges now retain the remote updatedAt, preventing unchanged receivers from echoing a timestamp-only write. Legacy wrapper deletion requires the corresponding per-record documents to exist in Firestore, rather than merely in local cache. Activity renders in scroll batches of 100 with no extra button; all entries remain available to CSV export and backup. Account-audit refreshes coalesce concurrent requests, cache for one minute, respect quota cooldown and return no cached audit data to non-admins. Scoped member synchronization still uses full authorized queries to preserve privacy when assignments change. Actual daily capacity depends on foreground clients, startup frequency, activity and dataset size; this does not guarantee every workload will fit Spark.
