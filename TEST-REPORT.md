# ZMS Live-Site Automated Test Report

**Date:** 2026-09-30T06:10:56.458Z

**Target:** https://mtn-syr.github.io/ZMS/ (deployed main branch — DEVELOPMENT build, cloud = zain-management-tool; live cashappsy.github.io/ZMS keeps test-d371d untouched)

**Method:** fetched the *deployed* index.html + all js/css assets from GitHub Pages and executed them in a jsdom browser sandbox (the app is local-only until cloud sync is enabled, so no production data was touched).

## Verdict

| Result | Count |
|---|---|
| **Passed** | 169 |
| **Failed** | 0 |
| Overall | STABLE & FULLY FUNCTIONAL ✅ |

## Performance

| Metric | Value |
|---|---|
| App boot (store init from live bundle) | 51 ms |
| Mean route render | ~30 ms |
| Slowest route | ~90 ms |
| Repeated renders (12x dashboard) | 0 errors |

## Coverage Highlights

- Deployment integrity: every live asset byte-identical to the committed repo.
- Boot: modules load, zero window errors, bootstrap admin granted.
- Dummy data: departments, people, projects(+subproject), tasks(+subtasks, assignees, custom fields, tags, saved filters).
- Roles: **member** (status-only on assigned tasks, everything else denied), **manager** (own projects, but creates tasks in any pillar and re-statuses any task), **admin** (full).
- Features: all 12 routes (incl. `/meetings`), editors, meetings (tasks + pillars per meeting), task-to-task links, inline person creation, derived progress engine, filters/sort/group, 8+ reports with real status-color donut, activity log, undo/redo, export/import (sanitized), backups, themes (light/dark) + RTL Arabic, cascade delete, persistence after reload.

## Breakdown by section

### A. Deployment integrity (live GitHub Pages vs repo)

| # | Check | Status |
|---|---|---|
| 1 | live index.html reachable (200) | PASS |
| 2 | live index.html == repo index.html (line-endings normalized) | PASS |
| 3 | all 55 live js assets fetched | PASS |
| 4 | live js == committed js (byte-identical, 55/55) | PASS |
| 5 | all 8 live css assets fetched (200) | PASS |
| 6 | live css set matches repo css set | PASS |

### B. App boot from deployed code

| # | Check | Status |
|---|---|---|
| 1 | all 55 scripts evaluated without error | PASS |
| 2 | PMS namespace + core modules present | PASS |
| 3 | PMS.store.init resolves from live bundle (51ms) | PASS |
| 4 | zero window errors during boot | PASS |
| 5 | PMS.network monitor present | PASS |
| 6 | PMS.loadingBox present | PASS |
| 7 | loading box hidden by default | PASS |
| 8 | slow/offline/syncing i18n keys on live bundle | PASS |
| 9 | offline without active cloud keeps box hidden | PASS |
| 10 | offline + active cloud shows offline box | PASS |
| 11 | back online hides offline box | PASS |
| 12 | cloudsync.setCloudEmail present (browser bundle) | PASS |
| 13 | cloud email sync i18n keys on live bundle | PASS |
| 14 | userByPersonId present (browser bundle) | PASS |
| 15 | createMemberAccount + setCloudActive present (browser bundle) | PASS |
| 16 | cloud backend availability probe present (browser bundle) | PASS |
| 17 | PMS.accounts helper present (browser bundle) | PASS |
| 18 | person merge i18n keys on live bundle | PASS |
| 19 | bootstrap admin login works (live auth logic) | PASS |

### C. Dummy data creation (admin)

| # | Check | Status |
|---|---|---|
| 1 | admin session active for seeding | PASS |
| 2 | seed dummy dataset loaded | PASS |
| 3 | dummy people created | PASS |
| 4 | dummy projects + hierarchy created | PASS |
| 5 | dummy tasks + subtask hierarchy created | PASS |
| 6 | custom field + values + saved filter | PASS |

### D.1 Role matrix — MEMBER

