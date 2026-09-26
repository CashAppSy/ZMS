"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// the site lives at the repo root (index.html + js + css)
const root = process.cwd();

// ---- minimal browser/environment stubs ----
function makeEl() {
  const el = {
    nodeType: 1,
    _children: [],
    _listeners: {},
    style: {},
    dataset: {},
    classList: { _set: new Set(), add(c){ this._set.add(c); }, remove(c){ this._set.delete(c); }, toggle(c){ this._set.has(c)?this._set.delete(c):this._set.add(c); }, contains(c){ return this._set.has(c); } },
    attrs: {},
    appendChild(c){ this._children.push(c); return c; },
    append(...cs){ cs.forEach(c=>this._children.push(c)); },
    addEventListener(type, fn){ (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn){ const a=this._listeners[type]||[]; const i=a.indexOf(fn); if(i>-1)a.splice(i,1); },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    set innerHTML(v){ this._html=v; }, get innerHTML(){ return this._html||""; },
    set textContent(v){ this._text=String(v); }, get textContent(){ return this._text||""; },
    insertBefore(child, ref){ this._children.push(child); return child; },
    setAttribute(k, v){ this.attrs[k]=String(v); if(k==="class") this._class=String(v); },
    getAttribute(k){ return this.attrs[k]!==undefined?this.attrs[k]:null; },
    remove(){},
    focus(){}, select(){}, blur(){},
    get childNodes(){ return this._children; },
    contains(){ return false; },
    getBoundingClientRect(){ return { top:0, left:0, right:0, bottom:0, width:0, height:0 }; },
    get firstChild(){ return this._children[0]||null; },
    get ownerDocument(){ return docStub; }
  };
  return el;
}
const elStub = makeEl();

global.document = {
  readyState: "complete",
  documentElement: { setAttribute(){}, getAttribute(){ return "light"; }, style: {} },
  getElementById(){ return elStub; },
  createElement(){ return makeEl(); },
  createElementNS(ns, tag){ return makeEl(); },
  createTextNode(t){ return { nodeType:3, textContent: String(t) }; },
  addEventListener(){},
  removeEventListener(){},
  activeElement: elStub,
  title: ""
};

global.window = global;
global.__ZMS_TEST__ = true; // allow modules to expose test-only hooks
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
global.indexedDB = undefined; // forces localStorage fallback
global.location = { hash: "#/" };
global.history = { replaceState(){}, pushState(){} };
global.requestAnimationFrame = (cb)=>0;

const consoleLog = [];

// ---- load all scripts in index.html order ----
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const srcs = [];
const re = /<script src="([^"]+)"><\/script>/g;
let m;
while ((m = re.exec(html))) srcs.push(m[1]);

for (const src of srcs) {
  const file = path.join(root, src);
  const code = fs.readFileSync(file, "utf8");
  try {
    vm.runInThisContext(code, { filename: file });
  } catch (e) {
    console.error("LOAD ERROR in " + src + ": " + e.message);
    process.exitCode = 1;
    break;
  }
}

const PMS = global.PMS;
if (!PMS) { console.error("PMS namespace missing"); process.exit(1); }

// ---- post-load wiring assertions (no DOM render needed) ----
function assert(cond, msg){ if(!cond){ console.error("ASSERT FAIL: " + msg); process.exitCode = 1; } }

const d = PMS.schema.defaultData();
assert(Array.isArray(d.departments) && Array.isArray(d.tasks), "defaultData shapes");
assert(Array.isArray(d.taskStatuses) && d.taskStatuses.length === 4, "task statuses");
assert(d.priorities.length === 4, "priorities");

// auth integration: create a known admin and log in so guard-gated views
// (Settings) and the editors render for real (this harness has no login UI)
function ensureAuth() {
  if (PMS.auth && PMS.auth.createUser) {
    if (!PMS.auth.currentUser()) {
      if (!PMS.auth.users().some(u => u.username === "smoke")) {
        PMS.auth.createUser({ username: "smoke", password: "pw1234", name: "Smoke Admin" });
      }
      PMS.auth.login("smoke", "pw1234");
    }
  }
}

// seed build produces valid entities with ids
const seed = PMS.seed.build();
assert(seed.departments.length > 0 && seed.people.length > 0 && seed.projects.length > 0 && seed.tasks.length > 0, "seed build populated");
assert(seed.tasks.every(t => t.id && t.projectId), "seed tasks have ids + project");

