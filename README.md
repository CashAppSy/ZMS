# Project Manager (PMS)

A complete, offline project-management system built with **pure vanilla HTML/CSS/JavaScript** — no frameworks, no build tools, no npm, no CDN. Open `index.html` by double-clicking it and it runs directly from the filesystem (`file://` protocol).

## Features

- **Bilingual UI (Arabic / English)** with instant language toggle (no reload), full RTL layout switching, and per-field `{ en, ar }` translations.
- **Light / dark themes** applied via `data-theme` CSS variables.
- **Data model**: Departments, People, Projects (unlimited nesting), Tasks (unlimited nesting, checklist, comments, activity log, dependencies), custom fields, statuses, priorities, saved filters.
- **Persistence**: IndexedDB (`pms-db` / `app` / `pms-data`) with automatic `localStorage` fallback; plus optional JSON **file binding** via the File System Access API (Chrome/Edge).
- **Task views**: Table (virtualized for thousands of rows, grouping, sorted columns), Kanban (drag & drop), Gantt (drag bars, dependency arrows), Calendar (month / week).
- **Reports**: a registry of built-in reports (project status, tasks by status/priority/department/person, overdue, workload, estimated-vs-actual hours, budget) rendered as tables + SVG charts, exportable to CSV.
- **Filters**: multi-criteria filter bar (search, project, person, department, statuses, priorities, tags, dates, overdue-only, custom field values) with saved filters.
- **Progress engine**: leaf tasks use their own progress; parents and projects aggregate children (optionally weighted by estimated hours).
- **Export / Import / Backups**: CSV/JSON export, JSON import (merge or replace), manual + automatic in-page backups with retention.
- **Undo / Redo** (snapshots, last 50 edits), **keyboard shortcuts**, **print CSS**, and a demo data generator.

## Project structure

```
index.html                 App shell + script load order (the ONLY page)
css/
  variables.css            Design tokens (colors for light/dark, spacing, radii, fonts)
  base.css                 Reset, typography, base element styles
  layout.css               App shell layout (sidebar, topbar, view root), responsive + RTL-friendly
  components.css           Cards, buttons, badges, chips, inputs, tables, modals, toasts, etc.
  views.css                View-specific styles (gantt, kanban, calendar, settings, reports)
  rtl.css                  RTL adjustments (dir[rtl] overrides; base uses logical properties)
  print.css                Print-friendly output
js/
  core/
    namespace.js           window.PMS singleton guard
    ids.js                 UUID id generator
    utils.js               deepClone, escapeHtml, debounce, date/hour/pct formatting, download, color helpers
    event-bus.js           pub/sub (PMS.bus.emit / PMS.bus.on / PMS.bus.off)
    i18n.js                PMS.i18n.t('dotted.key', {vars}) + lang switching + trilingual({en,ar})
    store.js               PMS.store: single source of truth, commit()/setData(), autosave, undo/redo
    router.js              PMS.router: hash router (#/projects/12?q=...), params + query parsing
    registry.js            PMS.registry: registers views, reports, field types
    app.js                 Bootstrap: sidebar nav, topbar, shortcuts, theme/locale application
  data/
    schema.js              PMS.schema: schema version + default statuses/priorities/settings
    migrations.js          Versioned data migrations (register(from,to,fn))
    storage-idb.js         IndexedDB + localStorage fallback (also persists file handles)
    storage-file.js        PMS.fileStorage: File System Access API binding
    backup.js              In-page backup snapshots + restore + auto-backup
    seed.js                Demo-data generator (Settings -> Load demo data)
    repositories.js        Repository layer: all reads/writes go through here → store.commit()
  services/
    validation.js          Entity validators
    progress.js            Aggregation of task/project progress (weighted option)
    filter-engine.js       Query matching, sorting, grouping
    report-engine.js       Report definitions + runner (registry pattern)
    export.js              CSV/JSON export-import, import validate + merge normalizers (PMS.dataMerge)
  ui/
    dom.js                 h() element builder (like hyperscript)
    modal.js, toast.js, dropdown.js   Overlay components
    form-builder.js        PMS.forms: declarative form schema → rendered form + reader
    table.js               Reusable virtual-scroll table service (PMS.tableService.Table)
    tree.js                Collapsible tree (PMS.treeService.Tree)
    charts.js              SVG charts: donut, hbars, vbars, ring
    format.js              PMS.vformat: status/priority badges, avatars, chips, progress chips
    entity-editors.js      Modals for department / person / project / task (incl. custom fields)
    field-types.js         Custom field type proxy (builds on PMS.forms.buildControl)
    task-detail.js         Task detail modal (progress slider, checklist, comments, activity, deps)
    task-filter.js         Reusable filter bar widget
  views/
    dashboard.js           Route: /
    projects.js            Route: /projects, /projects/:id
    tasks-table.js         Route: /tasks    (table + the task mode switcher helper)
    tasks-kanban.js        Route: /tasks/kanban
    tasks-gantt.js         Route: /tasks/gantt
    tasks-calendar.js      Route: /tasks/calendar
    people.js              Route: /people   (People + Departments tabs)
    reports.js             Route: /reports
    settings.js            Route: /settings (general, statuses, fields, backup, file, about)
  main.js                  Boot: init store → start app
  i18n/
    en.js                  English dictionary (PMS.i18nFiles.en)
    ar.js                  Arabic dictionary (PMS.i18nFiles.ar)
vendor/                    Reserved for future pasted libraries (kept empty — no CDN required)
sample-data/seed.json      Full schema-valid sample dataset compatible with Settings → Import JSON
```