| # | Check | Status |
|---|---|---|
| 1 | member account created (role=member) | PASS |
| 2 | member login | PASS |
| 3 | member can(tasks.writeOwn) | PASS |
| 4 | member cannot projects.write | PASS |
| 5 | member cannot settings | PASS |
| 6 | member cannot users.manage | PASS |
| 7 | member cannot data.manage | PASS |
| 8 | member cannot tasks.write | PASS |
| 9 | member canEditTask assigned=true | PASS |
| 10 | member canEditTask unassigned=false | PASS |
| 11 | member canCreateTask any=false | PASS |
| 12 | member canEditProject any=false | PASS |
| 13 | member may open assigned task editor | PASS |
| 14 | member cannot open unassigned task editor (gate + no modal) | PASS |
| 15 | member cannot open project editor | PASS |
| 16 | member cannot create tasks | PASS |
| 17 | member bounced from /settings | PASS |
| 18 | member bounced from /activity | PASS |
| 19 | member gantt is view-only for unassigned | PASS |

### D.2 Role matrix — MANAGER

| # | Check | Status |
|---|---|---|
| 1 | boss re-authenticated for manager setup | PASS |
| 2 | manager account created | PASS |
| 3 | manager promoted via admin | PASS |
| 4 | manager login | PASS |
| 5 | manager can(projects.write) + people.write | PASS |
| 6 | manager cannot settings/users.manage/data.manage | PASS |
| 7 | manager manages own project | PASS |
| 8 | manager canEditProject(own)=true | PASS |
| 9 | manager canEditProject(other)=false | PASS |
| 10 | manager canCreateTask(own)=true | PASS |
| 11 | manager canCreateTask(other)=true (managers own every pillar) | PASS |
| 12 | manager canCreateTask(any)=true | PASS |
| 13 | manager canCreateMeeting=true | PASS |
| 14 | manager canEditProject(new)=true (creates projects) | PASS |
| 15 | manager cannot open project editor of another project | PASS |
| 16 | manager can open own project editor | PASS |
| 17 | manager canChangeStatus unassigned task in own project | PASS |
| 18 | manager canChangeStatus unassigned SUBTASK in own project | PASS |
| 19 | manager canChangeStatus an unassigned task in a foreign pillar | PASS |
| 20 | manager may open status-only editor for own-project task | PASS |

### D.3 Role matrix — ADMIN (full)

| # | Check | Status |
|---|---|---|
| 1 | admin can settings/data/users/projects | PASS |
| 2 | admin canEditProject any + canCreateTask any | PASS |

### E.1 All views render (live bundle, admin, dummy data)

| # | Check | Status |
|---|---|---|
| 1 | route / renders clean | PASS |
| 2 | route /projects renders clean | PASS |
| 3 | route /projects/45f569a5-3365-429e-af44-6d1a5412411f renders clean | PASS |
| 4 | route /tasks renders clean | PASS |
| 5 | route /tasks/kanban renders clean | PASS |
| 6 | route /tasks/gantt renders clean | PASS |
| 7 | route /tasks/calendar renders clean | PASS |
| 8 | route /meetings renders clean | PASS |
| 9 | route /people renders clean | PASS |
| 10 | route /reports renders clean | PASS |
| 11 | route /settings renders clean | PASS |
| 12 | route /activity renders clean | PASS |
| 13 | dashboard includes all chart sections | PASS |

### E.2 Editors open/save for every entity

| # | Check | Status |
|---|---|---|
| 1 | project editor opens | PASS |
| 2 | task editor opens | PASS |
| 3 | person editor opens | PASS |
| 4 | person create editor opens | PASS |
| 5 | task create editor opens | PASS |
| 6 | meeting create editor opens | PASS |
| 7 | task created from a meeting shows up in the meeting | PASS |
| 8 | tasks.link is symmetric | PASS |
| 9 | deleting a meeting keeps its task in the Tasks tab | PASS |
| 10 | repos.tasks.update persists status (logs entry) | PASS |

### E.3 Derived progress engine

| # | Check | Status |
|---|---|---|
| 1 | status-pct engine: todo=0 | PASS |
| 2 | status-pct engine: inprogress=45 | PASS |
| 3 | leaf progress derives from status (done=100) | PASS |
| 4 | parent aggregates children (done+review => 87.5) | PASS |
| 5 | project progress tree aggregation in [0,100] | PASS |
| 6 | pillar weight helpers exposed | PASS |
| 7 | pillar weight i18n keys exist (en) | PASS |

### E.4 Filters / sorting / grouping

| # | Check | Status |
|---|---|---|
| 1 | filter search 'E2E' | PASS |
| 2 | filter status done | PASS |
| 3 | filter lateOnly | PASS |
| 4 | sort by derived progress desc | PASS |
| 5 | groupBy status | PASS |