// repos work against store (init is async; bypass by setData)
PMS.store.setData(PMS.schema.defaultData());
const t1 = PMS.repos.tasks.add({ title: "A", projectId: null, status: "todo", priority: "low" });
assert(t1.id, "tasks.add assigns id");
assert(PMS.repos.tasks.get(t1.id), "tasks.get returns record");
PMS.repos.tasks.update(t1.id, { progress: 50 });
assert(PMS.repos.tasks.get(t1.id).progress === 50, "tasks.update persisted");
PMS.repos.tasks.remove(t1.id);
assert(PMS.repos.tasks.get(t1.id) === null, "tasks.remove deleted");

// progress engine
PMS.store.setData(PMS.schema.defaultData());
const parent = PMS.repos.projects.add({ name: "P", status: "active" });
const pt = PMS.repos.tasks.add({ title: "pt", projectId: parent.id, status: "todo", progress: 30 });
PMS.repos.tasks.add({ title: "sub", projectId: parent.id, parentTaskId: pt.id, status: "done", progress: 100 });
assert(PMS.progress.taskChildren(PMS.store.data, pt.id).length === 1, "taskChildren");
const projP = PMS.progress.projectProgress(PMS.store.data, parent.id, false);
assert(typeof projP === "number" && projP >= 0 && projP <= 100, "projectProgress");

// filter engine
const rows = PMS.filterEngine.filterTasks(PMS.store.data.tasks, { search: "" }, PMS.store.data);
assert(rows.length === 2, "filterTasks returns rows");
const sorted = PMS.filterEngine.sortTasks(rows, "title", "asc", PMS.store.data);
assert(sorted.length === 2, "sortTasks");

// report engine
const rep = PMS.reports.get("taskStatus");
assert(rep && rep.generate, "report registered");
const rr = rep.generate(PMS.store.data);
assert(Array.isArray(rr.rows) && Array.isArray(rr.columns), "report generate");

// registry
assert(PMS.registry.getView("projects"), "projects view registered");
assert(PMS.registry.allFieldTypes().length >= 4, "field types registered");

// export csv
const csv = PMS.exportService.toCSV([{ a: 1, b: "x" }], ["a", "b"]);
assert(typeof csv === "string" && csv.indexOf("1,x") > -1, "CSV export");

// i18n
assert(PMS.i18n.t("nav.tasks") === "Tasks" || PMS.i18n.t("nav.tasks").length > 0, "i18n en resolves");
PMS.i18n.setLang("ar");
assert(PMS.i18n.getLang() === "ar", "i18n lang switch");
assert(PMS.i18n.t("sync.synced").length > 0 && PMS.i18n.t("settings.autoSync").length > 0, "auto-sync i18n keys present");
PMS.i18n.setLang("en");

// auto-sync service + settings default
assert(PMS.sync && typeof PMS.sync.start === "function" && typeof PMS.sync.tick === "function", "sync service registered");
PMS.store.setData(PMS.schema.defaultData());
assert(PMS.store.data.settings.autoSync !== false, "autoSync default enabled");

// store undo/redo via commit
PMS.store.setData(PMS.schema.defaultData());
PMS.store.commit(d => { d.people.push({ id: "p1" }); }, "add1");
PMS.store.commit(d => { d.projects.push({ id: "pr1" }); }, "add2");
assert(PMS.store.canUndo(), "undo stack populated");
PMS.store.undo();
assert(PMS.store.data.projects.length === 0, "undo removed project");
PMS.store.redo();
assert(PMS.store.data.projects.length === 1, "redo restored project");

// ---- exercise every view's render() against seeded data ----
PMS.store.setData(PMS.seed.build());
ensureAuth();
const routes = ["/", "/projects", "/projects/" + PMS.store.data.projects[0].id,
  "/tasks", "/tasks/kanban", "/tasks/gantt", "/tasks/calendar",
  "/people", "/reports", "/settings"];
for (const route of routes) {
  global.location.hash = "#" + route;
  document.title = "";
  try {
    PMS.router.handle();
  } catch (e) {
    console.error("VIEW RENDER ERROR on " + route + ": " + e.message + "\n" + (e.stack || "").split("\n").slice(0,4).join("\n"));
    process.exitCode = 1;
  }
}

