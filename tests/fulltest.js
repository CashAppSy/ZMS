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
Object.defineProperty(window, "localStorage", {
  value: { _s: {}, getItem(k){ return this._s[k] ?? null; }, setItem(k,v){ this._s[k]=String(v); }, removeItem(k){ delete this._s[k]; } },
  configurable: true
});

const errors = [];
window.addEventListener("error", e => errors.push("WINDOW ERROR: " + e.message));

let passCount = 0;
let failCount = 0;
function ok(label, cond) {
  if (cond) { passCount++; console.log("  PASS | " + label); }
  else { failCount++; process.exitCode = 1; console.log("  FAIL | " + label); }
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
  ok("schema.defaultData shapes", Array.isArray(d.departments) && Array.isArray(d.tasks) && Array.isArray(d.taskStatuses) && Array.isArray(d.priorities));
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

  // persistence roundtrip through fallback storage
  PMS.store.setData(PMS.seed.build());
  await PMS.store.flush();
  ok("store.flush persists (fallback storage)", typeof window.localStorage.getItem("pms-data") === "string");

  // migrations (VERSION=1 -> no-op path must be safe)
  const old = { schemaVersion: 1, departments: [], people: [], projects: [], tasks: [], customFieldDefs: [] };
  const mig = PMS.migrations.migrate(old);
  ok("migrations.migrate safe on old data", mig && Array.isArray(mig.departments) && typeof mig.schemaVersion === "number");

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

  const routes = ["/", "/projects", "/projects/" + data.projects[0].id, "/tasks", "/tasks/kanban", "/tasks/gantt", "/tasks/calendar", "/people", "/reports", "/settings"];
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
  const sel = root().querySelector(".vt-row select.vt-status");
  if (sel) {
    const beforeMap = new Map(PMS.store.data.tasks.map(t => [t.id, t.status]));
    let target = ["done", "todo"].find(k => k !== sel.value);
    sel.value = target;
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    ok("tasks table inline status persists when changed", PMS.store.data.tasks.some(t => t.status === target && beforeMap.get(t.id) !== target));
  } else ok("tasks table has inline status select", sel !== null);

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

  section("Validation");
  ok("task valid", PMS.validation.check("task", { title: "OK" }).valid);
  ok("task missing title invalid", !PMS.validation.check("task", {}).valid);
  ok("task bad dates invalid", !PMS.validation.check("task", { title: "x", startDate: "2026-09-10", dueDate: "2026-09-01" }).valid);
  ok("person bad email invalid", !PMS.validation.check("person", { name: "x", email: "nope" }).valid);
  ok("project bad dates invalid", !PMS.validation.check("project", { name: "x", startDate: "2026-10-10", endDate: "2026-09-01" }).valid);

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
    PMS.auth.createUser({ username: "boss", password: "pw1234", role: "admin", name: "Boss" });
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
  const dup = PMS.auth.createUser({ username: "boss", password: "x1234", role: "member" });
  ok("duplicate username rejected", dup.error === "duplicate");

  // create an account linked to a real person + one manager + one member
  const linaP = PMS.repos.people.all().find(p => p.name === "Lina Haddadin");
  const linaAcc = PMS.auth.createUser({ username: "lina", password: "lina1234", personId: linaP.id, role: "member" });
  ok("createUser linked to person", !linaAcc.error && linaAcc.user.personId === linaP.id && linaAcc.user.role === "member");
  const mgrAcc = PMS.auth.createUser({ username: "omar", password: "omar1234", personId: PMS.repos.people.all().find(p => p.name === "Omar Khalil").id, role: "manager" });
  ok("createUser manager", !mgrAcc.error && mgrAcc.user.role === "manager");
  ok("lina displayName = person name", PMS.authUI.displayName(linaAcc.user) === "Lina Haddadin");

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

  // admin-only route guard bounces non-admins
  errors.length = 0;
  PMS.router.navigate("/settings");
  PMS.router.handle();
  ok("non-admin bounced from /settings", PMS.router.current !== "/settings");
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
    typeof PMS.cloudsync.setCloudRole === "function");
  ok("authErrorMessage maps common codes",
    PMS.cloudsync.authErrorMessage({ code: "auth/wrong-password" }) === "invalid" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/email-already-in-use" }) === "duplicate" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/network-request-failed" }) === "network" &&
    PMS.cloudsync.authErrorMessage({ code: "auth/x" }) === "generic");

  // local bridge for cloud identities — fully offline
  {
    const cu = PMS.auth.registerCloudUser({ username: "Team@Example.com", cloudUid: "uid-bridge-1", role: "admin", name: "Team Lead" });
    ok("registerCloudUser creates a local cloud record",
      cu && cu.username === "team@example.com" && cu.role === "admin" && cu.cloudUid === "uid-bridge-1" && !!cu.id && cu.passwordHash.indexOf("cloud::") === 0);
    ok("userByCloudUid finds it", PMS.auth.userByCloudUid("uid-bridge-1") && PMS.auth.userByCloudUid("uid-bridge-1").id === cu.id);
    const adopted = PMS.auth.adoptUser(cu.id);
    ok("adoptUser creates an active session",
      adopted && PMS.auth.currentUser().username === "team@example.com" && PMS.auth.currentUser().role === "admin");
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