### E.5 Reports (all defs generate + donut colors)

| # | Check | Status |
|---|---|---|
| 1 | report defs registered | PASS |
| 2 | taskStatus donut uses per-status colors | PASS |
| 3 | all report generators return rows | PASS |
| 4 | export CSV service present | PASS |

### E.6 Global activity log

| # | Check | Status |
|---|---|---|
| 1 | activity records status change | PASS |
| 2 | activity log grows on update | PASS |
| 3 | activity entries carry actor+entity | PASS |

### E.7 Undo / redo

| # | Check | Status |
|---|---|---|
| 1 | undo reverts last change | PASS |
| 2 | redo reapplies | PASS |

### E.8 Export/import + backup

| # | Check | Status |
|---|---|---|
| 1 | toCSV escapes quotes/commas | PASS |
| 2 | export sanitize strips password hashes | PASS |
| 3 | import replace roundtrip | PASS |
| 4 | importJSON merge | PASS |
| 5 | backup create | PASS |
| 6 | backup retention | PASS |
| 7 | backup restore | PASS |
| 8 | backup remove | PASS |
| 9 | activity view admin renders | PASS |

### E.9 Themes + RTL (light & dark, en & ar)

| # | Check | Status |
|---|---|---|
| 1 | RTL dir applied for Arabic | PASS |
| 2 | dark theme attribute applied | PASS |
| 3 | ar + dark renders /tasks | PASS |
| 4 | arabic text visible | PASS |
| 5 | theme back to light | PASS |
| 6 | back to en + light renders /reports | PASS |

### E.9b Pillars cards, nested sub-tasks, meeting summaries (live UI)

| # | Check | Status |
|---|---|---|
| 1 | live /projects renders pillar cards | PASS |
| 2 | live pillars sorted by progress desc | PASS |
| 3 | live pillar cards show an owner chip | PASS |
| 4 | live pillar cards show a progress bar | PASS |
| 5 | live /projects shows the sort hint | PASS |
| 6 | live /tasks nests sub-tasks under their parent | PASS |
| 7 | live sub-task rows are indented | PASS |
| 8 | live parent rows expose a collapse chevron | PASS |
| 9 | live collapsing a parent hides its sub-tasks | PASS |
| 10 | live expanding the parent restores the sub-tasks | PASS |
| 11 | live tasks toolbar has collapse/expand sub-task actions | PASS |
| 12 | live /meetings opens on the All filter | PASS |
| 13 | live All is the first filter option | PASS |
| 14 | live meeting card renders | PASS |
| 15 | live meeting card lists its task compactly | PASS |
| 16 | live meeting card lists its pillar compactly | PASS |
| 17 | live meeting chip opens the linked task | PASS |
| 18 | live meeting card shows the time as HH:MM | PASS |
| 19 | live meeting time field is an hours+minutes input | PASS |
| 20 | live time control normalizes free text | PASS |
| 21 | live meeting cleanup keeps its task | PASS |
| 22 | live /people renders a card per person | PASS |
| 23 | live person card shows name + email + phone | PASS |

### E.9c Blank-screen guard (live bundle)

| # | Check | Status |
|---|---|---|
| 1 | live router survives a throwing view | PASS |
| 2 | live failure is shown in place, not as a blank page | PASS |
| 3 | live failure page offers a retry | PASS |
| 4 | live router recovers on its own | PASS |
| 5 | live blank-screen strings are translated in both languages | PASS |
| 6 | the app still navigates normally afterwards | PASS |

### E.10 Workflow CRUD through UI repos

| # | Check | Status |
|---|---|---|
| 1 | task delete via repos | PASS |
| 2 | project cascade delete removes children + tasks | PASS |

### F. Persistence roundtrip (localStorage survives reload)

| # | Check | Status |
|---|---|---|
| 1 | flush persisted to localStorage (pms-data) | PASS |
| 2 | reload restores full dataset | PASS |

### G. Performance budgets + stability

| # | Check | Status |
|---|---|---|
| 1 | mean route render < 800ms | PASS |
| 2 | worst route render < 2000ms | PASS |
| 3 | 12 rapid alternating view renders stable (0 errors) | PASS |
| 4 | no unhandled promise rejections | PASS |
| 5 | tasks table render reasonable | PASS |

### Z. Final summary

| # | Check | Status |
|---|---|---|
| 1 | ALL CHECKS PASSED — site is stable and fully functional | PASS |