// ---- regression checks for the latest fixes ----

// 1) ensureShape backfills statuses/priorities for OLD saved data that never
//    persisted those arrays (root cause of empty Kanban / Reports / Settings).
{
  const raw = { schemaVersion: 1, departments: [], people: [], projects: [], tasks: [], customFieldDefs: [], savedFilters: [] };
  PMS.store.ensureShape(raw);
  assert(raw.taskStatuses.length === 4, "ensureShape backfills task statuses");
  assert(raw.projectStatuses.length > 0 && raw.priorities.length === 4, "ensureShape backfills project statuses + priorities");
  assert(raw.settings && raw.settings.autoSync !== false, "ensureShape adds settings defaults");

  // setData (the import/backup/sync path) must run ensureShape too
  const emptySt = PMS.schema.defaultData();
  emptySt.taskStatuses = [];
  emptySt.projectStatuses = [];
  emptySt.priorities = [];
  PMS.store.setData(emptySt);
  assert(PMS.store.data.taskStatuses.length === 4, "setData backfills empty statuses");
}

// 2b) dom.h() must be SVG-safe (real browsers: SVGElement.className is a
//     read-only getter; assigning under "use strict" throws and broke Gantt)
{
  const svg = PMS.dom.h("svg.gantt-links", { attrs: { width: "10px" } });
  assert(svg.getAttribute("class") === "gantt-links", "h() sets classes via attribute (SVG-safe)");
  const wcls = PMS.dom.h("div.x", { class: "extra" });
  assert(wcls.getAttribute("class").indexOf("extra") > -1, "h() merges props.class via attribute");
}

// 2c) h('div', [child, child]) 2-arg array form must append children
//     (previously the array was treated as props, so report head rows,
//     tables, chart rows never rendered -> "reports show no results")
{
  const d = PMS.dom.h("div.u-grow", [PMS.dom.h("b", { text: "B" }), PMS.dom.h("i", { text: "I" })]);
  assert(d._children.length === 2 && d._children[0]._text === "B", "h() renders array-as-2nd-arg children");
  const d3 = PMS.dom.h("div", null, PMS.dom.h("b", { text: "single" }));
  assert(d3._children.length === 1, "h() handles a single element child");
}

// 2) forms: select controls must prefill the CURRENT value when editing
//    (previously options were appended AFTER value assignment, so edit forms
//    showed an empty select and saved edits silently reset status/priority).
{
  const ctl = PMS.forms.buildControl(
    { key: "status", type: "select", options: [{ label: "To Do", value: "todo" }, { label: "Doing", value: "doing" }] },
    "doing"
  );
  assert(ctl.el.value === "doing", "select prefills current value on edit");
  const num = PMS.forms.buildControl({ key: "progress", type: "number" }, 42);
  assert(num.el.value === 42, "number prefills value");
}

// 3) rendered views expose the new affordances (walk only the latest subtree)
function findWalk(root, pred) {
  const stack = [root];
  while (stack.length) {
    const e = stack.pop();
    if (!e) continue;
    if (pred(e)) return e;
    if (e._children) for (let i = e._children.length - 1; i >= 0; i--) stack.push(e._children[i]);
  }
  return null;
}
function countWalk(root, pred) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const e = stack.pop();
    if (!e) continue;
    if (pred(e)) n++;
    if (e._children) for (const c of e._children) stack.push(c);
  }
  return n;
}
function inLastRender(pred) {
  const root = document.getElementById("view-root");
  const parts = root._children.slice(Math.max(0, root._children.length - 8));
  for (const p of parts) { const hit = findWalk(p, pred); if (hit) return hit; }
  return null;
}
function countInLast(pred) {
  const root = document.getElementById("view-root");
  const parts = root._children.slice(Math.max(0, root._children.length - 8));
  let n = 0;
  for (const p of parts) n += countWalk(p, pred);
  return n;
}
const cnameFirst = e => String((e._class) || e.className || "").split(" ")[0];
PMS.store.setData(PMS.seed.build());
ensureAuth();
global.location.hash = "#/projects";
PMS.router.handle();
assert(inLastRender(e => e._text === "✎") !== null, "projects tree rows show an Edit button");
global.location.hash = "#/tasks/kanban";
PMS.router.handle();
const kanbanSel = inLastRender(e => e.dataset && e.dataset.id === "kanban-project-filter");
assert(kanbanSel !== null, "kanban view has project filter select");
assert(kanbanSel && kanbanSel.value === "__all__", "kanban filter defaults to all projects");
assert(kanbanSel && kanbanSel._children.length >= PMS.repos.projects.all().length + 1, "kanban filter lists all projects");
global.location.hash = "#/tasks";
PMS.router.handle();
assert(inLastRender(e => e._text === "✎") !== null, "tasks table title cells show an Edit button");