## How to run

1. Double-click `index.html` (open in Chrome/Edge for full features).
2. Fire up demo data: **Settings → File binding → Load demo data**.
3. Persistence is automatic (IndexedDB). Data survives browser restarts.

## Architecture rules

- **Single global namespace** `window.PMS` (`PMS.*`). Every file is an IIFE that reads/writes `PMS`.
- **No ES modules** — load order in `index.html` matters. New scripts must be added in the correct position (core → data → services → ui → views → app/main).
- **All data mutations flow through repositories → `PMS.store.commit(fn, desc)`**. Views never write to storage directly.
- **Exports follow the registered services**: views/reports/field types are registered into `PMS.registry` so nothing is hard-coded in the shell.

## Adding a new view

1. Create `js/views/myview.js`:
   ```js
   (function (PMS) {
     "use strict";
     var h = PMS.dom.h;
     var t = function (k, v) { return PMS.i18n.t(k, v); };
     var view = {
       id: "myview",
       path: "/myview",          // used by the sidebar nav (nav:true only)
       titleKey: "nav.myview",   // must exist in en.js + ar.js
       icon: "★",                // optional
       nav: true,                // false => accessible by route but hidden from sidebar
       render: function (container, params) {
         container.innerHTML = "";
         container.appendChild(h("h1", { text: t("myview.title") }));
         var off = PMS.bus.on("store:changed", function () { view.render(container, params); });
         return function () { off(); };   // cleanup is called when navigating away
       }
     };
     PMS.registry.registerView(view);
     PMS.router.register("/myview", "myview");
   })(window.PMS);
   ```
2. Add `<script src="js/views/myview.js"></script>` to `index.html` *before* `js/core/app.js`.
3. Add the `nav.myview` key to both `js/i18n/en.js` and `js/i18n/ar.js`.
4. Add any page-specific CSS to `css/views.css`.

## Adding a new report

1. In `js/services/report-engine.js` (or a new file that calls `PMS.reports.register`):
   ```js
   PMS.reports.register({
     id: "myReport",
     titleKey: "reports.report_myReport",   // add to both dictionaries
     generate: function (data) {            // data = full store data object
       return {
         description: "...",
         columns: ["name", "count"],
         rows: [ { name: "x", count: 1 } ]
       };
     }
   });
   ```
2. It will automatically appear in the **Reports** view, be renderable as a chart, and exportable to CSV.

## Adding a new custom field type

1. Create a type descriptor `{ key, render(field, value) → { el, getValue() } }` and register it:
   ```js
   PMS.registry.registerFieldType({
     key: "rating",                     // matched by type: "rating"
     labelKey: "settings.fieldTypes.rating",
     render: function (field, value) {
       var input = PMS.dom.h("input.input", { type: "number", min: "1", max: "5" });
       return { el: input, getValue: function () { return input.value || null; } };
     }
   });
   ```
2. Add the label key to both dictionaries. It becomes selectable in **Settings → Custom fields**.

## Adding a new language

1. Duplicate `js/i18n/en.js` into `js/i18n/<code>.js` and translate every string.
2. In `js/core/i18n.js` ensure `<code>` is in the allowed `lang` list (and add it to the language selector in Settings + the topbar toggle logic in `js/core/app.js`).
3. Keep the English keys exactly identical — keys are the contract.

## Persistence & file binding

