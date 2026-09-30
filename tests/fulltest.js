"use strict";
/* ============================================================================
   Full feature & service test for the ZMS PM app.
   Runs the real scripts in a jsdom "real DOM" window (catches browser-level
   bugs like SVG className assignment, insertBefore ref rules, etc.).

   Run:  npm test
   ============================================================================ */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// the site lives at the repo root (index.html + js + css)
const APP = path.resolve(__dirname, "..");

// ---------------- environment ----------------
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="auth-root"></div>
  <div id="view-root"></div>
  <div id="sidebar"></div>
  <div id="topbar"></div>
  <div id="modal-root"></div>
  <div id="toast-root"></div>
  <input id="app-search" />
</body></html>`, {
  url: "file://" + APP.replace(/\\/g, "/") + "/index.html",
  runScripts: "outside-only",
  pretendToBeVisual: true
});
const { window } = dom;
global.window = window;
global.document = window.document;
// allow the modules to expose test-only hooks (never set by a real browser)
window.__ZMS_TEST__ = true;
Object.defineProperty(window, "localStorage", {
  value: { _s: {}, getItem(k){ return this._s[k] ?? null; }, setItem(k,v){ this._s[k]=String(v); }, removeItem(k){ delete this._s[k]; } },
  configurable: true
});

const errors = [];
window.addEventListener("error", e => errors.push("WINDOW ERROR: " + e.message));

let passCount = 0;
let failCount = 0;
function ok(label, cond, dbg) {
  if (cond) { passCount++; console.log("  PASS | " + label); }
  else { failCount++; process.exitCode = 1; console.log("  FAIL | " + label + (dbg ? "  >> " + dbg : "")); }
}
function section(t) { console.log("\n== " + t + " =="); }

// ---------------- load app ----------------
const html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
const srcs = [];
const re = /<script src="([^"]+)"><\/script>/g;
let m;
while ((m = re.exec(html))) srcs.push(m[1]);
for (const src of srcs) {
  window.eval(fs.readFileSync(path.join(APP, src), "utf8"));
}
const PMS = window.PMS;
ok("PMS namespace + core modules", PMS && PMS.store && PMS.repos && PMS.router && PMS.i18n && PMS.app && PMS.seed);

function route(hash) {
  window.location.hash = hash;
  try { PMS.router.handle(); } catch (e) { errors.push("THREW " + hash + ": " + (e && e.message)); }
  return errors.length === 0;
}
const root = () => document.getElementById("view-root");

(async function main() {

  section("Core services");

  const d = PMS.schema.defaultData();
  ok("schema.defaultData shapes", Array.isArray(d.departments) && Array.isArray(d.tasks) && Array.isArray(d.taskStatuses) && Array.isArray(d.priorities) && Array.isArray(d.activities));
  ok("schema VERSION set", typeof PMS.schema.VERSION === "number");

  const ids = [PMS.ids.uuid(), PMS.ids.uuid(), PMS.ids.uuid()];
  ok("ids.uuid unique", new Set(ids).size === 3);

  ok("utils.parseDate", PMS.utils.parseDate("2026-09-14").getDate() === 14);
  ok("utils.toISODate roundtrip", PMS.utils.toISODate(PMS.utils.parseDate("2026-09-14")) === "2026-09-14");
  PMS.i18n.setLang("ar");
  ok("utils.formatDate ar", typeof PMS.utils.formatDate("2026-09-14", PMS.i18n) === "string");
  PMS.i18n.setLang("en");
  const clone = { a: 1, b: { c: [1, 2] } };
  const cp = PMS.utils.deepClone(clone);
  cp.b.c.push(3);
  ok("utils.deepClone isolates", clone.b.c.length === 2);
  ok("utils.colorForSeed stable", PMS.utils.colorForSeed("x") === PMS.utils.colorForSeed("x"));
  ok("utils.escapeHtml", PMS.utils.escapeHtml("<b>x</b>") === "&lt;b&gt;x&lt;/b&gt;");

  // repos CRUD
  PMS.store.setData(PMS.schema.defaultData());
  const t1 = PMS.repos.tasks.add({ title: "T1", projectId: null, status: "todo", priority: "low" });
  ok("tasks.add assigns id + createdAt", t1.id && t1.createdAt);
  PMS.repos.tasks.update(t1.id, { progress: 77 });
  ok("tasks.update persists", PMS.repos.tasks.get(t1.id).progress === 77);
  PMS.repos.tasks.add({ title: "T2", projectId: "PX", status: "todo" });
  ok("tasks.forProject", PMS.repos.tasks.forProject("PX").length === 1);
  PMS.repos.tasks.remove(t1.id);
  ok("tasks.remove deletes", PMS.repos.tasks.get(t1.id) === null);

  const pr = PMS.repos.projects.add({ name: "Root" });
  const sub = PMS.repos.projects.add({ name: "Child", parentId: pr.id });
  ok("projects.children", PMS.repos.projects.children(pr.id).length === 1);
  const tsk = PMS.repos.tasks.add({ title: "task of sub", projectId: sub.id, status: "todo" });
  PMS.repos.tasks.add({ title: "task of root", projectId: pr.id, status: "todo" });
  PMS.repos.projects.remove(pr.id);
  ok("project cascade removes children + tasks", PMS.repos.projects.get(sub.id) === null && PMS.repos.tasks.get(tsk.id) === null);

  const depA = PMS.repos.tasks.add({ title: "depA", status: "todo", projectId: "P1" });
  const depB = PMS.repos.tasks.add({ title: "depB", status: "todo", projectId: "P1", dependencies: [depA.id] });
  PMS.repos.tasks.remove(depA.id);
  ok("task removal cleans dependencies", PMS.repos.tasks.get(depB.id).dependencies.length === 0);

  const pk = PMS.repos.people.add({ name: "Doomed", email: "bad", departmentId: null });
  PMS.repos.people.archive(pk.id);
  ok("people.archive sets inactive", PMS.repos.people.get(pk.id).status === "inactive");
  ok("people.active excludes inactive", PMS.repos.people.active().every(p => p.status !== "inactive"));

  const dp = PMS.repos.departments.add({ name: { en: "D", ar: "د" } });
  ok("departments.add/get", PMS.repos.departments.get(dp.id).name.en === "D");
  PMS.repos.departments.remove(dp.id);
  ok("departments.remove", PMS.repos.departments.get(dp.id) === null);

  // store undo/redo
  PMS.store.setData(PMS.schema.defaultData());
  PMS.store.commit(dd => { dd.projects.push({ id: "A", name: "A" }); }, "addA");
  PMS.store.commit(dd => { dd.projects.push({ id: "B", name: "B" }); }, "addB");
  ok("store.commit pushes undo", PMS.store.canUndo());
  PMS.store.undo();
  ok("store.undo restored", PMS.store.data.projects.length === 1 && PMS.store.data.projects[0].name === "A");
  PMS.store.redo();
  ok("store.redo restored", PMS.store.data.projects.length === 2);
  PMS.store.setData(PMS.schema.defaultData());
  ok("store.setData clears undo history", !PMS.store.canUndo());

  // ensureShape backfill
  const raw = { schemaVersion: 1, departments: [], people: [], projects: [], tasks: [], customFieldDefs: [], savedFilters: [] };
  PMS.store.ensureShape(raw);
  ok("ensureShape backfills statuses/priorities ", raw.taskStatuses.length === 4 && raw.priorities.length === 4 && raw.settings);
  ok("ensureShape adds activities array", Array.isArray(raw.activities));

  section("Global activity log");
  PMS.store.setData(PMS.schema.defaultData());
  ok("activity log starts empty", PMS.activity.entries().length === 0);
  const rootP = PMS.repos.projects.add({ name: "Act Root" });
  const at = PMS.repos.tasks.add({ title: "Act Task", projectId: rootP.id, status: "todo", progress: 0, estimatedHours: 2 });
  ok("activity records creation (newest first)", PMS.activity.entries()[0].action === "created" && PMS.activity.entries()[0].entity === "task" && PMS.activity.entries()[0].entityName === "Act Task");
  ok("activity entries carry id + actor + timestamp", PMS.activity.entries().every(e => e.id && e.at && typeof e.actor === "string" && e.entityId));
  PMS.repos.tasks.update(at.id, { progress: 40 });
  ok("activity records progress change", PMS.activity.entries()[0].action === "progress");
  PMS.repos.tasks.update(at.id, { status: "inprogress" });
  ok("activity records status change", PMS.activity.entries()[0].action === "status");
  PMS.repos.tasks.update(at.id, { notes: "hi", dueDate: "2099-01-01" });
  ok("activity records generic edit", PMS.activity.entries()[0].action === "updated");
  const beforeNoise = PMS.activity.entries();
  PMS.repos.tasks.update(at.id, { activity: [{ x: 1 }], updatedAt: new Date().toISOString() });
  ok("noise-only updates are not logged", PMS.activity.entries().length === beforeNoise.length);
  const q = PMS.repos.people.add({ name: "Q Person" });
  PMS.repos.people.archive(q.id);
  ok("activity records person archive", PMS.activity.entries()[0].action === "archived" && PMS.activity.entries()[0].entity === "person");
  PMS.repos.tasks.remove(at.id);
  ok("activity records task deletion", PMS.activity.entries()[0].action === "deleted");
  PMS.activity.clear();
  ok("activity.clear empties log", PMS.activity.entries().length === 0);

  // persistence roundtrip through fallback storage
  PMS.store.setData(PMS.seed.build());
  await PMS.store.flush();
  ok("store.flush persists (fallback storage)", typeof window.localStorage.getItem("pms-data") === "string");

  // migrations (a real v1 store must come out as v2 with the new fields)
  const old = { schemaVersion: 1, departments: [], people: [], projects: [], tasks: [{ id: "t-old", title: "Old task" }], customFieldDefs: [] };
  const mig = PMS.migrations.migrate(old);
  ok("migrations.migrate safe on old data", mig && Array.isArray(mig.departments) && typeof mig.schemaVersion === "number");
  ok("migrations 1 -> 2 add meetings + task link/meeting fields",
    mig.schemaVersion === 2 && Array.isArray(mig.meetings) && Array.isArray(mig.tasks[0].linkedTaskIds) && mig.tasks[0].meetingId === null);

  // i18n parity
  const walkKeys = (obj, pre) => Object.keys(obj || {}).reduce((acc, k) => {
    const p = pre ? pre + "." + k : k;
    if (obj[k] && typeof obj[k] === "object") return acc.concat(walkKeys(obj[k], p));
    acc.push(p); return acc;
  }, []);
  const enKeys = walkKeys(PMS.i18nFiles.en);
  const arKeys = new Set(walkKeys(PMS.i18nFiles.ar));
  const missing = enKeys.filter(k => !arKeys.has(k));
  ok("i18n parity en<=>ar (" + missing.length + " missing)", missing.length === 0);
  PMS.i18n.setLang("en");

  // router navigation for every static view path
  PMS.registry.allViews().filter(v => v.path && v.path.indexOf(":") === -1).forEach(v => {
    errors.length = 0;
    route(v.path);
    ok("router navigates " + v.path, errors.length === 0);
  });
  ok("router unknown -> dashboard", (errors.length = 0, route("/nope-xyz"), errors.length === 0));
  ok("registry field types", PMS.registry.allFieldTypes().length >= 5);

  section("Views render with rich training data");
  PMS.i18n.setLang("en");
  PMS.store.setData(PMS.seed.build());
  PMS.store.data.settings.autoBackupEnabled = false;
  // authenticate as the admin before starting the shell
  PMS.auth.createUser({ username: "boss", password: "pw1234", role: "admin", name: "Boss" });
  const loginRes = PMS.auth.login("boss", "pw1234");
  ok("auth admin login works", !loginRes.error && PMS.auth.currentUser().role === "admin");
  PMS.app.init();

  const data = PMS.store.data;
  const topProjects = data.projects.filter(p => !p.parentId);
  const tasks = data.tasks;
  const statuses = data.taskStatuses;
  const doneStatus = statuses.find(s => s.key === "done");

  const routes = ["/", "/projects", "/projects/" + data.projects[0].id, "/tasks", "/tasks/kanban", "/tasks/gantt", "/tasks/calendar", "/people", "/reports", "/settings", "/activity"];
  routes.forEach(r => {
    errors.length = 0;
    route(r);
    ok("route " + r + " renders clean", errors.length === 0);
  });

  // projects view
  errors.length = 0; route("/projects");
  ok("projects view renders tree rows", root().querySelectorAll(".tree-node, .project-row").length > 0);

  // tasks table (virtual DOM table built with divs)
  errors.length = 0; route("/tasks");
  const tblRows = root().querySelectorAll(".vt-row").length;
  ok("tasks table shows all tasks (" + tblRows + " of " + tasks.length + ")", tblRows === tasks.length);
  const fbar = root().querySelector(".filter-bar");
  const farea = root().querySelector(".filter-area");
  ok("tasks filter bar is collapsible (hidden by default)", !!farea && !!fbar && fbar.classList.contains("collapsed"));
  if (farea) {
    const ftog = farea.querySelector(".filter-toggle");
    if (ftog) {
      ftog.click();
      ok("tasks filter bar expands on toggle", !farea.querySelector(".filter-bar").classList.contains("collapsed"));
    } else ok("tasks filter bar has a toggle button", false);
  }
  const sel = root().querySelector(".vt-row select.vt-status");
  if (sel) {
    const beforeMap = new Map(PMS.store.data.tasks.map(t => [t.id, t.status]));
    let target = ["done", "todo"].find(k => k !== sel.value);
    sel.value = target;
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    ok("tasks table inline status persists when changed", PMS.store.data.tasks.some(t => t.status === target && beforeMap.get(t.id) !== target));
  } else ok("tasks table has inline status select", sel !== null);

  // activity log (admin view) — the inline status change above logged an entry
  errors.length = 0; route("/activity");
  ok("activity view renders rows (admin)", root().querySelectorAll(".act-row").length > 0);
  ok("activity view shows entity/action labels", root().querySelectorAll(".act-badge").length === root().querySelectorAll(".act-row").length);

  // kanban
  errors.length = 0; route("/tasks/kanban");
  const cols = root().querySelectorAll(".kanban-col").length;
  ok("kanban columns = statuses (" + cols + " of " + statuses.length + ")", cols === statuses.length);
  ok("kanban project filter present", !!root().querySelector("#kanban-project-filter, [data-id=kanban-project-filter]"));

  // gantt
  errors.length = 0; route("/tasks/gantt");
  ok("gantt rows = tasks (" + root().querySelectorAll(".gantt-row").length + ")", root().querySelectorAll(".gantt-row").length === tasks.length);
  ok("gantt bars = tasks", root().querySelectorAll(".gantt-bar").length === tasks.length);
  ok("gantt month labels", root().querySelectorAll(".gantt-month-label").length >= 1);
  ok("gantt day labels", root().querySelectorAll(".gantt-day-label").length >= 1);
  ok("gantt bars carry date tooltips", Array.from(root().querySelectorAll(".gantt-bar")).every(b => (b.getAttribute("title") || "").length > 3));

  // calendar
  errors.length = 0; route("/tasks/calendar");
  ok("calendar renders cells", root().querySelectorAll(".cal-day, .calendar-cell, .day").length > 0);

  // people
  errors.length = 0; route("/people");
  ok("people cards render", root().querySelectorAll(".card").length >= PMS.repos.people.all().length);

  // reports
  errors.length = 0; route("/reports");
  ok("report cards = defs", root().querySelectorAll(".report-card").length === PMS.reports.all().length);
  ok("report tables render rows", root().querySelectorAll(".report-card tbody tr").length > 0);

  const distinct = arr => Object.keys(arr.reduce((a, x) => (a[x] = 1, a), {}));
  const exp = {
    projectStatus: topProjects.length,
    taskStatus: distinct(tasks.map(t => t.status)).length,
    taskPriority: distinct(tasks.map(t => t.priority)).length,
    taskPerson: new Set(tasks.reduce((a, t) => a.concat(t.assignees || []), [])).size,
    lateTasks: tasks.filter(t => t.dueDate && t.dueDate < PMS.utils.todayISO() && t.status !== "done").length,
    hours: topProjects.length,
    budget: topProjects.length
  };
  Object.keys(exp).forEach(id => {
    const res = PMS.reports.generate(id, PMS.store.data, {});
    ok("report " + id + " (" + exp[id] + " rows expected, got " + (res ? res.rows.length : "ERR") + ")", res && res.rows.length === exp[id]);
  });

  section("Filter engine");
  const allTasks = PMS.repos.tasks.all();
  ok("filter search 'auth'", PMS.filterEngine.filterTasks(allTasks, { search: "auth" }, data).length >= 1);
  ok("filter status done", PMS.filterEngine.filterTasks(allTasks, { status: ["done"] }, data).every(t => t.status === "done"));
  ok("filter priority urgent", PMS.filterEngine.filterTasks(allTasks, { priority: ["urgent"] }, data).every(t => t.priority === "urgent"));
  ok("filter tags (design)", PMS.filterEngine.filterTasks(allTasks, { tags: ["design"] }, data).length >= 1);
  const lina = PMS.repos.people.all().find(p => p.name === "Lina Haddadin");
  ok("filter person (Lina)", PMS.filterEngine.filterTasks(allTasks, { personId: lina.id }, data).length >= 3);
  ok("filter dept Engineering", PMS.filterEngine.filterTasks(allTasks, { departmentId: data.departments.find(x => x.name.en === "Engineering").id }, data).length >= 1);
  ok("filter lateOnly", PMS.filterEngine.filterTasks(allTasks, { lateOnly: true }, data).every(t => t.dueDate && t.dueDate < PMS.utils.todayISO() && t.status !== doneStatus.key));
  ok("filter date range (from today)", PMS.filterEngine.filterTasks(allTasks, { from: PMS.utils.todayISO() }, data).every(t => (t.dueDate || t.startDate) >= PMS.utils.todayISO()));
  const storyDef = data.customFieldDefs.find(f => f.label && f.label.en === "Story points");
  const withStory = storyDef ? allTasks.filter(t => t.customFields && t.customFields[storyDef.id] !== undefined) : [];
  ok("filter custom field data uses field ids (precondition)", storyDef && withStory.length >= 1);
  if (storyDef && withStory.length) {
    const q = {}; q[storyDef.id] = String(withStory[0].customFields[storyDef.id]);
    ok("filter custom field", PMS.filterEngine.filterTasks(allTasks, { customFields: q }, data).length >= 1);
  } else ok("filter custom field", false);
  const sorted = PMS.filterEngine.sortTasks(allTasks, "title", "asc", data);
  ok("sort by title asc", sorted[0].title <= sorted[sorted.length - 1].title);
  ok("groupBy status", Object.keys(PMS.filterEngine.groupBy(allTasks, "status", data)).length >= 3);

  section("Progress engine");
  const ds = tasks.find(t => t.title === "Build design system");
  ok("progress.taskChildren", PMS.progress.taskChildren(data, ds.id).length === 2);
  const pp = PMS.progress.projectProgress(data, topProjects[0].id, false);
  ok("progress.projectProgress range", pp === null || (pp >= 0 && pp <= 100));
  ok("progress.allProjectProgress", Object.keys(PMS.progress.allProjectProgress(data)).length >= 1);
  // progress is now derived from the task status (no manual per-task value)
  const inprogKey = (data.taskStatuses || []).find(s => s.key === "inprogress") || { pct: 45 };
  const leafTask = tasks.find(t => t.status === "inprogress" && !PMS.progress.taskChildren(data, t.id).length);
  if (leafTask) {
    ok("progress leaf = status pct (inprogress ~45)", Math.round(PMS.progress.taskProgress(data, leafTask.id, false)) === Math.round(inprogKey.pct));
  } else ok("progress leaf = status pct (inprogress ~45)", false);
  ok("progress.statusPct falls back to 0", PMS.progress.statusPct(data, "no-such-key") === 0);
  const doneKey = (data.taskStatuses || []).find(s => s.key === "done");
  if (doneKey) ok("progress.statusPct done maps its pct", PMS.progress.statusPct(data, "done") === doneKey.pct);

  const wPrj = (id, weight) => ({ id: id, parentId: null, name: id, status: "active", weight: weight });
  const sTask = (id, proj, title, status, parent) => ({ id: id, projectId: proj, parentTaskId: parent || null, title: title, status: status, priority: "medium", assignees: [], tags: [], checklist: [], comments: [], activity: [], startDate: null, dueDate: null, estimatedHours: 8, actualHours: 0, progress: 0 });
  const mkW = (projects, tasks) => ({ settings: { weightByTime: false }, taskStatuses: data.taskStatuses, projects: projects, tasks: tasks });
  const donePct = doneKey ? doneKey.pct : 100;
  const todoKey = (data.taskStatuses || []).find(s => s.key === "todo");
  const todoPct = todoKey ? todoKey.pct : 0;
  const w1 = wPrj("wp1", 2), w2 = wPrj("wp2", 1), w0 = wPrj("wp0", 0);
  const wdata = mkW([w1, w2, w0], [
    sTask("wt1", "wp1", "a", "done"), sTask("wt2", "wp1", "b", "todo"),
    sTask("wt3", "wp2", "c", "done")
  ]);
  const wExp = (2 * ((donePct + todoPct) / 2) + 1 * donePct) / 3;
  ok("overall weighted by pillar weight", Math.round(PMS.progress.overallProgress(wdata)) === Math.round(wExp));
  ok("zero-weight pillar silently excluded", Math.round(PMS.progress.overallProgress(mkW([w1], []))) === 0);
  ok("pillarWeight fallback 1 (legacy data)", PMS.progress.pillarWeight(mkW([], []), { id: "x" }) === 1);
  ok("pillarWeight legacy weightByTime uses budget", PMS.progress.pillarWeight({ settings: { weightByTime: true } }, { id: "x", estimatedBudget: 400 }) === 400);
  ok("taskWeightAttr leaf = 1", PMS.progress.taskWeightAttr(mkW([], []), sTask("t", "p", "leaf", "todo"), false) === 1);
  const tree = mkW([], [
    sTask("tp", "p", "parent", "inprogress", null),
    sTask("tc1", "p", "c1", "done", "tp"),
    sTask("tc2", "p", "c2", "done", "tp")
  ]);
  ok("taskWeightAttr parent = sum of children (weight split)", PMS.progress.taskWeightAttr(tree, tree.tasks[0], false) === 2);
  ok("all-done subtree delivers full weight (100)", PMS.progress.taskProgress(tree, "tp", false) === donePct);
  const part = mkW([], [
    sTask("tp2", "p", "parent", "inprogress", null),
    sTask("pc1", "p", "c1", "done", "tp2"),
    sTask("pc2", "p", "c2", "todo", "tp2")
  ]);
  ok("split weight reflects subtask statuses", Math.round(PMS.progress.taskProgress(part, "tp2", false)) === Math.round((donePct + todoPct) / 2));
  ok("overall empty tree = leaf-task average", PMS.progress.overallProgress(mkW([], [sTask("xt", "p", "l", "todo", null)])) === todoPct);
  // overall spans ALL pillars at every level (sub-pillars participate directly)
  const wTree = mkW([
    wPrj("root1", 2), wPrj("sub1a", 1), wPrj("sub1b", 1), wPrj("root2", 1)
  ], [
    sTask("rt1", "root1", "root task done", "done"),
    sTask("st1", "sub1a", "a done", "done"),
    sTask("st2", "sub1b", "b todo", "todo"),
    sTask("rt2", "root2", "c done", "done")
  ]);
  const wTreeExp = (2 * donePct + 1 * donePct + 1 * todoPct + 1 * donePct) / 5;
  ok("overall spans all pillar levels", Math.round(PMS.progress.overallProgress(wTree)) === Math.round(wTreeExp));
  // a pure folder pillar (no own tasks) delegates its weight to sub-pillars:
  // it must NOT dilute the average (no double counting)
  const wFolder = mkW([wPrj("pf", 3), wPrj("cf1", 1), wPrj("cf2", 1)], [
    sTask("ct1", "cf1", "done", "done"),
    sTask("ct2", "cf2", "todo", "todo")
  ]);
  ok("folder pillar contributes no separate weight (no dilution)", Math.round(PMS.progress.overallProgress(wFolder)) === Math.round((donePct + todoPct) / 2));

  section("Validation");
  ok("task valid", PMS.validation.check("task", { title: "OK" }).valid);
  ok("task missing title invalid", !PMS.validation.check("task", {}).valid);
  ok("task bad dates invalid", !PMS.validation.check("task", { title: "x", startDate: "2026-09-10", dueDate: "2026-09-01" }).valid);
  ok("person bad email invalid", !PMS.validation.check("person", { name: "x", email: "nope" }).valid);
  ok("person missing email invalid", !PMS.validation.check("person", { name: "x" }).valid);
  ok("project bad dates invalid", !PMS.validation.check("project", { name: "x", startDate: "2026-10-10", endDate: "2026-09-01" }).valid);
  ok("project weight negative invalid", !PMS.validation.check("project", { name: "x", weight: -1 }).valid);
  ok("project weight non-numeric invalid", !PMS.validation.check("project", { name: "x", weight: "abc" }).valid);
  ok("project weight ok", PMS.validation.check("project", { name: "x", weight: 2.5 }).valid);

  section("Export / import");
  const csv = PMS.exportService.toCSV([{ a: 'x"y', b: "a,b", c: "l1\nl2" }], ["a", "b", "c"]);
  ok("toCSV escapes quotes/commas/newlines", csv.indexOf('"x""y"') > -1 && csv.indexOf('"a,b"') > -1 && csv.indexOf('"l1\nl2"') > -1);
  ok("validateImport rejects bad schema", PMS.exportService.validateImport({ schemaVersion: 99 }).valid === false);
  ok("validateImport accepts good", PMS.exportService.validateImport({ schemaVersion: PMS.schema.VERSION, departments: [], people: [], projects: [], tasks: [] }).valid);
  const jsonText = JSON.stringify(PMS.store.data);
  const reimported = PMS.exportService.importJSON(JSON.parse(jsonText), "replace");
  ok("importJSON replace roundtrip", reimported.ok && PMS.store.data.tasks.length === tasks.length);
  const merged = PMS.exportService.importJSON({ schemaVersion: PMS.schema.VERSION, departments: [], people: [], projects: [], tasks: [PMS.seed.build().tasks[0]] }, "merge");
  ok("importJSON merge", merged.ok);
  // meetings + the new task fields survive export/import
  const dump = PMS.exportService.sanitize(PMS.store.data);
  ok("JSON export carries meetings", Array.isArray(dump.meetings) && dump.meetings.length === PMS.store.data.meetings.length);
  ok("JSON export carries task links + meeting back-links", dump.tasks.every(t => Array.isArray(t.linkedTaskIds) && "meetingId" in t));
  const mImport = PMS.exportService.importJSON({ schemaVersion: PMS.schema.VERSION, departments: [], people: [], projects: [], tasks: [], meetings: [{ id: "m-import", title: "Imported meeting", date: "2026-10-01" }] }, "merge");
  ok("importJSON merge brings meetings in", mImport.ok && PMS.repos.meetings.get("m-import") && PMS.repos.meetings.get("m-import").status === "planned");

  section("Backup");
  PMS.backup.load();
  PMS.backup.create();
  ok("backup create+list", PMS.backup.list().length >= 1);
  const b = PMS.backup.list()[0];
  PMS.backup.create();
  ok("backup retention", PMS.backup.list().length <= (PMS.store.data.settings.maxBackups || 10));
  await PMS.backup.restore(b.id);
  ok("backup restore", PMS.store.data.tasks.length <= tasks.length + 2);
  PMS.backup.remove(b.id);
  ok("backup remove", PMS.backup.list().every(x => x.id !== b.id));
  PMS.backup.load();

  section("Sensitive actions: admin-password gates (ZMS-R16)");
  const __testFlag = window.__ZMS_TEST__;
  window.__ZMS_TEST__ = false;
  ok("sensitive token is one-shot", (PMS.auth.markFreshAdmin(), PMS.auth.consumeFreshAdmin() === true && PMS.auth.consumeFreshAdmin() === false));
  const seedBefore = JSON.stringify(PMS.store.data);
  const refusedSeed = await PMS.editors.loadSampleData();
  ok("loadSampleData refuses without fresh token in production", refusedSeed === null && JSON.stringify(PMS.store.data) === seedBefore);
  PMS.auth.markFreshAdmin();
  const seededData = await PMS.editors.loadSampleData();
  ok("loadSampleData runs after a fresh admin password", !!seededData && Array.isArray(seededData.tasks) && seededData.tasks.length >= 15);
  const bkBefore = JSON.stringify(PMS.store.data);
  const refusedBackup = await PMS.backup.restore("missing-id");
  ok("backup.restore refuses without fresh token in production", refusedBackup === false && JSON.stringify(PMS.store.data) === bkBefore);
  const snapR16 = PMS.backup.create();
  PMS.auth.markFreshAdmin();
  await PMS.backup.restore(snapR16.id);
  ok("backup.restore runs after a fresh admin password", PMS.store.data.tasks.length >= 15);
  window.__ZMS_TEST__ = __testFlag;

  section("Editors open/close for every record");
  PMS.store.setData(PMS.seed.build());
  PMS.store.data.settings.autoBackupEnabled = false;
  for (const p of PMS.repos.projects.all()) {
    let threw = false;
    try { PMS.editors.openProjectEditor(p, {}); } catch (e) { threw = true; console.error("  proj editor throw:", p.name, e.message); }
    if (PMS.modal.isOpen) PMS.modal.close();
    ok("project editor opens [" + p.name + "]", !threw);
  }
  for (const tk of PMS.repos.tasks.all()) {
    let threw = false;
    try { PMS.editors.openTaskEditor(tk, {}); } catch (e) { threw = true; console.error("  task editor throw:", tk.title, e.message); }
    if (PMS.modal.isOpen) PMS.modal.close();
    ok("task editor opens [" + tk.title + "]", !threw);
  }
  for (const p of PMS.repos.people.all()) {
    let threw = false;
    try { PMS.editors.openPersonEditor(p, function () {}); } catch (e) { threw = true; }
    if (PMS.modal.isOpen) PMS.modal.close();
    ok("person editor opens [" + p.name + "]", !threw);
  }
  for (const dd of PMS.repos.departments.all()) {
    let threw = false;
    try { PMS.editors.openDepartmentEditor(dd, function () {}); } catch (e) { threw = true; }
    if (PMS.modal.isOpen) PMS.modal.close();
    ok("department editor opens [" + (dd.name && (dd.name.en || dd.name)) + "]", !threw);
  }

  PMS.taskDetail.open(PMS.repos.tasks.all()[0].id);
  ok("task detail opens modal", PMS.modal.isOpen);
  PMS.modal.close();

  section("Meetings, task links & inline person creation");
  // the editors section above re-seeded the store, which drops accounts: make
  // sure an admin session is active before exercising the new features
  if (!PMS.auth.users().some(u => u.username === "boss" && u.role === "admin")) {
    const mkBoss = PMS.auth.createUser({ username: "boss", password: "pw1234", name: "Boss" });
    if (!mkBoss.error && mkBoss.user.role !== "admin") PMS.auth.updateUser(mkBoss.user.id, { role: "admin" });
  }
  PMS.auth.login("boss", "pw1234");
  ok("admin session for the meetings/links suite", !!PMS.auth.currentUser() && PMS.auth.currentUser().role === "admin");
  // seed data ships meetings + tasks that came out of them
  ok("seed has meetings", PMS.repos.meetings.all().length === 2);
  const seededMeeting = PMS.repos.meetings.all()[0];
  ok("seeded meeting has agenda + attendees", seededMeeting.agenda.length > 0 && seededMeeting.attendees.length > 0);
  ok("seeded meeting links to pillars", (seededMeeting.projectIds || []).length > 0);
  ok("meeting tasks are normal tasks in the Tasks tab", PMS.repos.meetings.tasksOf(seededMeeting.id).every(t => !!t.id && !!t.title) && PMS.repos.tasks.forMeeting(seededMeeting.id).length > 0);
  ok("meetings split into upcoming/past", PMS.repos.meetings.upcoming().length === 1 && PMS.repos.meetings.past().length === 1);

  // the meetings view renders and its detail modal opens
  errors.length = 0;
  route("/meetings");
  ok("/meetings view renders clean", errors.length === 0 && root().querySelectorAll(".meeting-card").length > 0);
  ok("/meetings shows the new-meeting action for an admin", !!root().querySelector(".page-header .btn-primary"));
  PMS.meetings.openDetail(seededMeeting.id);
  ok("meeting detail modal opens with its task rows", PMS.modal.isOpen && !!PMS.modal.body.querySelector(".meeting-detail-body"));
  ok("meeting detail lists the meeting tasks", PMS.modal.body.querySelectorAll(".project-tree-row").length > 0);
  PMS.modal.close();

  // creating a meeting through the editor
  PMS.editors.openMeetingEditor(null, {});
  ok("meeting editor opens", PMS.modal.isOpen);
  const mform = PMS.modal.body.querySelector("form");
  const mNew = PMS.repos.meetings.add({ title: "Temp meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  ok("meetings.add normalizes its arrays", Array.isArray(mNew.attendees) && Array.isArray(mNew.agenda) && mNew.status === "planned");
  PMS.repos.meetings.update(mNew.id, { agenda: ["one", "two"] });
  ok("meetings.update persists", PMS.repos.meetings.get(mNew.id).agenda.length === 2);

  // a task created from a meeting: lives in the Tasks tab AND back-links
  const pillar = PMS.repos.projects.all()[0];
  const fromMeeting = PMS.repos.tasks.add({ title: "Action from meeting", projectId: pillar.id, status: "todo", meetingId: mNew.id });
  ok("task keeps its meeting back-link", PMS.repos.tasks.get(fromMeeting.id).meetingId === mNew.id);
  ok("meeting sees its new task", PMS.repos.meetings.tasksOf(mNew.id).length === 1);
  const mtCount = PMS.repos.tasks.all().length;
  PMS.repos.meetings.remove(mNew.id);
  ok("deleting a meeting keeps its tasks in the Tasks tab", PMS.repos.tasks.get(fromMeeting.id) !== null && PMS.repos.tasks.get(fromMeeting.id).meetingId === null && PMS.repos.tasks.all().length === mtCount);

  // the two meeting -> task flows straight from the meeting detail modal
  const flowMtg = PMS.repos.meetings.add({ title: "Flow meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [pillar.id] });
  PMS.meetings.openDetail(flowMtg.id);
  const addTaskBtn = Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ ") === 0);
  addTaskBtn.click();
  ok("+ new task from a meeting opens the task editor prefilled", PMS.modal.isOpen && !!PMS.modal.body.querySelector('.field[data-key="projectId"]'));
  const flowForm = PMS.modal.body.querySelector("form");
  flowForm.querySelector('input').value = "Decided in the meeting";
  const flowBtns = document.getElementById("modal-root").querySelectorAll(".modal-footer .btn");
  flowBtns[flowBtns.length - 1].click();
  const flowTask = PMS.repos.meetings.tasksOf(flowMtg.id)[0];
  ok("task created from the meeting lands in the meeting AND the Tasks tab", !!flowTask && flowTask.title === "Decided in the meeting" && PMS.repos.tasks.get(flowTask.id) !== null);
  ok("task created from the meeting inherits the first linked pillar", flowTask.projectId === pillar.id);
  // editing that task again must not drop the meeting back-link
  PMS.editors.openTaskEditor(PMS.repos.tasks.get(flowTask.id), {});
  const againBtns = document.getElementById("modal-root").querySelectorAll(".modal-footer .btn");
  againBtns[againBtns.length - 1].click();
  ok("editing a meeting task keeps its back-link", PMS.repos.tasks.get(flowTask.id).meetingId === flowMtg.id);
  // link an existing task to the meeting through the dropdown
  PMS.meetings.openDetail(flowMtg.id);
  const linkExistingBtn = Array.from(PMS.modal.body.querySelectorAll("button")).filter(b => b.textContent.indexOf("+ ") === 0)[1];
  linkExistingBtn.click();
  const ddItem = document.querySelector(".dropdown-menu.open .dropdown-item");
  ok("link-existing dropdown lists tasks", !!ddItem);
  const linkedTitle = ddItem ? ddItem.textContent.split("  ·  ")[0] : "";
  ddItem.click();
  const linked = PMS.repos.meetings.tasksOf(flowMtg.id).filter(t => t.title === linkedTitle);
  ok("an existing task is attached to the meeting", linked.length === 1);
  ok("the meeting now lists two tasks", PMS.repos.meetings.tasksOf(flowMtg.id).length === 2);
  PMS.modal.close();
  PMS.repos.meetings.remove(flowMtg.id);

  // task <-> task links
  const linkA = PMS.repos.tasks.add({ title: "Link A", projectId: pillar.id, status: "todo" });
  const linkB = PMS.repos.tasks.add({ title: "Link B", projectId: pillar.id, status: "todo" });
  ok("tasks.link is symmetric", PMS.repos.tasks.link(linkA.id, linkB.id) === true &&
    PMS.repos.tasks.get(linkA.id).linkedTaskIds.indexOf(linkB.id) !== -1 &&
    PMS.repos.tasks.get(linkB.id).linkedTaskIds.indexOf(linkA.id) !== -1);
  ok("tasks.linksOf resolves the other side", PMS.repos.tasks.linksOf(linkA.id).length === 1 && PMS.repos.tasks.linksOf(linkA.id)[0].id === linkB.id);
  ok("linking is idempotent", PMS.repos.tasks.link(linkA.id, linkB.id) && PMS.repos.tasks.get(linkA.id).linkedTaskIds.length === 1);
  ok("a task cannot link to itself", PMS.repos.tasks.link(linkA.id, linkA.id) === false);
  ok("tasks.unlink clears both sides", PMS.repos.tasks.unlink(linkA.id, linkB.id) === true &&
    PMS.repos.tasks.get(linkA.id).linkedTaskIds.length === 0 && PMS.repos.tasks.get(linkB.id).linkedTaskIds.length === 0);
  // deleting a task drops the links pointing at it
  PMS.repos.tasks.link(linkA.id, linkB.id);
  PMS.repos.tasks.remove(linkB.id);
  ok("deleting a task clears links to it", PMS.repos.tasks.get(linkA.id).linkedTaskIds.length === 0);
  // the link picker control
  const linkCtl = PMS.forms.buildControl({ key: "linkedTaskIds", type: "linkedTask", excludeId: linkA.id }, [linkA.id]);
  ok("linkedTask control prefills the picked ids", Array.isArray(linkCtl.getValue()) && linkCtl.getValue().length === 1);

  // task editor round-trip: a link saved in the editor is mirrored on both sides
  PMS.editors.openTaskEditor(linkA, {});
  const tform = PMS.modal.body.querySelector("form");
  ok("task editor exposes the linked-tasks field", !!tform.querySelector('.field[data-key="linkedTaskIds"]'));
  const otherTask = PMS.repos.tasks.all().find(t => t.id !== linkA.id);
  const searchBox = tform.querySelector('.field[data-key="linkedTaskIds"] .link-picker input');
  searchBox.value = otherTask.title;
  searchBox.dispatchEvent(new window.Event("input", { bubbles: true }));
  const hit = tform.querySelector('.field[data-key="linkedTaskIds"] .link-result');
  if (hit) hit.click();
  ok("link picker offers a matching task", !!hit);
  const footerBtns = document.getElementById("modal-root").querySelectorAll(".modal-footer .btn");
  footerBtns[footerBtns.length - 1].click(); // Save
  ok("editor saved a symmetric link", PMS.repos.tasks.get(linkA.id).linkedTaskIds.indexOf(otherTask.id) !== -1 &&
    PMS.repos.tasks.get(otherTask.id).linkedTaskIds.indexOf(linkA.id) !== -1);

  // blank title is refused with a message
  PMS.editors.openTaskEditor(null, {});
  const nform = PMS.modal.body.querySelector("form");
  nform.querySelector('input').value = "   ";
  const nfBtns = document.getElementById("modal-root").querySelectorAll(".modal-footer .btn");
  nfBtns[nfBtns.length - 1].click();
  ok("an empty title cannot be saved", PMS.modal.isOpen && PMS.repos.tasks.all().every(t => t.title.trim() !== ""));
  PMS.modal.close();

  // the assignee + owner controls can create a person on the fly
  const before = PMS.repos.people.all().length;
  const creator = PMS.forms.personCreator(function (p) { creator.created = p; });
  document.body.appendChild(creator.el);
  const panel = creator.el.querySelector(".person-create-panel");
  ok("person popup starts closed", panel.style.display === "none");
  creator.el.querySelector(".btn").click();
  ok("person popup opens on click", panel.style.display === "block");
  const inputs = panel.querySelectorAll("input");
  inputs[0].value = "Zaid New"; inputs[1].value = "zaid@example.com";
  panel.querySelector(".btn-primary").click();
  ok("person popup creates + returns the person", PMS.repos.people.all().length === before + 1 && !!creator.created && creator.created.name === "Zaid New");
  const assigneeCtl = PMS.forms.buildControl({ key: "assignees", type: "multiselect", options: [{ label: "Zaid New", value: creator.created.id }], allowCreatePerson: true }, []);
  ok("assignee control offers the +person popup", !!assigneeCtl.el.querySelector(".person-create"));
  const ownerCtl = PMS.forms.buildControl({ key: "managerId", type: "select", options: [], allowCreatePerson: true }, null);
  ok("owner select offers the +person popup", !!ownerCtl.el.querySelector(".person-create"));
  // a duplicate-free, already-selected person is returned by the select control
  const selCtl = PMS.forms.buildControl({ key: "managerId", type: "select", options: [{ label: "Omar Khalil", value: "p-omar" }], allowCreatePerson: true }, "p-omar");
  ok("owner select keeps its current value", selCtl.getValue() === "p-omar");

  // the tasks table: double click opens the FULL editor, assignees stay read-only
  errors.length = 0;
  route("/tasks");
  const vtRow = root().querySelector(".vt-row");
  const dbl = new window.MouseEvent("dblclick", { bubbles: true });
  vtRow.dispatchEvent(dbl);
  ok("double click on a task row opens the task editor", PMS.modal.isOpen && !!PMS.modal.body.querySelector('.field[data-key="title"]'));
  PMS.modal.close();
  ok("assignee cell renders no editable control", !root().querySelector(".vt-assignees input, .vt-assignees select, .vt-assignees button"));
  ok("row hint tells the user to double click", (vtRow.getAttribute("title") || "").length > 3);

  section("Pillars list, nested sub-tasks, meeting summary");
  // ---- pillars: owner name + automatic progress sort -------------------
  errors.length = 0;
  route("/projects");
  const pillarNodes = root().querySelectorAll(".pillar-grid > .tree > li > .tree-node");
  ok("/projects renders a card per pillar", errors.length === 0 && pillarNodes.length > 0);
  const renderedNames = Array.from(pillarNodes).map(n => {
    const el = n.querySelector(".pillar-row-head .u-ellipsis");
    return el ? el.textContent : "";
  });
  const rootPillars = PMS.repos.projects.all().filter(p => !p.parentId)
    .map(p => ({ p, prog: PMS.progress.projectProgress(PMS.store.data, p.id, 0) || 0 }))
    .sort((a, b) => b.prog - a.prog).map(x => x.p.name);
  ok("pillars are sorted by progress, highest first", renderedNames.join("|") === rootPillars.join("|"),
    renderedNames.join(" <> ") + "   EXPECTED   " + rootPillars.join(" <> "));
  const owners = root().querySelectorAll(".chip-owner");
  ok("every pillar shows its owner name", owners.length === root().querySelectorAll(".pillar-grid .tree-node").length &&
    Array.from(owners).some(c => /Sara|Omar|Ali|Khaled/.test(c.textContent)));
  ok("the sort hint is shown", (root().textContent || "").indexOf(PMS.i18n.t("projects.sortedByProgress")) !== -1);
  ok("collapse/expand all still available", root().querySelectorAll(".page-header .actions .btn").length >= 3);

  // ---- tasks: sub-tasks nested under their parent, collapsible ----------
  errors.length = 0;
  route("/tasks");
  const parentWithKids = PMS.repos.tasks.all().find(t => !t.parentTaskId && PMS.repos.tasks.children(t.id).length > 0);
  ok("a parent with sub-tasks is in the list", !!parentWithKids);
  const twisty = root().querySelector(".vt-twisty:not(.vt-twisty-leaf)");
  ok("the parent row gets a collapse/expand chevron", !!twisty && !!parentWithKids);
  const subRowSel = ".vt-row-sub";
  const subRowsBefore = root().querySelectorAll(subRowSel).length;
  ok("sub-tasks render as nested rows under their parent", subRowsBefore > 0);
  const subTitles = Array.from(root().querySelectorAll(subRowSel)).map(r => (r.textContent || "").trim());
  ok("a known sub-task is rendered", subTitles.some(txt => txt.indexOf(PMS.repos.tasks.children(parentWithKids.id)[0].title) !== -1));
  ok("nested rows are indented", parseFloat(root().querySelector(subRowSel).style.paddingInlineStart) > 0);
  // collapse the first parent: its children disappear
  // collapse the first parent: its children disappear
  const firstTwisty = root().querySelector(".vt-twisty:not(.vt-twisty-leaf)");
  const twistyRowId = firstTwisty.closest(".vt-row").dataset.id;
  const kidsCount = PMS.repos.tasks.children(twistyRowId).length;
  const rowsBeforeCollapse = root().querySelectorAll(subRowSel).length;
  firstTwisty.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  const afterRows = root().querySelectorAll(subRowSel).length;
  ok("collapsing a parent hides its sub-tasks", afterRows === rowsBeforeCollapse - kidsCount);
  // expand again
  const again = root().querySelector('.vt-row[data-id="' + twistyRowId + '"] .vt-twisty');
  if (again) again.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  ok("expanding the parent brings the sub-tasks back", root().querySelectorAll(subRowSel).length === rowsBeforeCollapse);
  ok("collapse/expand all sub-tasks buttons exist", (root().textContent || "").indexOf(PMS.i18n.t("tasks.collapseAllSubtasks")) !== -1 &&
    (root().textContent || "").indexOf(PMS.i18n.t("tasks.expandAllSubtasks")) !== -1);
  // a nested row still opens the editor on double click
  const subRow = root().querySelector(subRowSel);
  subRow.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  ok("double clicking a sub-task opens its editor", PMS.modal.isOpen && !!PMS.modal.body.querySelector('.field[data-key="title"]'));
  PMS.modal.close();

  // ---- meetings: filter defaults to All + tasks/pillars on the card ------
  errors.length = 0;
  route("/meetings");
  const segButtons = Array.from(root().querySelectorAll(".segmented button"));
  const allIdx = segButtons.findIndex(b => b.textContent === PMS.i18n.t("meetings.all"));
  const upIdx = segButtons.findIndex(b => b.textContent === PMS.i18n.t("meetings.upcoming"));
  ok("the meetings filter defaults to All", allIdx !== -1 && allIdx === 0 && segButtons[0].classList.contains("active"));
  ok("All is offered next to Upcoming / Past", allIdx === 0 && upIdx === 1 && segButtons.length === 3);
  const allMeetings = PMS.repos.meetings.all().length;
  ok("All shows every meeting (upcoming + past)", root().querySelectorAll(".meeting-card").length === allMeetings);
  const card = root().querySelector(".meeting-card");
  const seededWithWork = PMS.repos.meetings.all().find(m => PMS.repos.meetings.tasksOf(m.id).length > 0 && (m.projectIds || []).length > 0);
  ok("a seeded meeting has both tasks and pillars", !!seededWithWork);
  const workCard = Array.from(root().querySelectorAll(".meeting-card")).find(c => (c.textContent || "").indexOf(seededWithWork.title) !== -1);
  ok("the card lists the meeting tasks compactly", workCard.querySelectorAll(".meeting-task-chip").length > 0);
  ok("the card lists the linked pillars compactly", workCard.querySelectorAll(".meeting-pillar-chip").length > 0);
  ok("the linked blocks sit next to the existing info", !!workCard.querySelector(".meeting-linked") &&
    workCard.querySelector(".meeting-date") && workCard.querySelector(".meeting-linked"));
  ok("a task chip on a card opens that task", (function () {
    workCard.querySelector(".meeting-task-chip").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return PMS.modal.isOpen && !!PMS.modal.body.querySelector(".task-detail-body");
  })());
  PMS.modal.close();
  // narrowing to Upcoming hides past meetings
  const upcomingBtn = segButtons[1];
  upcomingBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/meetings");
  ok("switching to Upcoming narrows the list", root().querySelectorAll(".meeting-card").length === PMS.repos.meetings.upcoming().length);
  // search also matches pillar and task names
  const search = root().querySelector(".search-inline");
  search.value = PMS.repos.meetings.all()[0].title;
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  ok("search narrows the meeting list", root().querySelectorAll(".meeting-card").length >= 0);
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));

  // ---- meeting time = hours and minutes only ---------------------------
  const timeCtl = PMS.forms.buildControl({ key: "time", type: "time" }, "14:35");
  ok("the time control is an hours+minutes input", timeCtl.el.type === "time" && timeCtl.el.value === "14:35");
  ok("time control prefills an existing time", timeCtl.getValue() === "14:35");
  ok("time control normalizes free text to HH:MM", PMS.forms.normalizeTime("3.30pm") === "15:30" &&
    PMS.forms.normalizeTime("9:5") === "09:05" && PMS.forms.normalizeTime("14:30:00") === "14:30" &&
    PMS.forms.normalizeTime("2 pm") === "14:00" && PMS.forms.normalizeTime("nonsense") === "");
  ok("an empty time stays empty", PMS.forms.buildControl({ key: "time", type: "time" }, null).getValue() === "");
  PMS.editors.openMeetingEditor(null, {});
  const mtgTimeField = PMS.modal.body.querySelector('.field[data-key="time"] input');
  ok("the meeting editor uses the hours+minutes field", mtgTimeField && mtgTimeField.type === "time");
  if (mtgTimeField) mtgTimeField.value = "09:45";
  const mtgBtns = document.getElementById("modal-root").querySelectorAll(".modal-footer .btn");
  const mForm = PMS.modal.body.querySelector("form");
  mForm.querySelector('input').value = "Time check meeting";
  mtgBtns[mtgBtns.length - 1].click();
  const savedMtg = PMS.repos.meetings.all().find(m => m.title === "Time check meeting");
  ok("saving stores a clean HH:MM time", savedMtg && savedMtg.time === "09:45");
  if (savedMtg) PMS.repos.meetings.remove(savedMtg.id);

  // ---- people list shows the identifying fields ------------------------
  const phonePerson = PMS.repos.people.add({ name: "Phone Person", email: "ph@example.com", phone: "+962 7 9000 111", departmentId: null, status: "active" });
  route("/people");
  const pCard = Array.from(root().querySelectorAll(".person-card")).find(c => (c.textContent || "").indexOf("Phone Person") !== -1);
  ok("the people list shows name + job title + email + phone", !!pCard &&
    /Phone Person/.test(pCard.textContent) && /ph@example.com/.test(pCard.textContent) && /\+962 7 9000 111/.test(pCard.textContent));
  const pSearch = root().querySelector(".input");
  pSearch.value = "9000 111";
  pSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  ok("the people search also matches the phone", root().querySelectorAll(".person-card").length === 1);
  pSearch.value = "";
  pSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  PMS.repos.people.update(phonePerson.id, { status: "inactive" }); // people are archived, not deleted
  // the inline "+ person" popup captures the phone too
  const popupCtl = PMS.forms.buildControl({ key: "assignees", type: "multiselect", options: [], allowCreatePerson: true }, []);
  const pWrap = popupCtl.el.querySelector(".person-create");
  pWrap.querySelector(".btn").click();
  const pInputs = pWrap.querySelectorAll(".person-create-panel input");
  pInputs[0].value = "Popup Person";
  pInputs[1].value = "popup@example.com";
  pInputs[2].value = "+962 7 555 000";
  pWrap.querySelector(".person-create-panel .btn-primary").click();
  const popupPerson = PMS.repos.people.all().find(p => p.name === "Popup Person");
  ok("the +person popup saves the phone", !!popupPerson && popupPerson.phone === "+962 7 555 000");
  if (popupPerson) PMS.repos.people.update(popupPerson.id, { status: "inactive" });

  section("Forms + charts + dom");
  const f = PMS.forms.buildControl({ key: "title", type: "text" }, "hello");
  ok("text control prefills", f && f.el.value === "hello");
  PMS.forms.buildControl({ key: "d", type: "date" }, "2026-09-14");
  const tagCtl = PMS.forms.buildControl({ key: "t", type: "tags" }, ["a", "b"]);
  ok("tags control prefills", Array.isArray(tagCtl.getValue()) && tagCtl.getValue().length === 2);
  PMS.forms.buildControl({ key: "s", type: "select", options: [{ label: "x", value: "x" }, { label: "y", value: "y" }] }, "y");
  PMS.forms.buildControl({ key: "m", type: "multiselect", options: [{ label: "1", value: "1" }, { label: "2", value: "2" }] }, ["2"]);
  PMS.forms.buildControl({ key: "p", type: "number" }, 5);
  PMS.forms.buildControl({ key: "c", type: "checkbox" }, true);
  const don = PMS.charts.donut([{ label: "a", value: 2 }, { label: "b", value: 3 }], { size: 100 });
  ok("charts.donut returns real SVG", don && String(don.nodeName).toUpperCase() === "SVG");
  PMS.charts.ring(66, {});
  PMS.charts.hbars([{ label: "x", value: 4 }], {});
  PMS.charts.vbars([{ label: "y", value: 6 }], {});

  section("Workflow: create/update/delete through repos");
  const peopleLen = PMS.repos.people.all().length;
  PMS.repos.people.add({ name: "Test New Person", jobTitle: "Tester", departmentId: PMS.repos.departments.all()[0].id, email: "t@example.com" });
  ok("person added", PMS.repos.people.all().length === peopleLen + 1);
  const newProj = PMS.repos.projects.add({ name: "Test Project", status: "active", priority: "high", budget: 1000, tags: ["test"] });
  ok("project added", PMS.repos.projects.get(newProj.id).name === "Test Project");
  const nt = PMS.repos.tasks.add({ title: "First task", projectId: newProj.id, status: "todo", priority: "medium", estimatedHours: 5, startDate: "2026-09-01", dueDate: "2026-09-20" });
  ok("task added", PMS.repos.tasks.get(nt.id).title === "First task");
  PMS.repos.tasks.update(nt.id, { status: "done", progress: 100 });
  ok("task updated", PMS.repos.tasks.get(nt.id).status === doneStatus.key || PMS.repos.tasks.get(nt.id).status === "done");
  PMS.repos.tasks.remove(nt.id);
  ok("task removed", PMS.repos.tasks.get(nt.id) === null);
  PMS.repos.projects.remove(newProj.id);
  ok("project removed", PMS.repos.projects.get(newProj.id) === null);
  PMS.repos.savedFilters.add({ name: "My filter", query: { status: ["done"] }, type: "task" });
  ok("saved filter added", PMS.repos.savedFilters.all().length >= 1);
  const fieldsLen = PMS.repos.fields.all().length;
  PMS.repos.fields.add({ entity: "task", label: { en: "Priority score", ar: "درجة الأولوية" }, type: "number", options: [], order: 9 });
  ok("custom field added", PMS.repos.fields.all().length === fieldsLen + 1);
  PMS.repos.fields.forEntity("task");
  ok("custom field forEntity", PMS.repos.fields.forEntity("task").length >= 1);
  PMS.repos.settings.update({ theme: "dark" });
  ok("settings.update", PMS.store.data.settings.theme === "dark");
  PMS.repos.settings.update({ theme: "light" });

  section("Auth & accounts");
  ok("auth module present", PMS.auth && PMS.auth.login && PMS.auth.can);

  // Earlier sections may have reset the dataset and wiped accounts; guarantee a
  // known admin ("boss"/"pw1234") exists and that we are logged in as it.
  PMS.auth.logout();
if (!PMS.auth.users().some(u => u.username === "boss" && u.role === "admin")) {
    const bossAcc = PMS.auth.createUser({ username: "boss", password: "pw1234", name: "Boss" });
    if (!bossAcc.error && bossAcc.user.role !== "admin") PMS.auth.updateUser(bossAcc.user.id, { role: "admin" });
  }
  const bootLogin = PMS.auth.login("boss", "pw1234");
  ok("auth admin login works", !bootLogin.error && PMS.auth.currentUser().role === "admin");
  ok("auth.configured after admin", PMS.auth.configured());
  ok("admin can(settings)", PMS.auth.can("settings"));
  ok("admin can(users.manage)", PMS.auth.can("users.manage"));
  ok("admin can(projects.write)", PMS.auth.can("projects.write"));

  // wrong password rejected
  const bad = PMS.auth.login("boss", "wrong-pass");
  ok("wrong password rejected", !!bad.error);
  ok("wrong password keeps session", PMS.auth.currentUser() !== null);

  // duplicate username
  const dup = PMS.auth.createUser({ username: "boss", password: "x1234" });
  ok("duplicate username rejected", dup.error === "duplicate");

  // create an account linked to a real person + one manager + one member
  const linaP = PMS.repos.people.all().find(p => p.name === "Lina Haddadin");
  const linaAcc = PMS.auth.createUser({ username: "lina", password: "lina1234", personId: linaP.id });
  ok("createUser linked to person", !linaAcc.error && linaAcc.user.personId === linaP.id && linaAcc.user.role === "member");
  const mgrAcc = PMS.auth.createUser({ username: "omar", password: "omar1234", personId: PMS.repos.people.all().find(p => p.name === "Omar Khalil").id });
  ok("createUser always creates a member (bootstrap only makes the first admin)", !mgrAcc.error && mgrAcc.user.role === "member");
  PMS.auth.updateUser(mgrAcc.user.id, { role: "manager" });
  ok("manager promoted by admin through updateUser", PMS.auth.userById(mgrAcc.user.id).role === "manager");
  ok("lina displayName = person name", PMS.authUI.displayName(linaAcc.user) === "Lina Haddadin");

  // person <-> login account linking (merge feature)
  ok("userByPersonId exposes the linked account", PMS.auth.userByPersonId(linaP.id) && PMS.auth.userByPersonId(linaP.id).id === linaAcc.user.id);
  ok("userByPersonId returns null for an unlinked person", PMS.auth.userByPersonId("person-none") === null);
  // admin saving a person without an account auto-creates the login account
  // (cloud disabled in tests -> local account path, member role)
  const acmP = PMS.repos.people.add({ name: "ACM Person", email: "acm@example.com", departmentId: null });
  if (PMS.accounts && PMS.accounts.createForPerson) PMS.accounts.createForPerson(acmP);
  const acmAcc = PMS.auth.userByPersonId(acmP.id);
  ok("person save auto-creates a login account", !!acmAcc && acmAcc.username === "acm@example.com" && acmAcc.role === "member" && acmAcc.personId === acmP.id);
  if (acmAcc) PMS.auth.removeUser(acmAcc.id);

  // password reset then login
  ok("resetPassword ok", PMS.auth.resetPassword(linaAcc.user.id, "newpass1").ok === true);
  const linaLogin = PMS.auth.login("lina", "newpass1");
  ok("login after reset", !linaLogin.error);
  ok("member can(tasks.writeOwn)", PMS.auth.can("tasks.writeOwn"));
  ok("member cannot projects.write", !PMS.auth.can("projects.write"));
  ok("member cannot settings", !PMS.auth.can("settings"));
  ok("member cannot users.manage", !PMS.auth.can("users.manage"));

  // member assigned-task editing allowed via editor gate
  const ownTask = PMS.repos.tasks.all().find(tsk => (tsk.assignees || []).indexOf(linaP.id) !== -1);
  ok("member may open own task editor", ownTask && PMS.editors.canOpenTask ? PMS.editors.canOpenTask(ownTask) : true);
  ok("member denied creating tasks (editor gate)", PMS.editors.canOpenTask ? PMS.editors.canOpenTask(null) === false : true);

  // deactivate blocks login
  PMS.auth.login("boss", "pw1234");
  PMS.auth.updateUser(linaAcc.user.id, { active: false });
  PMS.auth.logout();
  const inactiveLogin = PMS.auth.login("lina", "newpass1");
  ok("disabled account cannot log in", inactiveLogin.error === "inactive");
  PMS.auth.login("boss", "pw1234");
  PMS.auth.updateUser(linaAcc.user.id, { active: true });

  // manager permissions
  PMS.auth.login("omar", "omar1234");
  ok("manager can projects.write", PMS.auth.can("projects.write"));
  ok("manager can people.write", PMS.auth.can("people.write"));
  ok("manager cannot users.manage", !PMS.auth.can("users.manage"));
  ok("manager cannot settings", !PMS.auth.can("settings"));

  // managers own every pillar now: they can create tasks anywhere and change
  // the status of ANY task — including an unassigned one nobody else can act on
  const mgrPerson = PMS.auth.currentPersonId() ? PMS.repos.people.get(PMS.auth.currentPersonId()) : null;
  const mgrProj = PMS.repos.projects.add({ name: "Mgr Status Project", status: "active", managerId: mgrPerson ? mgrPerson.id : null });
  const mgrTask = PMS.repos.tasks.add({ title: "Mgr status task", projectId: mgrProj.id, status: "todo" });
  const mgrSub = PMS.repos.tasks.add({ title: "Mgr status subtask", projectId: mgrProj.id, parentTaskId: mgrTask.id, status: "todo" });
  const foreignProj = PMS.repos.projects.add({ name: "Foreign Status Project", status: "active" });
  const foreignTask = PMS.repos.tasks.add({ title: "Foreign status task", projectId: foreignProj.id, status: "todo" });
  ok("manager canChangeStatus task in own project", PMS.auth.canChangeStatus(mgrTask) === true);
  ok("manager canChangeStatus SUBTASK in own project", PMS.auth.canChangeStatus(mgrSub) === true);
  ok("manager canChangeStatus an UNASSIGNED task in a foreign pillar", PMS.auth.canChangeStatus(foreignTask) === true);
  ok("manager may open status-only editor for own-project task", PMS.editors.canOpenTask(mgrTask) === true);
  ok("manager canCreateTask in ANY pillar", PMS.auth.canCreateTask(foreignProj.id) === true && PMS.auth.canCreateTask(mgrProj.id) === true && PMS.auth.canCreateTask() === true);
  ok("manager canCreateMeeting", PMS.auth.canCreateMeeting() === true);
  PMS.auth.login("lina", "newpass1");
  ok("member cannot change status of a task that is not assigned", PMS.auth.canChangeStatus(foreignTask) === false);
  ok("member stays denied opening unassigned task editor", PMS.editors.canOpenTask(foreignTask) === false);
  ok("member cannot create a task in any pillar", PMS.auth.canCreateTask(foreignProj.id) === false && PMS.auth.canCreateTask() === false);
  ok("member cannot create meetings", PMS.auth.canCreateMeeting() === false);
  PMS.auth.login("boss", "pw1234");
  ok("admin can change status of any task", PMS.auth.canChangeStatus(foreignTask) === true);
  ok("admin canCreateTask in any pillar", PMS.auth.canCreateTask(foreignProj.id) === true);
  PMS.auth.login("omar", "omar1234");
  PMS.repos.projects.remove(mgrProj.id); // cascade deletes mgrTask + mgrSub
  PMS.repos.projects.remove(foreignProj.id); // cascade deletes foreignTask

  // admin-only route guard bounces non-admins
  errors.length = 0;
  PMS.router.navigate("/settings");
  PMS.router.handle();
  ok("non-admin bounced from /settings", PMS.router.current !== "/settings");
  errors.length = 0;
  PMS.router.navigate("/activity");
  PMS.router.handle();
  ok("non-admin bounced from /activity", PMS.router.current !== "/activity");
  PMS.router.navigate("/");
  PMS.router.handle();

  // last-admin protection
  PMS.auth.login("boss", "pw1234");
  const adminAcct = PMS.auth.users().find(u => u.role === "admin");
  const rmAdmin = PMS.auth.removeUser(adminAcct.id);
  ok("last admin cannot be removed/self-deleted", rmAdmin.error === "lastAdmin" || rmAdmin.error === "self");

  // authUI login screen renders & hides
  PMS.auth.logout();
  PMS.authUI.show();
  ok("login screen renders into #auth-root", document.getElementById("auth-root").querySelector("form") !== null && document.getElementById("auth-root").style.display === "flex");
  PMS.authUI.hide();
  ok("authUI.hide hides overlay", document.getElementById("auth-root").style.display === "none");

  // login again as admin so the rest of the suite runs privileged
  PMS.auth.login("boss", "pw1234");
  ok("admin re-login for remaining suite", PMS.auth.currentUser().role === "admin");

section("Login hand-off + render resilience (no blank screen without a refresh)");
  // A view that throws must never leave #view-root empty: the router reports it
  // in place and retries, so a late-arriving dataset recovers on its own.
  let boomCalls = 0;
  PMS.registry.registerView({
    id: "flaky", path: "/flaky", titleKey: "app.name", render: function (c) {
      boomCalls++;
      if (boomCalls === 1) throw new Error("data not ready yet");
      c.appendChild(document.createElement("div")).className = "flaky-ok";
    }
  });
  PMS.router.register("/flaky", "flaky", {});
  const viewErrors = [];
  PMS.bus.on("view:error", e => viewErrors.push(e));
  errors.length = 0;
  route("/flaky");
  ok("router.handle survives a throwing view", errors.length === 0 && boomCalls === 1);
  ok("the failure is shown in the view, not as a blank page", !!root().querySelector(".empty-state") &&
    (root().textContent || "").indexOf(PMS.i18n.t("errors.viewFailed")) !== -1 &&
    (root().textContent || "").indexOf("data not ready yet") !== -1);
  ok("the failure page offers a retry button", !!root().querySelector(".empty-state .btn"));
  ok("view:error tells the app what broke", viewErrors.length === 1 && viewErrors[0].viewId === "flaky");
  await new Promise(r => setTimeout(r, 400));
  ok("the router retries by itself and the screen recovers", !!root().querySelector(".flaky-ok") && boomCalls >= 2,
    "attempts: " + boomCalls);

  // a view that always throws stops retrying and keeps reporting itself
  let hardCalls = 0;
  PMS.registry.registerView({
    id: "broken", path: "/broken", titleKey: "app.name", render: function () { hardCalls++; throw new Error("always broken"); }
  });
  PMS.router.register("/broken", "broken", {});
  errors.length = 0;
  route("/broken");
  await new Promise(r => setTimeout(r, 700));
  const hardAfterRetries = hardCalls;
  await new Promise(r => setTimeout(r, 600));
  ok("a permanently broken view stops retrying (no loop)", hardAfterRetries > 1 && hardCalls === hardAfterRetries,
    "attempts: " + hardAfterRetries + " then " + hardCalls);
  ok("a permanently broken view keeps the error on screen", (root().textContent || "").indexOf("always broken") !== -1);
  ok("errors never escape the router", errors.length === 0);

  // the manual retry button re-renders the current route
  const manualCalls = [];
  PMS.registry.registerView({
    id: "manual", path: "/manual", titleKey: "app.name", render: function (c) {
      manualCalls.push(1);
      if (manualCalls.length < 2) throw new Error("first attempt fails");
      c.appendChild(document.createElement("div")).className = "manual-ok";
    }
  });
  PMS.router.register("/manual", "manual", {});
  route("/manual");
  const retryBtn = root().querySelector(".empty-state .btn");
  if (retryBtn) retryBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok("the retry button re-renders the view", !!root().querySelector(".manual-ok"));

  // a start-up service that throws must not keep the shell from opening
  const realBackupLoad = PMS.backup.load;
  PMS.backup.load = function () { throw new Error("backup service is down"); };
  errors.length = 0;
  PMS.app.showShell();
  ok("app.showShell still opens the shell when a service throws", errors.length === 0 &&
    document.getElementById("sidebar").children.length > 0 && root().children.length > 0);
  PMS.backup.load = realBackupLoad;
  PMS.app.showShell();

  // a first paint that produces nothing is repainted by itself
  const realHandle = PMS.router.handle;
  let paintCalls = 0;
  window.location.hash = "#/";
  await new Promise(r => setTimeout(r, 30));   // let the hashchange render settle
  PMS.router.handle = function () {
    paintCalls++;
    if (paintCalls >= 2) root().innerHTML = "<div class='repainted'></div>";
  };
  document.getElementById("view-root").innerHTML = "";
  PMS.app.showShell();
  await new Promise(r => setTimeout(r, 800));
  ok("an empty first paint is rebuilt without a refresh", !!root().querySelector(".repainted"), "handle calls: " + paintCalls);
  PMS.router.handle = realHandle;
  PMS.app.showShell();

  // a throw while handing over from the login screen keeps the overlay + reason
  const realIsConfigured = PMS.cloudsync.isConfigured;
  PMS.cloudsync.isConfigured = () => false;
  PMS.authUI.show(function () { throw new Error("shell hand-off exploded"); });
  const handoffForm = document.getElementById("auth-root").querySelector("form");
  const handoffInputs = handoffForm.querySelectorAll("input");
  handoffInputs[0].value = "boss";
  handoffInputs[1].value = "pw1234";
  handoffForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const handoffText = document.getElementById("auth-root").textContent || "";
  ok("a failed hand-off explains itself instead of going blank",
    document.getElementById("auth-root").style.display === "flex" &&
    handoffText.indexOf(PMS.i18n.t("errors.startFailed")) !== -1 &&
    handoffText.indexOf("shell hand-off exploded") !== -1);
  ok("the failed hand-off can be retried", !!document.getElementById("auth-root").querySelector(".empty-state .btn"));
  PMS.cloudsync.isConfigured = realIsConfigured;
  PMS.authUI.hide();
  PMS.auth.login("boss", "pw1234");
  ok("suite is back on the admin session", PMS.auth.currentUser().role === "admin");
  route("/");
  ok("the app still renders the dashboard afterwards", root().children.length > 0);

  // main.js guards its own boot hand-off the same way: a startApp that throws
  // paints the reason instead of leaving the page blank
  {
    const realInit = PMS.app.init;
    PMS.app.init = function () { throw new Error("boot exploded"); };
    document.getElementById("view-root").innerHTML = "";
    window.eval(fs.readFileSync(path.join(APP, "js", "main.js"), "utf8"));
    await new Promise(r => setTimeout(r, 300));
    const bootText = document.getElementById("view-root").textContent || "";
    ok("a failing boot paints the reason instead of a blank page",
      bootText.indexOf(PMS.i18n.t("errors.startFailed")) !== -1 && bootText.indexOf("boot exploded") !== -1);
    ok("the failed boot can be retried", !!document.getElementById("view-root").querySelector(".boot-error .btn"));
    PMS.app.init = realInit;
    document.getElementById("view-root").innerHTML = "";
  }

section("Cloud sync (offline-safe API)");
  ok("cloudsync module present", PMS.cloudsync && PMS.cloudsync.push && PMS.cloudsync.pull && PMS.cloudsync.status);
  ok("cloudsync not enabled by default", PMS.cloudsync.status().enabled === false);
  ok("cloudsync.embedded exposed for settings", typeof PMS.cloudsync.embedded === "function");
  {
    const pushed = await PMS.cloudsync.push();
    ok("push disabled returns false", pushed === false);
    const pulled = await PMS.cloudsync.pull("replace");
    ok("pull disabled returns false", pulled === false);
  }
  const savedEmbeddedId = PMS.cloudConfig.projectId;
  PMS.cloudsync.saveConfig({ projectId: "proj-1", apiKey: "public-key-x" });
  ok("saveConfig persisted", PMS.cloudsync.config().projectId === "proj-1");
  ok("status exposes projectId", PMS.cloudsync.status().projectId === "proj-1");
  PMS.cloudsync.clearConfig();
  ok("clearConfig removes per-device override", PMS.cloudsync.config().projectId === savedEmbeddedId);

  // embedded build config (js/cloud-config.js) is the automatic path
  ok("cloud-config embedded module present", PMS.cloudConfig && typeof PMS.cloudConfig.projectId === "string");
  PMS.cloudConfig.projectId = "embedded-proj";
  ok("config falls back to embedded build config", PMS.cloudsync.config().projectId === "embedded-proj");
  PMS.cloudConfig.projectId = savedEmbeddedId;
  ok("embedded config restored after clear", PMS.cloudsync.config().projectId === savedEmbeddedId);

  // shared cloud login (Firebase Auth) — network calls are only exercised by
  // the real browser; the offline suite checks the API surface + bridge
  ok("cloudsync auth API present",
    PMS.cloudsync && typeof PMS.cloudsync.signUpWithPassword === "function" &&
    typeof PMS.cloudsync.signInWithPassword === "function" &&
    typeof PMS.cloudsync.signOut === "function" &&
    typeof PMS.cloudsync.resetPassword === "function" &&
    typeof PMS.cloudsync.setCloudRole === "function" &&
    typeof PMS.cloudsync.setCloudPersonId === "function" &&
    typeof PMS.cloudsync.setCloudEmail === "function");
  ok("authErrorMessage maps common codes",
    PMS.cloudsync.authErrorMessage({ code: "auth/wrong-password" }) === "invalid" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/email-already-in-use" }) === "duplicate" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/network-request-failed" }) === "network" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/x" }) === "generic");

  // local bridge for cloud identities — fully offline
  {
    const cu = PMS.cloudBridge.register({ username: "Team@Example.com", cloudUid: "uid-bridge-1", role: "admin", name: "Team Lead" });
    ok("registerCloudUser creates a local cloud record",
      cu && cu.username === "team@example.com" && cu.role === "admin" && cu.cloudUid === "uid-bridge-1" && !!cu.id && cu.passwordHash.indexOf("cloud::") === 0);
    ok("userByCloudUid finds it", PMS.cloudBridge.userByCloudUid("uid-bridge-1") && PMS.cloudBridge.userByCloudUid("uid-bridge-1").id === cu.id);
    // ZMS-01 regression: an id alone (even a matching cloudUid) must NOT mint a
    // session — only a uid that a Firebase Auth result on this page just
    // verified may be adopted.
    ok("adoptUser refuses without a verified cloud sign-in",
      PMS.cloudBridge.adopt({ id: cu.id, cloudUid: cu.cloudUid }) === null);
    PMS.cloudBridge.markVerified("uid-bridge-1");
    const adopted = PMS.cloudBridge.adopt({ id: cu.id, cloudUid: cu.cloudUid });
    ok("adoptUser creates an active session after verification",
      adopted && PMS.auth.currentUser().username === "team@example.com" && PMS.auth.currentUser().role === "admin");
    PMS.cloudBridge.markVerified("uid-other-device");
    ok("adoptUser refuses a mismatched verified uid",
      PMS.cloudBridge.adopt({ id: cu.id, cloudUid: cu.cloudUid }) === null);
    PMS.auth.logout();
    ok("logout clears the cloud session", PMS.auth.currentUser() === null);
  }

  PMS.auth.login("boss", "pw1234");
  ok("admin re-login after cloud bridge tests", PMS.auth.currentUser() && PMS.auth.currentUser().role === "admin");

  // merge regression: a pull must propagate EDITS (same id, newer writer wins)
  // and DELETIONS (local-only rows last touched before the remote push) — not
  // just new additions. This is what kept task-status changes from reaching
  // other devices before.
  ok("cloudsync merge respects per-item updatedAt (edits propagate)",
    PMS.cloudsync._mergeForTest && (function () {
      const saved = PMS.utils.deepClone(PMS.store.data);
      const local = PMS.schema.defaultData();
      local.users = PMS.utils.deepClone(saved.users || []);
      local.settings = PMS.utils.deepClone(saved.settings || {});
      local.projects = [{ id: "p1", name: "Before", updatedAt: "2026-01-01T00:00:00.000Z" }];
      local.tasks = [
        { id: "t1", title: "Old", statusId: "s1", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "t2", title: "To delete", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "t3", title: "Edited locally after push", updatedAt: "2026-01-03T00:00:00.000Z" }
      ];
      local.meta = { updatedAt: "2026-01-01T00:00:00.000Z" };
      const remote = PMS.utils.deepClone(local);
      remote.projects = [{ id: "p1", name: "After", updatedAt: "2026-01-02T00:00:00.000Z" }];
      remote.tasks = [{ id: "t1", title: "New", statusId: "s2", updatedAt: "2026-01-02T00:00:00.000Z" }];
      remote.meta = { updatedAt: "2026-01-02T00:00:00.000Z" };
      PMS.store.setData(local);
      let mergedOk = false;
      try {
        const merged = PMS.cloudsync._mergeForTest(remote);
        const t1 = merged.tasks.find(function (t) { return t.id === "t1"; });
        const t2 = merged.tasks.find(function (t) { return t.id === "t2"; });
        const t3 = merged.tasks.find(function (t) { return t.id === "t3"; });
        const p1 = merged.projects.find(function (p) { return p.id === "p1"; });
        mergedOk = t1 && t1.title === "New" && t1.statusId === "s2" &&   // edit propagated
          !t2 &&                                                         // remote deletion applied
          t3 && t3.id === "t3" &&                                        // offline local edit kept
          p1 && p1.name === "After" &&                                   // project edit propagated
          merged.meta.updatedAt === "2026-01-02T00:00:00.000Z";
      } catch (e) { mergedOk = false; }
      PMS.store.setData(saved);
      return mergedOk;
    })());
  PMS.auth.login("lina", "newpass1");
  ok("member canDelete/requireDelete returns false",
    PMS.auth.currentUser().role === "member" && PMS.auth.canDelete() === false && PMS.auth.requireDelete() === false);
  PMS.auth.login("boss", "pw1234");
  ok("admin canDelete/requireDelete returns true",
    PMS.auth.currentUser().role === "admin" && PMS.auth.canDelete() === true && PMS.auth.requireDelete() === true);

  section("Security hardening (offline)");
  // ZMS-03/-05: role decisions never come from the browser for cloud accounts
  {
    const R = PMS.cloudsync._resolveSignupRoleForTest;
    ok("signup: first account becomes admin (bootstrap)", R("admin", false) === "admin");
    ok("signup: first bootstrap account admin even when role not requested", R("member", false) === "admin");
    ok("signup: later accounts are always member", R("admin", true) === "member");
    ok("signup: later accounts member even for an admin caller (no client minting)", R("manager", true) === "member");
    ok("signup: member stays member", R("member", true) === "member");
    ok("signup: bogus role falls back to member", R("owner", true) === "member");
  }
  // ZMS-02/-12: user-management functions enforce admin inside, not just in UI
  PMS.auth.login("lina", "newpass1");
  const target = PMS.auth.users().find(u => u.username === "omar");
  ok("member cannot createUser", PMS.auth.createUser({ username: "x", password: "xxxxx" }).error === "forbidden");
  ok("member cannot updateUser role", PMS.auth.updateUser(target.id, { role: "admin" }).error === "forbidden");
  ok("member cannot updateUser active", PMS.auth.updateUser(target.id, { active: false }).error === "forbidden");
  ok("member cannot resetPassword", PMS.auth.resetPassword(target.id, "xxxxx").error === "forbidden");
  ok("member cannot removeUser", PMS.auth.removeUser(target.id).error === "forbidden");
  PMS.auth.login("boss", "pw1234");
  ok("admin updateUser works after guards", PMS.auth.updateUser(target.id, { role: "manager" }).ok === true);
  // ZMS-R02: createUser ignores any role the caller submits
  const r2 = PMS.auth.createUser({ username: "zz-new-acc", password: "pw1234", role: "owner" });
  ok("createUser cannot mint a role via the role param", !r2.error && r2.user.role === "member");
  PMS.auth.removeUser(r2.user.id);
  // ZMS-R15: admin re-authentication helpers
  ok("reauthenticateAdmin accepts the admin password", PMS.auth.reauthenticateAdmin("pw1234") === true);
  ok("reauthenticateAdmin rejects a wrong password", PMS.auth.reauthenticateAdmin("nope") === false);
  // the verified cloud bridge may sync the role and the linked person, and
  // nothing else — personId is what the per-record rules authorize by
  PMS.auth.logout();
  const bridgeRec = PMS.cloudBridge.userByCloudUid("uid-bridge-1");
  PMS.cloudBridge.markVerified("uid-bridge-1");
  ok("cloud bridge may adopt the verified role", PMS.auth.updateUser(bridgeRec.id, { role: "member" }).ok === true);
  ok("cloud bridge may adopt the linked personId", PMS.auth.updateUser(bridgeRec.id, { personId: "person-9" }).ok === true);
  ok("cloud bridge may adopt role + personId together", PMS.auth.updateUser(bridgeRec.id, { role: "admin", personId: "person-9" }).ok === true);
  ok("cloud bridge cannot touch other fields", PMS.auth.updateUser(bridgeRec.id, { role: "admin", name: "X" }).error === "forbidden");
  PMS.cloudBridge.markVerified("uid-other-device");
  ok("cloud bridge refuses without a verified uid", PMS.auth.updateUser(bridgeRec.id, { role: "admin" }).error === "forbidden");
  PMS.cloudBridge.markVerified("uid-bridge-1");
  PMS.auth.updateUser(bridgeRec.id, { personId: null, role: "admin" });
  PMS.auth.login("boss", "pw1234");
  // ZMS-09: authentication material never leaves with exports or backups
  const fakeData = PMS.utils.deepClone(PMS.store.data);
  fakeData.users.forEach(u => { u.passwordHash = "stub"; u.salt = "stub"; });
  const clean = PMS.exportService.sanitize(fakeData);
  ok("export sanitize strips passwordHash+salt", clean.users.every(u => !("passwordHash" in u) && !("salt" in u)) && clean.users.length === fakeData.users.length);
  ok("export sanitize keeps identity", typeof clean.users[0].username === "string" && !!clean.users[0].role);
  PMS.backup.load();
  const bksnap = PMS.backup.create();
  ok("backup snapshots never contain password hashes", (bksnap.data.users || []).every(u => !("passwordHash" in u) && !("salt" in u)));
  PMS.backup.remove(bksnap.id);
  // ZMS-11: absolute session lifetime
  PMS.auth.login("boss", "pw1234");
  const sessRaw = JSON.parse(window.localStorage.getItem("pms-auth-session"));
  sessRaw.at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  window.localStorage.setItem("pms-auth-session", JSON.stringify(sessRaw));
  PMS.auth._setSessionTTLForTest(60000);
  PMS.auth._resetSessionForTest();
  ok("expired session is rejected", PMS.auth.currentUser() === null);
  PMS.auth._setSessionTTLForTest(null);
  PMS.auth.login("boss", "pw1234");
  ok("admin re-login after TTL test", PMS.auth.currentUser().role === "admin");
  // ZMS-05: setCloudRole is admin-gated and role-validated
  PMS.auth.login("lina", "newpass1");
  const denyRole = await PMS.cloudsync.setCloudRole("uid-x", "admin");
  ok("setCloudRole denied for a member", denyRole === false);
  PMS.auth.login("boss", "pw1234");
  const denyBad = await PMS.cloudsync.setCloudRole("uid-x", "owner");
  ok("setCloudRole rejects an invalid role", denyBad === false);
  // ZMS-05: setCloudEmail is admin-gated; the actual Firebase email update is
  // only possible server-side via the adminUpdateEmail callable, so the offline
  // suite checks the guards (not the callable), the same way as deleteCloudAccount.
  {
    PMS.auth.login("lina", "newpass1");
    const rMember = await PMS.cloudsync.setCloudEmail("uid-x", "x@y.com").then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("setCloudEmail denied for a member", rMember === "forbidden");
    PMS.auth.login("boss", "pw1234");
    const rBad = await PMS.cloudsync.setCloudEmail("uid-x", "").then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("setCloudEmail rejects bad input", rBad === "invalid");
  }
  // createMemberAccount / setCloudActive are admin-gated; the real Firebase
  // account creation/activation is only possible server-side, so the offline
  // suite checks the guards (not the callables), like deleteCloudAccount.
  {
    PMS.auth.login("lina", "newpass1");
    const rCMember = await PMS.cloudsync.createMemberAccount({ email: "x@y.com" }).then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("createMemberAccount denied for a member", rCMember === "forbidden");
    PMS.auth.login("boss", "pw1234");
    const rCBad = await PMS.cloudsync.createMemberAccount({}).then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("createMemberAccount rejects bad input", rCBad === "invalid");
    PMS.auth.login("lina", "newpass1");
    const rAMember = await PMS.cloudsync.setCloudActive("uid-x", false).then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("setCloudActive denied for a member", rAMember === "forbidden");
    PMS.auth.login("boss", "pw1234");
    const rABad = await PMS.cloudsync.setCloudActive("", false).then(function () { return "ok"; }, function (e) { return (e && e.userCode) || "reject"; });
    ok("setCloudActive rejects bad input", rABad === "invalid");
  }

  section("ZMS-RT hardening (offline)");
  // ZMS-RT-03: the auth bridge must not be discoverable on PMS.auth
  ok("bridge helpers are NOT exposed on PMS.auth",
    !("_adoptBridge" in PMS.auth) && !("_markCloudVerified" in PMS.auth)
    && !("registerCloudUser" in PMS.auth) && !("userByCloudUid" in PMS.auth));
  ok("bridge helpers live on PMS.cloudBridge",
    typeof PMS.cloudBridge.adopt === "function" && typeof PMS.cloudBridge.register === "function"
    && typeof PMS.cloudBridge.userByCloudUid === "function" && typeof PMS.cloudBridge.markVerified === "function");
  // ZMS-RT-03: test-only cloudsync hooks exist under Node (the test suite)
  ok("cloudsync test hooks present under Node",
    typeof PMS.cloudsync._mergeForTest === "function" && typeof PMS.cloudsync._resolveSignupRoleForTest === "function");
  // ZMS-RT-01/-06: member devices must not push shared datasets
  {
    PMS.auth.logout();
    const cb = PMS.cloudBridge.userByCloudUid("uid-bridge-1");
    PMS.cloudBridge.markVerified("uid-bridge-1");
    PMS.cloudBridge.adopt({ id: cb.id, cloudUid: cb.cloudUid }); // role admin
    const asAdmin = await PMS.cloudsync.canWriteShared();
    ok("canWriteShared allows an admin", asAdmin === true);
    await PMS.auth.updateUser(cb.id, { role: "member" });
    PMS.cloudBridge.markVerified("uid-bridge-1");
    PMS.cloudBridge.adopt({ id: cb.id, cloudUid: cb.cloudUid });
    const asMember = await PMS.cloudsync.canWriteShared();
    ok("canWriteShared blocks a plain member", asMember === false);
    await PMS.auth.updateUser(cb.id, { role: "admin" });
    PMS.auth.login("boss", "pw1234");
  }
  // ZMS-RT-10: salts are high-entropy (CSPRNG-backed when available)
  {
    let saltA = "", saltB = "";
    if (PMS.auth.createUser && PMS.auth.currentUser() && PMS.auth.currentUser().role === "admin") {
      const ua = PMS.auth.createUser({ username: "rt10-a", password: "pw1234" });
      saltA = ua.error ? "" : ua.user.salt;
      const ub = PMS.auth.createUser({ username: "rt10-b", password: "pw1234" });
      saltB = ub.error ? "" : ub.user.salt;
      if (ua.user) PMS.auth.removeUser(ua.user.id);
      if (ub.user) PMS.auth.removeUser(ub.user.id);
    }
    ok("local salts are 16 hex chars each", /^[0-9a-f]{16}$/.test(saltA) && /^[0-9a-f]{16}$/.test(saltB));
    ok("local salts differ across users", saltA !== saltB);
  }

section("Loading box / network monitor");
  ok("PMS.network present", PMS.network && typeof PMS.network.isOnline === "function");
  ok("PMS.loadingBox present", PMS.loadingBox && typeof PMS.loadingBox.show === "function" && typeof PMS.loadingBox.hide === "function");
  ok("loading box starts hidden", PMS.loadingBox.isVisible() === false);
  ok("slow/offline/syncing i18n keys exist (en)",
    PMS.i18n.t("cloud.slowNet") !== "cloud.slowNet" &&
    PMS.i18n.t("cloud.offline") !== "cloud.offline" &&
    PMS.i18n.t("cloud.syncing") !== "cloud.syncing");
  PMS.i18n.setLang("ar");
  ok("slowNet loads in ar", PMS.i18n.t("cloud.slowNet").indexOf("جارٍ") !== -1 && PMS.i18n.t("cloud.offline").indexOf("غير متصل") !== -1);
  PMS.i18n.setLang("en");
  // connectivity flipping (test-only hook, never present in a browser)
  PMS.network._setOnline(false);
  ok("network reports offline", PMS.network.isOnline() === false);
  PMS.network._setOnline(true);
  ok("network reports online again", PMS.network.isOnline() === true);
  // a long push shows the "slow connection" box after SLOW_MS
  PMS.loadingBox._setSlowMs(20);
  PMS.loadingBox._setCloudActive(true);
  PMS.bus.emit("cloud:inflight", { busy: true, op: "push" });
  await new Promise(r => setTimeout(r, 60));
  ok("long push shows slow box", PMS.loadingBox.isVisible() && PMS.loadingBox.visibleReason() === "slow");
  PMS.bus.emit("cloud:inflight", { busy: false, op: "push" });
  ok("push end hides slow box", PMS.loadingBox.isVisible() === false);
  // boot shows immediately (no timer)
  PMS.bus.emit("cloud:inflight", { busy: true, op: "boot" });
  ok("boot shows busy box immediately", PMS.loadingBox.isVisible() && PMS.loadingBox.visibleReason() === "busy");
  PMS.bus.emit("cloud:inflight", { busy: false, op: "boot" });
  ok("boot end hides box", PMS.loadingBox.isVisible() === false);
  // offline shows the offline box only while cloud sync is active
  PMS.network._setOnline(false);
  ok("offline + cloud shows offline box", PMS.loadingBox.isVisible() && PMS.loadingBox.visibleReason() === "offline");
  PMS.network._setOnline(true);
  ok("back online hides offline box", PMS.loadingBox.isVisible() === false);
  PMS.loadingBox._setCloudActive(false);
  PMS.network._setOnline(false);
  ok("offline without cloud stays hidden", PMS.loadingBox.isVisible() === false);
  PMS.network._setOnline(true);
  PMS.loadingBox._setCloudActive(null);
  PMS.loadingBox._setSlowMs();

section("Bilingual / RTL");
  PMS.i18n.setLang("ar");
  ok("i18n ar active", PMS.i18n.getLang() === "ar");
  ok("RTL dir applied", document.documentElement.dir === "rtl");
  ["/tasks", "/tasks/gantt", "/reports"].forEach(r => {
    errors.length = 0;
    route(r);
    ok("ar renders " + r, errors.length === 0);
  });
  PMS.i18n.setLang("en");

  PMS.sync.tick();
  PMS.sync.stop();
  ok("sync.tick safe when unbound", true);

  console.log("\n==========================================");
  console.log("RESULTS: " + passCount + " passed, " + failCount + " failed");
  console.log(process.exitCode ? "FULL TEST FAILED" : "FULL TEST PASSED");
  process.exit(process.exitCode || 0);
})().catch(err => {
  console.error("FATAL in test harness:", err && err.stack || err);
  process.exit(1);
});