// 4) Settings -> Statuses must render rows (regression: ReferenceError on
//    'body' left the whole section blank even when statuses data existed)
PMS.store.setData(PMS.seed.build());
ensureAuth();
global.location.hash = "#/settings";
PMS.router.handle();
const stNav = inLastRender(e => (e._text || "").trim() === PMS.i18n.t("settings.statuses"));
assert(stNav !== null, "settings statuses nav present");
if (stNav) (stNav._listeners.click || []).forEach(fn => fn({}));
assert(PMS.store.data.taskStatuses.length === 4, "statuses data present");
assert(countInLast(e => cnameFirst(e) === "setting-row") >= PMS.store.data.taskStatuses.length, "statuses rows rendered");

// 5) Gantt must render every task, even when all of them are subtasks
//    (previously subtasks were excluded, so "Gantt empty but tasks exist")
const allSub = PMS.seed.build();
allSub.tasks.forEach((tk, i) => { tk.parentTaskId = i === 0 ? null : allSub.tasks[0].id; });
PMS.store.setData(allSub);
document.getElementById("view-root")._children.length = 0;
global.location.hash = "#/tasks/gantt";
PMS.router.handle();
assert(countInLast(e => cnameFirst(e) === "gantt-row") === allSub.tasks.length, "gantt shows all tasks incl. subtasks");

// 5b) Gantt must not crash when old/imported data has a string `dependencies`
const strDep = PMS.seed.build();
strDep.tasks.forEach((tk, i) => { tk.dependencies = i === 0 ? "some,string" : []; });
PMS.store.setData(strDep);
document.getElementById("view-root")._children.length = 0;
global.location.hash = "#/tasks/gantt";
PMS.router.handle();
assert(countInLast(e => cnameFirst(e) === "gantt-row") === strDep.tasks.length, "gantt tolerates string dependencies");

// 5c) editing a project/task that HAS tags must not throw the insertBefore
//     error (tags chips were inserted before an input that was not yet a child)
{
  const tagCtl = PMS.forms.buildControl({ key: "tags", type: "tags" }, ["alpha", "beta"]);
  assert(tagCtl && Array.isArray(tagCtl.getValue()), "tags control builds with initial values");
  let threw = false;
  try { PMS.editors.openTaskEditor(Object.assign({ id: "x1", title: "T", tags: ["tag1", "tag2"] }), {}); }
  catch (e) { threw = true; console.error("TAGS EDIT THROW:", e.message); }
  if (PMS.modal.isOpen) PMS.modal.close();
  assert(!threw, "editor opens for a task with tags");
}

// 6) every project/task editor opens without throwing (worst-case data)
PMS.store.setData(PMS.seed.build());
ensureAuth();
{
  let throws = 0;
  for (const p of PMS.repos.projects.all()) {
    try { PMS.editors.openProjectEditor(p, {}); if (PMS.modal.isOpen) PMS.modal.close(); }
    catch (e) { throws++; console.error("PROJECT EDIT THROW:", p.id, e.stack ? e.stack.split("\n").slice(0,4).join(" | ") : e.message); }
  }
  for (const tk of PMS.repos.tasks.all()) {
    try { PMS.editors.openTaskEditor(tk, {}); if (PMS.modal.isOpen) PMS.modal.close(); }
    catch (e) { throws++; console.error("TASK EDIT THROW:", tk.id, e.stack ? e.stack.split("\n").slice(0,4).join(" | ") : e.message); }
  }
  assert(throws === 0, "project/task editors open for all records");
}
PMS.i18n.setLang("en");

console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
process.exit(process.exitCode || 0);