- IndexedDB keeps the app fully offline; data is saved automatically 300 ms after each change.
- **File binding** (Settings → File binding → Bind to file) links a JSON file on disk; every save also writes to it. The handle persists in IndexedDB and permission is re-requested on load (needs a user gesture).

## Undo / Redo

- Every `store.commit` pushes a snapshot (limit 50). Ctrl+Z / Ctrl+Y (or the topbar buttons) revert/apply. Restoring a backup or importing in "replace" mode resets the undo history.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus the global search |
| `N` | New task |
| `Shift+N` | New project |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |

## Main extension points (cheat sheet)

| Goal | File | Hook |
|------|------|------|
| New view | `js/views/*.js` | `PMS.registry.registerView` + `PMS.router.register` |
| New report | report layer | `PMS.reports.register` |
| New field type | `js/ui/field-types.js` | `PMS.registry.registerFieldType` |
| New entity | `js/data/schema.js` + `js/data/repositories.js` | add collection to schema + repos |
| New migration | `js/data/migrations.js` | `PMS.migrations.register(from, to, fn)` |
| New translation | `js/i18n/*.js` | add keys to both dictionaries |

## Security

This app ships with client-side hardening, but the **real security boundary for shared
cloud data is the Firestore security rules** — client-side checks only protect the UI.

Implemented hardening (`js/`):

- **Admin-gated management**: `updateUser`, `resetPassword`, `removeUser`
  return `forbidden` unless the current session is the admin (or the very first
  bootstrap account is being created). The cloud-account bridge may only sync the
  role of a uid that Firebase Auth just verified. Destructive actions
  (restore, import-replace) additionally re-confirm the admin password.
- **No role input from clients at all**: `createUser` and `signUpWithPassword`
  no longer accept a role — a new account is always `member`, except the very
  first (bootstrap) account. Role changes are admin-only via `updateUser`
  (local) or the `adminSetRole` cloud function (cloud); `setCloudRole` is
  admin-gated, role-validated and routes through the trusted backend first.
- **No public session minting**: the bridge helper (`_adoptBridge`) is internal
  and requires a `cloudUid` matching both the account record and a uid verified
  by a real Firebase Auth result — an id alone can never create a session.
- **Cloud account removal is backend-only**: deleting a shared cloud account runs
  through the `adminDeleteUser` callable; there is no direct browser fallback.
- **Credentials stay local**: password hashes/salts are stripped from JSON exports,
  JSON imports and backup snapshots (existing accounts keep their password; new
  imported accounts need a password reset).
- **Session lifetime**: local sessions expire after 7 days regardless of browser state.
- **CSP**: a Content-Security-Policy meta tag restricts script/frame/object origins.

### Firestore rules — required before shared use

`firestore.rules` (repo root) removes anonymous public access:

- `zms_*` shared dataset + `zms_meta` → read/write require a signed-in user.
- `zms_auth_users/{uid}` → signup writes role `member` only (except the first,
  bootstrap account); role changes and account deletion require an admin.
- `zms_auth/bootstrap` → created once; updates admin-only.

Deploy in the Firebase console (Firestore → Rules → Publish) or with:

```
firebase deploy --only firestore:rules
```

### Trusted backend (Cloud Functions) — OPTIONAL (paid plan)

Role changes and cloud-account deletion never trust the browser. The client
(`js/services/sync-firestore.js`) calls two HTTPS callables **when they are
deployed**:

- `adminSetRole({ uid, role })` — verifies the caller is an admin (reads
  `zms_auth_users/{callerUid}`), validates the target + role, preserves the
  last active admin, then writes the role.
- `adminDeleteUser({ uid })` — same admin check, then deletes the account
  document so it can no longer be adopted on any device.

**Without the functions (free tier — the default here):**

- Role changes **still work**: the client falls back to an admin-gated Firestore
  write, blocked for non-admins by the Firestore rules. The client remembers the
  functions are unavailable, so there is no per-click delay.
- Cloud-account deletion is **refused from the browser**. The free alternative:
  Firebase console → Firestore → `zms_auth_users/<uid>` → delete the document
  (same effect: the account can no longer be adopted on any device).

Deploying the functions requires a **Blaze plan** (Cloud Functions are paid):

```
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```

Notes:

- The current data model keeps each collection in one document, so the rules grant
  data access to every *signed-in* user (the app's shared-account design). True
  per-project/per-task isolation needs the per-record data-model redesign
  (organizations → projects → tasks documents) before this app should host unrelated
  tenants.
- Web Firebase config keys are public: they are not a secret. Restrict real access
  with the rules above + Firebase App Check for production use.