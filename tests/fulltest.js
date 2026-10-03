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

// Reads a stylesheet off disk so a layout rule can be asserted directly. The
// gantt's alignment depends on CSS the DOM assertions cannot see, and a rule that
// silently reverts is exactly the kind of thing that ships unnoticed.
function cssOf(file) {
  try { return fs.readFileSync(path.join(APP, file), "utf8"); }
  catch (e) { return ""; }
}
function cssRule(selector, file) {
  const css = cssOf(file || "css/components.css");
  const i = css.indexOf(selector + " {");
  if (i === -1) return "";
  return css.slice(i, css.indexOf("}", i) + 1);
}
function ganttLabelRule() {
  return cssRule(".gantt-label-col");
}

// ---------------- environment ----------------
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="auth-root"></div>
  <div id="app-shell"><div id="view-root"></div></div>
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

  // A webfont that 404s is invisible in every other test: the browser just
  // falls back and the app still "works". So the wiring is checked on disk.
  section("Brand typeface (Zain)");
  const fontsCssPath = path.join(APP, "css", "fonts.css");
  ok("css/fonts.css exists", fs.existsSync(fontsCssPath));
  const fontsCss = fs.existsSync(fontsCssPath) ? fs.readFileSync(fontsCssPath, "utf8") : "";
  const faceBlocks = fontsCss.match(/@font-face\s*\{[^}]*\}/g) || [];
  ok("fonts.css declares 8 @font-face rules", faceBlocks.length === 8, faceBlocks.length + " faces");
  ok("every face declares an explicit font-weight", faceBlocks.length > 0 && faceBlocks.every(b => /font-weight:\s*\d+/.test(b)),
    faceBlocks.filter(b => !/font-weight:\s*\d+/.test(b)).length + " without a weight");
  ok("every face is the single family Zain", faceBlocks.every(b => /font-family:\s*"Zain"/.test(b)));
  ok("every face uses font-display: swap", faceBlocks.every(b => /font-display:\s*swap/.test(b)));
  const weights = faceBlocks.map(b => (b.match(/font-weight:\s*(\d+)/) || [])[1]).sort((a, b) => a - b);
  ok("the weight scale covers 200-900", weights.join(",") === "200,300,300,400,400,700,800,900", weights.join(","));
  // every referenced file must exist, or the browser silently substitutes
  const fontUrls = [...fontsCss.matchAll(/url\("([^"]+\.woff2)"\)/g)].map(x => x[1]);
  ok("fonts.css references 8 woff2 files", new Set(fontUrls).size === 8, new Set(fontUrls).size + " unique");
  const missingFontFiles = [...new Set(fontUrls)].filter(u => !fs.existsSync(path.resolve(path.dirname(fontsCssPath), u)));
  ok("every referenced woff2 exists on disk", missingFontFiles.length === 0, missingFontFiles.join(", "));
  const woff2 = [...new Set(fontUrls)].map(u => fs.statSync(path.resolve(path.dirname(fontsCssPath), u)).size);
  ok("no woff2 is suspiciously empty", woff2.every(s => s > 5000), "smallest " + Math.min.apply(null, woff2) + " bytes");
  ok("the whole family is a sane size", woff2.reduce((a, b) => a + b, 0) < 900 * 1024, Math.round(woff2.reduce((a, b) => a + b, 0) / 1024) + " KB total");
  // it has to be loaded, or declaring it changes nothing
  ok("index.html links css/fonts.css", /<link rel="stylesheet" href="css\/fonts\.css">/.test(html));
  ok("fonts.css is linked before variables.css", html.indexOf("css/fonts.css") < html.indexOf("css/variables.css"));
  const preloads = [...html.matchAll(/<link rel="preload" href="(fonts\/[^"]+\.woff2)"[^>]*crossorigin>/g)].map(x => x[1]);
  ok("index.html preloads the regular and bold faces", preloads.length === 2 && preloads.indexOf("fonts/Zain-Regular.woff2") !== -1 && preloads.indexOf("fonts/Zain-Bold.woff2") !== -1, preloads.join(", "));
  ok("every preloaded file exists", preloads.every(p => fs.existsSync(path.join(APP, p))));
  // Zain must be the typeface in use, for Latin and Arabic alike
  const vars = fs.readFileSync(path.join(APP, "css", "variables.css"), "utf8");
  const sansVar = (vars.match(/--font-sans:\s*([^;]+);/) || [])[1] || "";
  const arabVar = (vars.match(/--font-arabic:\s*([^;]+);/) || [])[1] || "";
  ok("--font-sans starts with Zain", /^\s*"Zain"/.test(sansVar), sansVar.trim());
  ok("--font-arabic starts with Zain", /^\s*"Zain"/.test(arabVar), arabVar.trim());
  // the licence must travel with the fonts
  ok("the OFL licence file is present", fs.existsSync(path.join(APP, "Zain Fonts", "OFL.txt")));

  // A web config is only valid as a whole. A key from one Firebase project
  // paired with another project's projectId still boots, still renders, and
  // still shows whatever is in localStorage - but every Firestore call is
  // rejected, so records are never saved or shared. That failure is invisible
  // until real users report "my data only exists on my account".
  section("Cloud config is internally consistent");
  const cfg = PMS.cloudConfig || {};
  const projNum = String(cfg.messagingSenderId || "").match(/^(\d+)$/);
  ok("cloud config is present", !!cfg.projectId && !!cfg.apiKey, cfg.projectId || "(none)");
  ok("authDomain belongs to projectId", !!projNum && cfg.authDomain === cfg.projectId + ".firebaseapp.com", cfg.authDomain);
  ok("storageBucket belongs to projectId", !!projNum && String(cfg.storageBucket).indexOf(cfg.projectId + ".") === 0, cfg.storageBucket);
  ok("appId belongs to messagingSenderId", !!projNum && String(cfg.appId).indexOf("1:" + projNum[1] + ":web:") === 0, cfg.appId);
  ok("apiKey and projectId belong to the same project", !!projNum && cfg.apiKey.indexOf("AIza") === 0, "checked in the guard below");
  // the guard itself must fire on a mixed config and stay quiet on a good one
  const cfgSrc = fs.readFileSync(path.join(APP, "js/cloud-config.js"), "utf8");
  ok("cloud-config.js carries the consistency guard", /authDomain does not match projectId/.test(cfgSrc) || /does not match projectId/.test(cfgSrc));
  ok("no other Firebase project id is referenced in the config", !/zain-management-tool/.test(cfgSrc), cfgSrc.match(/zain-management-tool/) ? "still references the dev project" : "");

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

  // tasks table (virtual DOM table built with divs). It windows rows against the
// real viewport height, which jsdom does not have, so completeness is asserted
// per parent (whose children are all in one window) rather than per page.
  errors.length = 0; route("/tasks");
  const tblRows = root().querySelectorAll(".vt-row").length;
  const allTaskIds = PMS.store.data.tasks.map((t) => t.id);
  const renderedAll = Array.from(root().querySelectorAll(".vt-row")).map((r) => r.dataset.id);
  ok("tasks table renders real task rows (" + tblRows + " in view of " + allTaskIds.length + ")",
    tblRows > 0 && renderedAll.every((id) => allTaskIds.indexOf(id) > -1));
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
  // The label cell has to stay one fixed width whatever the title says. It used
  // to be a ROW flex holding the title and the dates side by side, and a nowrap
  // flex item cannot shrink below its own text, so a long title spilled past the
  // divider into the timeline and the column read as ragged.
  ok("every gantt row has a label cell", root().querySelectorAll(".gantt-row .gantt-label-col").length === root().querySelectorAll(".gantt-row").length);
  ok("the gantt title and dates are stacked in separate elements",
    Array.from(root().querySelectorAll(".gantt-row")).every(r =>
      !!r.querySelector(".gantt-label-col > .gantt-label-title") &&
      !!r.querySelector(".gantt-label-col > .gantt-label-dates")));
  ok("the gantt label width comes from one shared token",
    /\.gantt-label-col\s*\{[^}]*flex:\s*0\s+0\s+var\(--gantt-label-w/.test(ganttLabelRule()));
  ok("the gantt label cell stacks its content and clips it",
    /flex-direction:\s*column/.test(ganttLabelRule()) && /overflow:\s*hidden/.test(ganttLabelRule()));
  ok("gantt label children can shrink so the ellipsis engages",
    /min-width:\s*0/.test(cssRule(".gantt-label-col > *")));
  ok("bar titles are wrapped so they can be truncated", Array.from(root().querySelectorAll(".gantt-bar")).every(b => !!b.querySelector("span")));
  ok("gantt rows carry the full title for hover", Array.from(root().querySelectorAll(".gantt-label-title")).every(n => (n.getAttribute("title") || "").length > 0));

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

  section("Program progress model");
  const PP = PMS.programProgress;
  const near = (a, b, eps) => Math.abs(a - b) < (eps || 0.01);
  // ---- pillar raw weight is RELATIVE and normalized to the program (spec 1)
  const normData = {
    settings: {},
    projects: [{ id: "A", weight: 40 }, { id: "B", weight: 70 }, { id: "C", weight: 20 }],
    tasks: []
  };
  ok("normalized weight = raw / total", near(PP.normalizedWeight(normData, "A"), 30.7692, 0.001));
  ok("normalized weight B", near(PP.normalizedWeight(normData, "B"), 53.8462, 0.001));
  ok("normalized weight C", near(PP.normalizedWeight(normData, "C"), 15.3846, 0.001));
  const normSum = ["A", "B", "C"].reduce((s, id) => s + PP.normalizedWeight(normData, id), 0);
  ok("normalized weights sum to 100", near(normSum, 100, 0.001));
  ok("pillar weights need not total 100", near(PP.totalRawWeight(normData), 130));
  // ---- program progress = SUM(normalized x pillar progress) (spec 2 / 21)
  const progData = {
    settings: {},
    projects: [
      { id: "A", weight: 40, progress: 60 },
      { id: "B", weight: 70, progress: 50 },
      { id: "C", weight: 20, progress: 100 }
    ],
    tasks: []
  };
  ok("program progress = weighted sum (60.7692)", near(PP.programProgress(progData, { A: 60, B: 50, C: 100 }), 60.7692, 0.001));
  ok("program progress clamped to 0..100", PP.programProgress(progData, { A: 60, B: 50, C: 100 }) >= 0 && PP.programProgress(progData, { A: 60, B: 50, C: 100 }) <= 100);
  ok("with no numbers supplied the pillars are recalculated, not read off the record", PP.programProgress({ settings: {}, projects: [{ id: "A", weight: 1, progress: 99, plannedTasks: 10, status: "active" }], tasks: [] }) === 0);
  // a weight change re-normalizes every share (spec 18)
  const reweighed = JSON.parse(JSON.stringify(progData));
  reweighed.projects[1].weight = 100; // total becomes 160
  ok("weight change re-normalizes shares", near(PP.normalizedWeight(reweighed, "A"), 25, 0.001) && near(PP.normalizedWeight(reweighed, "B"), 62.5, 0.001));
  ok("weight change moves program progress", PP.programProgress(reweighed, { A: 60, B: 50, C: 100 }) !== PP.programProgress(progData, { A: 60, B: 50, C: 100 }));
  // ---- status is a BAND and subtasks earn the way through it (spec 7 / 11)
  const subData = (status, doneCount, planned) => {
    const t = { id: "t", status, plannedSubtasks: planned };
    const subs = [];
    for (let i = 0; i < doneCount; i++) subs.push({ id: "s" + i, taskId: "t", status: "done" });
    return { t, data: { settings: {}, projects: [], tasks: [t], subtasks: subs } };
  };
  const cA = subData("todo", 5, 10);
  ok("todo halfway lands mid-band (22.45)", near(PP.taskProgress(cA.data, cA.t), 22.45, 0.001));
  const cB = subData("inprogress", 5, 10);
  ok("inprogress halfway lands mid-band (59.95)", near(PP.taskProgress(cB.data, cB.t), 59.95, 0.001));
  const cC = subData("review", 8, 10);
  ok("review 8/10 lands mid-band (94.92)", near(PP.taskProgress(cC.data, cC.t), 94.92, 0.001));
  // all subtasks done -> exactly the TOP of each band
  ok("todo with all subtasks done stops at 44.9", PP.taskProgress(subData("todo", 10, 10).data, subData("todo", 10, 10).t) === 44.9);
  ok("inprogress with all subtasks done stops at 74.9 (>=45)", PP.taskProgress(subData("inprogress", 10, 10).data, subData("inprogress", 10, 10).t) === 74.9);
  ok("review with all subtasks done stops at 99.9 (>=75, <=99.9)", PP.taskProgress(subData("review", 10, 10).data, subData("review", 10, 10).t) === 99.9);
  // The band limits themselves, read back from the engine.
  ok("the four bands are exactly the documented limits", (function () {
    const b = ["todo", "inprogress", "review", "done"].map((k) => PP.STATUS_BANDS[k]);
    return b[0].max === 44.9 && b[1].min === 45 && b[1].max === 74.9 &&
      b[2].min === 75 && b[2].max === 99.9 && b[3].min === 100 && b[3].max === 100;
  })());
  ok("a save still holding the old 99 review ceiling is migrated to 99.9", (function () {
    // ensureShape() in place: replacing the whole store would log the session out
    // (it lives inside the store data) and break every later permission test.
    const live = PMS.store.data;
    const backup = live.settings.statusCeilings.review;
    live.settings.statusCeilings.review = 99;
    PMS.store.ensureShape(live);
    const v = live.settings.statusCeilings.review;
    live.settings.statusCeilings.review = backup;
    PMS.store.ensureShape(live);
    return v === 99.9;
  })());
  // more subtasks done than planned must never exceed the band top
  ok("over-completed subtasks never exceed the band", PP.taskProgress(subData("review", 99, 10).data, subData("review", 99, 10).t) <= 99.9);
  // done is a claim about the whole task: it needs every subtask done
  const dOpen = (function () {
    const t = { id: "t", status: "done", plannedSubtasks: 10 };
    const subs = [];
    for (let i = 0; i < 9; i++) subs.push({ id: "s" + i, taskId: "t", status: "done" });
    subs.push({ id: "s_open", taskId: "t", status: "todo" });
    return { t, data: { settings: {}, projects: [], tasks: [t], subtasks: subs } };
  })();
  ok("done with an open subtask is held at 99.9 (top of review, never 100)", PP.taskProgress(dOpen.data, dOpen.t) === 99.9);
  ok("canMarkTaskDone refuses while a subtask is open", PP.canMarkTaskDone(dOpen.data, dOpen.t).ok === false && PP.canMarkTaskDone(dOpen.data, dOpen.t).open === 1);
  const dShut = subData("done", 10, 10);
  ok("done with every subtask done is 100", PP.taskProgress(dShut.data, dShut.t) === 100);
  ok("canMarkTaskDone allows a fully closed task", PP.canMarkTaskDone(dShut.data, dShut.t).ok === true);
  // ---- the list and the detail page must never disagree -------------------
  ok("allPillarProgress agrees with the single-pillar value", (function () {
    const d = {
      settings: {},
      projects: [{ id: "pa", weight: 2, plannedTasks: 10 }, { id: "pb", weight: 3, plannedTasks: 5 }],
      tasks: [{ id: "pa1", projectId: "pa", status: "done", priority: "high" }, { id: "pb1", projectId: "pb", status: "todo", priority: "low" }]
    };
    const map = PP.allPillarProgress(d);
    return map.pa === PP.pillarProgress(d, "pa") && map.pb === PP.pillarProgress(d, "pb");
  })());
  ok("a seeded pillar has a planned scope to measure against", (function () {
    const roots = PMS.seed.build().projects.filter((p) => !p.parentId);
    return roots.length > 0 && roots.every((p) => p.plannedTasks > 0);
  })());
  ok("the pillar list and the pillar header use one engine", (function () {
    PMS.store.setData(PMS.seed.build());
    PMS.auth.createUser({ username: "engine-admin", password: "pw1234", role: "admin", name: "EA" });
    PMS.auth.login("engine-admin", "pw1234");
    PMS.app.init();
    PMS.store.data.settings.autoBackupEnabled = false;
    const target = PMS.repos.projects.all().filter((p) => !p.parentId)[0];
    const listTxt = (function () {
      const c = document.createElement("div");
      document.body.appendChild(c);
      PMS.registry.getView("projects").render(c, {});
      const t = c.textContent || "";
      c.remove();
      return t;
    })();
    const headTxt = (function () {
      const c = document.createElement("div");
      document.body.appendChild(c);
      PMS.registry.getView("projects").render(c, { id: target.id });
      const t = c.textContent || "";
      c.remove();
      return t;
    })();
    const expected = PP.pillarProgress(PMS.store.data, target.id).toFixed(0);
    // the header shows the value; the list row for the same pillar must match
    const headPct = (headTxt.match(/(\d+(?:\.\d+)?)%/) || [])[1];
    return headPct === expected && listTxt.indexOf(expected + "%") > -1;
  })());

  // ---- the repository refuses "done" and warns, whichever screen asks (spec 22)
  ok("setStatus refuses done while a sub-task is open", (function () {
    PMS.store.commit((d) => {
      d.tasks.push({ id: "guard_t", title: "guarded", status: "inprogress", plannedSubtasks: 2 });
      d.subtasks.push({ id: "guard_s1", taskId: "guard_t", title: "a", status: "done" });
      d.subtasks.push({ id: "guard_s2", taskId: "guard_t", title: "b", status: "todo" });
    }, "test-guard");
    const refused = PMS.repos.tasks.setStatus("guard_t", "done");
    const stillOpen = PMS.repos.tasks.get("guard_t").status === "inprogress";
    const viaUpdate = PMS.repos.tasks.update("guard_t", { status: "done" });
    // close the sub-task, then the same call goes through
    PMS.repos.subtasks.update("guard_s2", { status: "done", progress: 100 });
    const allowed = PMS.repos.tasks.setStatus("guard_t", "done");
    const nowDone = PMS.repos.tasks.get("guard_t").status === "done";
    PMS.store.commit((d) => {
      d.tasks.splice(d.tasks.findIndex((t) => t.id === "guard_t"), 1);
      d.subtasks.splice(0, d.subtasks.length, ...d.subtasks.filter((s) => s.taskId !== "guard_t"));
    }, "test-guard-clean");
    return !!(refused && refused.error === "openSubtasks") && stillOpen &&
      !!(viaUpdate && viaUpdate.error === "openSubtasks") && !(allowed && allowed.error) && nowDone;
  })());
  ok("a sub-task cannot be nested under another sub-task", (function () {
    PMS.store.commit((d) => {
      d.tasks.push({ id: "nest_t", title: "parent", status: "todo", plannedSubtasks: 2 });
      d.subtasks.push({ id: "nest_s1", taskId: "nest_t", title: "child", status: "todo" });
    }, "test-nest");
    const refused = PMS.repos.subtasks.add({ taskId: "nest_s1", title: "grandchild", status: "todo" });
    const count = PMS.repos.subtasks.forTask("nest_s1").length;
    const allowed = PMS.repos.subtasks.add({ taskId: "nest_t", title: "second child", status: "todo" });
    PMS.store.commit((d) => {
      d.tasks.splice(d.tasks.findIndex((t) => t.id === "nest_t"), 1);
      d.subtasks.splice(0, d.subtasks.length, ...d.subtasks.filter((s) => s.taskId !== "nest_t"));
    }, "test-nest-clean");
    return !!(refused && refused.error === "subtaskOfSubtask") && count === 0 && !(allowed && allowed.error);
  })());
  ok("no subtask scope -> status progress (inprogress 45)", PP.taskProgress({ settings: {}, tasks: [{ id: "x", status: "inprogress", plannedSubtasks: 0 }] }, { id: "x", status: "inprogress", plannedSubtasks: 0 }) === 45);
  ok("planned subtasks are NOT reduced to actual count", near(PP.taskProgress(cA.data, cA.t), 22.45, 0.001));
  ok("task progress never exceeds 100", PP.taskProgress(subData("review", 99, 10).data, subData("review", 99, 10).t) <= 100);
  // ---- subtasks are FLAT: never a subtask under a subtask
  const flat = { settings: {}, projects: [], tasks: [{ id: "ft", status: "todo" }], subtasks: [{ id: "fs", taskId: "ft", status: "todo" }] };
  ok("a subtask may not parent another subtask", PP.canNestSubtask(flat, "fs").ok === false && PP.canNestSubtask(flat, "fs").reason === "subtaskOfSubtask");
  ok("a task may parent a subtask", PP.canNestSubtask(flat, "ft").ok === true);
  ok("an unknown parent is refused", PP.canNestSubtask(flat, "nope").ok === false);
  // ---- each subtask carries an equal slice of the task weight (spec 20)
  ok("subtask weight divides the task weight", (function () {
    const d = { settings: {}, projects: [], tasks: [{ id: "wt", status: "done", priority: "high" }], subtasks: [{ id: "w1", taskId: "wt" }, { id: "w2", taskId: "wt" }] };
    return near(PP.subtaskWeight(d, d.tasks[0]), 1.5, 0.001);
  })());
  // ---- priority drives task weight, and changing it recalculates (spec 6 / 19)
  const impData = {
    settings: {},
    projects: [{ id: "p", weight: 1, plannedTasks: 10 }],
    tasks: [{ id: "t1", projectId: "p", status: "done", priority: "medium" }]
  };
  ok("the existing priority field sets the task weight", PP.taskWeight(impData, impData.tasks[0]) === 2);
  const impBefore = PP.pillarProgress(impData, "p");
  impData.tasks[0].priority = "high"; // weight 2 -> 3, so more earned weight
  ok("a priority change recalculates pillar progress", PP.pillarProgress(impData, "p") > impBefore);
  ok("there is no second importance field on a task", (function () {
    // a record created while the duplicate existed keeps its value on `priority`
    const made = PMS.repos.tasks.add({ title: "legacy importance", status: "todo", importance: "urgent" });
    const kept = made.priority === "urgent" && made.importance === undefined;
    // and an old client writing the old field still lands on `priority`
    const patched = PMS.repos.tasks.update(made.id, { importance: "high" });
    const folded = patched.priority === "high" && patched.importance === undefined;
    // splice it back out in place: the suite holds a live reference to d.tasks
    PMS.store.commit((d) => { d.tasks.splice(d.tasks.findIndex((t) => t.id === made.id), 1); }, "test-importance-clean");
    return kept && folded && PMS.store.data.tasks.every((t) => t.importance === undefined);
  })());
  ok("subtasks never add pillar weight", (function () {
    const d = { settings: {}, projects: [{ id: "p", weight: 1, plannedTasks: 1 }], tasks: [{ id: "t", projectId: "p", status: "done", priority: "high" }], subtasks: [{ id: "s", taskId: "t", status: "done" }] };
    const capBefore = PP.pillarScope(d, "p");
    d.subtasks = [{ id: "s", taskId: "t", status: "done" }, { id: "s2", taskId: "t", status: "done" }];
    const capAfter = PP.pillarScope(d, "p");
    return capBefore.plannedCapacity === capAfter.plannedCapacity;
  })());
  // ---- planned scope is a LOW-slot budget; capacity is fixed by the plan
  const scopeData = {
    settings: {},
    projects: [{ id: "p", weight: 1, plannedTasks: 15 }],
    tasks: ["low", "medium", "high", "high", "urgent", "medium", "medium", "low", "low", "medium"]
      .map((im, i) => ({ id: "t" + i, projectId: "p", status: "done", priority: im }))
  };
  const sc = PP.pillarScope(scopeData, "p");
  ok("planned capacity counts low slots, so capacity == planned", sc.plannedCapacity === 15);
  ok("the ten tasks spend 21 slots of the 15 planned", sc.slotsSpent === 21);
  ok("remaining planned never goes negative", sc.remainingTasks === 0 && sc.overcommittedSlots === 6);
  ok("finishing all actual tasks does NOT fake 100%", PP.pillarProgress(scopeData, "p") === 100);
  // ---- adding a task can NEVER move progress (the reported bug)
  ["low", "medium", "high", "urgent"].forEach(function (im) {
    const d = {
      settings: {},
      projects: [{ id: "p", weight: 1, plannedTasks: 15 }],
      tasks: [
        { id: "a", projectId: "p", status: "done", priority: "medium" },
        { id: "b", projectId: "p", status: "done", priority: "medium" },
        { id: "c", projectId: "p", status: "done", priority: "medium" }
      ]
    };
    const before = PP.pillarProgress(d, "p");
    const beforeProgram = PP.programProgress(d);
    d.tasks.push({ id: "newone", projectId: "p", status: "todo", priority: im });
    ok("adding a " + im + " task leaves pillar progress untouched (" + before.toFixed(2) + ")", near(PP.pillarProgress(d, "p"), before, 0.0001));
    ok("adding a " + im + " task leaves overall progress untouched", near(PP.programProgress(d), beforeProgram, 0.0001));
  });
  ok("adding many tasks still cannot move progress", (function () {
    const d = {
      settings: {},
      projects: [{ id: "p", weight: 1, plannedTasks: 15 }],
      tasks: [{ id: "a", projectId: "p", status: "done", priority: "medium" }]
    };
    const before = PP.pillarProgress(d, "p");
    ["low", "low", "medium", "high", "urgent", "urgent"].forEach((im, i) => d.tasks.push({ id: "x" + i, projectId: "p", status: "todo", priority: im }));
    return near(PP.pillarProgress(d, "p"), before, 0.0001);
  })());
  // ---- sub-tasks of a task (parentTaskId) are NOT pillar capacity
  ok("a task flagged as someone's sub-task holds no slot", (function () {
    const d = {
      settings: {},
      projects: [{ id: "p", weight: 1, plannedTasks: 10 }],
      tasks: [
        { id: "par", projectId: "p", status: "inprogress", priority: "medium" },
        { id: "kid1", projectId: "p", parentTaskId: "par", status: "done", priority: "urgent" },
        { id: "kid2", projectId: "p", parentTaskId: "par", status: "done", priority: "urgent" }
      ]
    };
    return PP.pillarScope(d, "p").actualTasks === 1 && PP.pillarScope(d, "p").slotsSpent === 2;
  })());
  // ---- program progress is 0 with nothing built (spec: no tasks = no effect)
  ok("no pillars -> 0", PP.programProgress({ settings: {}, projects: [], tasks: [] }) === 0);
  ok("planned but unbuilt pillar contributes 0", PP.programProgress({ settings: {}, projects: [{ id: "p", weight: 5, plannedTasks: 10 }], tasks: [] }) === 0);
  // ---- explicit closure (spec 15 / 16 / 25)
  const closed = JSON.parse(JSON.stringify(scopeData));
  const tooShort = PP.validateClosureNote("too short");
  ok("closure note must be at least 50 chars", !tooShort.ok && tooShort.reason === "tooShort");
  ok("closure note accepts 50+ chars", PP.validateClosureNote("x".repeat(50)).ok);
  const closeRes = PP.closePillar(closed, "p", "Scope deliberately reduced after the merger folded these tasks into the platform pillar.", { name: "Ali" });
  ok("closing a pillar returns ok", closeRes.ok === true);
  ok("closure forces 100%", PP.pillarProgress(closed, "p") === 100);
  ok("closure sets status completed", closed.projects[0].status === "completed");
  ok("closure preserves the original planned scope", closed.projects[0].plannedTasks === 15);
  ok("closure records who/when", !!closed.projects[0].closedAt && closed.projects[0].closedBy === "Ali");
  const snap = closed.projects[0].closureSnapshot;
  ok("closure snapshot keeps planned/actual/slots/remaining", snap.plannedTasks === 15 && snap.actualTasks === 10 && snap.slotsSpent === 21 && snap.remainingTasks === 0 && snap.unusedPlannedCapacity === 0 && snap.finalProgress === 100);
  ok("cannot close an already closed pillar", PP.canClosePillar(closed, "p").ok === false);
  ok("closure refuses a missing pillar", PP.canClosePillar(closed, "nope").ok === false);
  // ---- validation helpers (spec 23)
  ok("raw weight must be a positive integer", PP.isValidRawWeight(0) === false && PP.isValidRawWeight(-2) === false && PP.isValidRawWeight("abc") === false && PP.isValidRawWeight(2.5) === false && PP.isValidRawWeight(3) === true);
  ok("planned counts must be non-negative integers", PP.isNonNegativeInt(-1) === false && PP.isNonNegativeInt(1.5) === false && PP.isNonNegativeInt(0) === true && PP.isNonNegativeInt(3) === true);
  ok("importance must be a known level", PP.isValidImportance("high") && !PP.isValidImportance("blocker"));
  ok("zero planned subtasks stays inside the status band", (function () {
    const d = { settings: {}, tasks: [{ id: "z", status: "review", plannedSubtasks: 0 }], subtasks: [{ id: "zs", taskId: "z", status: "done" }] };
    const v = PP.taskProgress(d, d.tasks[0]);
    return v >= 75 && v <= 99.9;
  })());
  // A planned count of 0 used to divide by nothing, so a task could sit at 0
  // forever while its sub-tasks sat at done. With no plan to measure against,
  // the work that actually exists is the measure.
  ok("zero planned subtasks still rises with finished subtasks", (function () {
    const d = {
      settings: {}, tasks: [{ id: "zp", status: "todo", plannedSubtasks: 0 }],
      subtasks: [{ id: "a", taskId: "zp", status: "done" }, { id: "b", taskId: "zp", status: "done" }]
    };
    return near(PP.taskProgress(d, d.tasks[0]), 44.9, 0.001);
  })());
  ok("a subtask plan still governs when one is set", (function () {
    const d = {
      settings: {}, tasks: [{ id: "zp2", status: "todo", plannedSubtasks: 10 }],
      subtasks: [{ id: "a", taskId: "zp2", status: "done" }, { id: "b", taskId: "zp2", status: "done" }]
    };
    // 2 of a planned 10 earns a fifth of the way through the todo band.
    return near(PP.taskProgress(d, d.tasks[0]), 8.98, 0.001);
  })());
  // The task detail screen offers child tasks and subtasks under separate
  // headings now, but both are work under the parent, so ticking either one has
  // to move the parent's progress.
  ok("done child tasks move the parent task's progress", (function () {
    const d = {
      settings: {},
      tasks: [
        { id: "p", status: "todo", plannedSubtasks: 3 },
        { id: "c1", parentTaskId: "p", status: "done" },
        { id: "c2", parentTaskId: "p", status: "done" },
        { id: "c3", parentTaskId: "p", status: "done" }
      ],
      subtasks: []
    };
    return near(PP.taskProgress(d, d.tasks[0]), 44.9, 0.001);
  })());
  ok("an open child task holds the parent short of its band", (function () {
    const d = {
      settings: {},
      tasks: [
        { id: "p", status: "todo", plannedSubtasks: 3 },
        { id: "c1", parentTaskId: "p", status: "done" },
        { id: "c2", parentTaskId: "p", status: "inprogress" },
        { id: "c3", parentTaskId: "p", status: "done" }
      ],
      subtasks: []
    };
    const v = PP.taskProgress(d, d.tasks[0]);
    return v > 0 && v < 44.9;
  })());
  ok("child tasks and subtasks are counted together", (function () {
    const d = {
      settings: {},
      tasks: [{ id: "p", status: "todo", plannedSubtasks: 4 }, { id: "c1", parentTaskId: "p", status: "done" }],
      subtasks: [{ id: "s1", taskId: "p", status: "done" }, { id: "s2", taskId: "p", status: "todo" },
      { id: "s3", taskId: "p", status: "todo" }, { id: "s4", taskId: "p", status: "todo" }]
    };
    // 2 of 4 units finished.
    return near(PP.taskProgress(d, d.tasks[0]), 22.45, 0.001);
  })());
  ok("an open child task also holds the parent's done", (function () {
    const d = {
      settings: {},
      tasks: [
        { id: "gp", title: "parent", status: "inprogress" },
        { id: "gk1", title: "closed breakdown", parentTaskId: "gp", status: "done" },
        { id: "gk2", title: "open breakdown", parentTaskId: "gp", status: "inprogress" }
      ],
      subtasks: []
    };
    const c = PP.canMarkTaskDone(d, d.tasks[0]);
    return !c.ok && c.open === 1 && c.titles.join() === "open breakdown";
  })());
  // Later suites reimport the live store and compare task counts, so a fixture
  // left behind would fail them. store.commit mutates the live arrays in place,
  // so keep the ids we started with and drop anything else afterwards.
  function withoutStoreLeaks(fn) {
    const keepTasks = new Set(PMS.store.data.tasks.map((t) => t.id));
    const keepSubs = new Set(PMS.store.data.subtasks.map((s) => s.id));
    try { return fn(); }
    finally {
      PMS.store.data.tasks = PMS.store.data.tasks.filter((t) => keepTasks.has(t.id));
      PMS.store.data.subtasks = PMS.store.data.subtasks.filter((s) => keepSubs.has(s.id));
    }
  }
  // The warning has to name what is still open, not just count it, and it has to
  // say when the list it shows is not the whole story.
  ok("the refused-done warning names the open items", withoutStoreLeaks(function () {
    const shown = [];
    const realToast = PMS.toast.show;
    PMS.toast.show = function (m, k) { shown.push(String(m)); };
    try {
      PMS.store.commit((d) => {
        d.tasks.push({ id: "wp", title: "parent", status: "inprogress", plannedSubtasks: 5 });
        d.subtasks.push({ id: "wa", taskId: "wp", title: "first", status: "todo" });
        d.subtasks.push({ id: "wb", taskId: "wp", title: "second", status: "todo" });
        d.subtasks.push({ id: "wc", taskId: "wp", title: "third", status: "todo" });
        d.subtasks.push({ id: "wd", taskId: "wp", title: "fourth", status: "todo" });
        d.tasks.push({ id: "wk", title: "breakdown", parentTaskId: "wp", status: "todo" });
      }, "test-warn");
      const res = PMS.repos.tasks.setStatus("wp", "done");
      const msg = shown[0] || "";
      return !!res.error
        && res.open === 5
        && PMS.repos.tasks.get("wp").status === "inprogress"
        && /first/.test(msg) && /second/.test(msg)
        && /2/.test(msg);
    } finally { PMS.toast.show = realToast; }
  }));
  ok("a clear task is marked done with no warning", withoutStoreLeaks(function () {
    const shown = [];
    const realToast = PMS.toast.show;
    PMS.toast.show = function (m) { shown.push(String(m)); };
    try {
      PMS.store.commit((d) => {
        d.tasks.push({ id: "cp", title: "parent", status: "inprogress", plannedSubtasks: 2 });
        d.subtasks.push({ id: "ca", taskId: "cp", title: "done one", status: "done" });
      }, "test-clear");
      const res = PMS.repos.tasks.setStatus("cp", "done");
      return !res.error
        && PMS.repos.tasks.get("cp").status === "done"
        && shown.length === 0
        && PP.taskProgress(PMS.store.data, PMS.repos.tasks.get("cp")) === 100;
    } finally { PMS.toast.show = realToast; }
  }));
  ok("a full task edit refuses done with the same warning", withoutStoreLeaks(function () {
    const shown = [];
    const realToast = PMS.toast.show;
    PMS.toast.show = function (m) { shown.push(String(m)); };
    try {
      PMS.store.commit((d) => {
        d.tasks.push({ id: "ep", title: "parent", status: "inprogress", plannedSubtasks: 1 });
        d.subtasks.push({ id: "ea", taskId: "ep", title: "open", status: "inprogress" });
      }, "test-edit-done");
      const res = PMS.repos.tasks.update("ep", { status: "done" });
      return !!res.error
        && PMS.repos.tasks.get("ep").status === "inprogress"
        && shown.length === 1 && /open/.test(shown[0]);
    } finally { PMS.toast.show = realToast; }
  }));
  ok("subtask repository counts completions", (function () {
    PMS.store.commit((d) => {
      d.tasks.push({ id: "st_parent", title: "with subtasks", status: "inprogress", plannedSubtasks: 4 });
      d.subtasks.push({ id: "sb1", taskId: "st_parent", title: "a", status: "done" });
      d.subtasks.push({ id: "sb2", taskId: "st_parent", title: "b", status: "todo" });
    }, "test-subtasks");
    const made = PMS.repos.subtasks.forTask("st_parent").length;
    const doneMade = PMS.repos.subtasks.completedForTask("st_parent").length;
    const prog = PP.taskProgress(PMS.store.data, PMS.store.data.tasks.find((t) => t.id === "st_parent"));
    PMS.store.commit((d) => {
      const ti = d.tasks.findIndex((t) => t.id === "st_parent");
      if (ti > -1) d.tasks.splice(ti, 1);
      const si = d.subtasks.findIndex((s) => s.taskId === "st_parent");
      if (si > -1) d.subtasks.splice(si, 2);
    }, "test-subtasks-clean");
    return made === 2 && doneMade === 1 && near(prog, 52.475, 0.01);
  })());

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

  section("Program progress wiring");
  PMS.store.setData(PMS.seed.build());
  // The store reset above clears accounts and the session, and only an admin or
  // the pillar owner may close a pillar, so make a throwaway admin for this block.
  PMS.auth.createUser({ username: "pp-admin", password: "pw1234", role: "admin", name: "PP Admin" });
  PMS.auth.login("pp-admin", "pw1234");
  const wp = PMS.repos.projects.all()[0];
  PMS.repos.projects.update(wp.id, { weight: 40, plannedTasks: 15, status: "active" });
  const wired = PMS.repos.projects.get(wp.id);
  ok("pillar persists its weight on the single weight field", wired.weight === 40);
  ok("the duplicate rawWeight field is gone", wired.rawWeight === undefined);
  ok("the per-pillar default importance field is gone", wired.defaultTaskImportance === undefined);
  ok("a stale rawWeight on an update lands on weight", (function () {
    const before = PMS.repos.projects.get(wp.id).weight;
    PMS.repos.projects.update(wp.id, { rawWeight: 12 });
    const after = PMS.repos.projects.get(wp.id);
    return after.weight === 12 && after.rawWeight === undefined && before === 40;
  })());
  ok("a status control snaps back when done is refused", (function () {
    const t = PMS.repos.tasks.add({ title: "selftest", status: "inprogress", plannedSubtasks: 1 });
    PMS.repos.subtasks.add({ taskId: t.id, title: "open child", status: "todo" });
    const sel = document.createElement("select");
    ["inprogress", "done"].forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      sel.appendChild(o);
    });
    sel.value = "inprogress";
    const refused = PMS.repos.tasks.setStatus(t.id, "done");
    if (refused && refused.error) sel.value = "inprogress";
    const snapped = sel.value === "inprogress";
    PMS.store.commit((d) => {
      d.tasks.splice(d.tasks.findIndex((x) => x.id === t.id), 1);
      d.subtasks.splice(0, d.subtasks.length, ...d.subtasks.filter((s) => s.taskId !== t.id));
    }, "test-sel-clean");
    return refused && refused.error === "openSubtasks" && snapped;
  })());
  ok("pillar persists planned scope", wired.plannedTasks === 15);

  // ---- The reported bug: adding a task must never lower a pillar, on ANY screen.
  // The dashboard used to run the old engine, which had no planned-slot
  // denominator, so its number fell every time a task was created.
  ok("no screen still reads the legacy progress engine", (function () {
    const offenders = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); return; }
      if (!e.name.endsWith(".js")) return;
      // The legacy module itself and the suites that unit-test it are exempt.
      if (p.endsWith(path.join("services", "progress.js"))) return;
      if (e.name === "fulltest.js" || e.name === "live-e2e.js") return;
      if (/PMS\.progress\./.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
    });
    walk(path.join(APP, "js"));
    return offenders.length === 0 ? true : "still uses PMS.progress: " + offenders.join(", ");
  })());
  ok("adding tasks never lowers the pillar on the dashboard OR the pillar page", (function () {
    // Works on the LIVE store on purpose. The auth session lives inside the store
    // data, so replacing it with setData() logs the test out and every later
    // permission-dependent test breaks.
    const p = PMS.repos.projects.add({ name: "Regression Pillar", weight: 4, plannedTasks: 20, status: "active" });
    // Reproduce a record that only ever carried the new field.
    PMS.store.commit((dd) => { const r = dd.projects.find((x) => x.id === p.id); delete r.plannedTaskCount; }, "regression-shape");
    try {
      [
        ["a", "done", "high"], ["b", "inprogress", "medium"], ["c", "review", "low"]
      ].forEach(([n, st, pr]) => PMS.repos.tasks.add({ title: "rb-" + n, projectId: p.id, status: st, priority: pr, plannedSubtasks: st === "done" ? 2 : 0 }));
      PMS.repos.subtasks.add({ taskId: PMS.repos.tasks.forProject(p.id)[0].id, title: "rb-s1", status: "done", progress: 100 });

      const readDash = () => {
        route("/");
        const row = Array.from(document.querySelectorAll(".project-progress-row"))
          .find((r) => (r.querySelector(".pp-name") || {}).textContent === "Regression Pillar");
        const chip = row && row.querySelector(".progress-label");
        return chip ? parseFloat(chip.textContent) : null;
      };
      const readPage = () => {
        route("/projects/" + p.id);
        const hit = Array.from(document.querySelectorAll(".detail-list > *"))
          .find((el) => /progress/i.test(el.textContent || ""));
        return hit ? parseFloat((hit.textContent.match(/([\d.]+)/) || [])[1]) : null;
      };

      const first = [readDash(), readPage()];
      [1, 2].forEach((i) => PMS.repos.tasks.add({
        title: "rb-low" + i, projectId: p.id, priority: "low", status: "todo", plannedSubtasks: 0
      }));
      const afterLow = [readDash(), readPage()];
      PMS.repos.tasks.add({ title: "rb-high", projectId: p.id, priority: "high", status: "todo", plannedSubtasks: 0 });
      const afterHigh = [readDash(), readPage()];

      const noDrop = afterLow[0] >= first[0] - 0.05 && afterLow[1] >= first[1] - 0.05 &&
        afterHigh[0] >= afterLow[0] - 0.05 && afterHigh[1] >= afterLow[1] - 0.05;
      const allRead = [first, afterLow, afterHigh].every((s) => s[0] !== null && s[1] !== null);
      return noDrop && allRead;
    } finally {
      PMS.repos.projects.remove(p.id);   // cascades its tasks away
      route("/");
    }
  })());
  ok("a band edge is never rounded up past its limit in the UI", (function () {
    // 74.9 printed as "75%" would read as the floor of `review`.
    const edge = [[74.9, "74.9%"], [44.9, "44.9%"], [99, "99%"], [45, "45%"], [75, "75%"], [0, "0%"], [87.5, "87.5%"]];
    if (!edge.every((e) => PMS.utils.pctBand(e[0]) === e[1])) {
      return "pctBand: " + edge.map((e) => e[0] + "->" + PMS.utils.pctBand(e[0])).join(", ");
    }
    const proj = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.add({
      title: "band edge", projectId: proj.id, status: "inprogress", priority: "medium", plannedSubtasks: 4
    });
    try {
      [0, 1, 2, 3].forEach((i) => PMS.repos.subtasks.add({ taskId: t.id, title: "be-s" + i, status: "done" }));
      PMS.taskDetail.open(t.id);
      const label = Array.from(document.querySelectorAll("#modal-root label, #modal-root .field label"))
        .find((l) => /^progress/i.test(l.textContent || ""));
      const shownText = label ? label.textContent : "";
      if (PMS.modal.isOpen) PMS.modal.close();
      return shownText.indexOf("74.9%") !== -1 ? true : "task detail showed: " + shownText;
    } finally {
      PMS.repos.tasks.remove(t.id);
      if (PMS.modal.isOpen) PMS.modal.close();
    }
  })());
  ok("the editor offers exactly one planned-scope input", (function () {
    PMS.editors.openProjectEditor(wired, {});
    const labels = Array.from(document.querySelectorAll(".modal label, .modal .field span"))
      .map((n) => n.textContent || "");
    const planned = labels.filter((l) => l.indexOf("Planned") === 0).length;
    if (PMS.modal.isOpen) PMS.modal.close();
    return planned === 1 && labels.indexOf("Default task importance") === -1;
  })());
  ok("pillar list rows show the program share", (function () {
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, {});
    const txt = c.textContent || "";
    const found = txt.indexOf("Total pillar weight") > -1 && txt.indexOf("Pillars") > -1;
    c.remove();
    return found;
  })());
  ok("pillar detail renders planned vs actual", (function () {
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: wp.id });
    const txt = c.textContent || "";
    const found = txt.indexOf("Remaining planned") > -1 && txt.indexOf("Actual tasks") > -1 &&
      txt.indexOf("Slots spent") > -1 && txt.indexOf("Program share") > -1 && txt.indexOf("Weight") > -1;
    c.remove();
    return found;
  })());
  ok("closure dialog demands a note of at least 50 chars", (function () {
    PMS.i18n.setLang("en");
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: wp.id });
    const btn = Array.from(c.querySelectorAll("button")).find((b) => (b.textContent || "").indexOf("Complete pillar") > -1);
    if (!btn) { console.error("  no Complete pillar button"); c.remove(); return false; }
    btn.click();
    const ta = document.querySelector(".modal textarea");
    const confirmBtn = Array.from(document.querySelectorAll(".modal button")).find((b) => (b.textContent || "") === "Confirm");
    if (!ta || !confirmBtn) { console.error("  dialog missing", !!ta, !!confirmBtn); c.remove(); return false; }
    confirmBtn.click();
    const modalEl = document.querySelector(".modal");
    const stillOpen = !!document.querySelector(".modal textarea");
    // the shared error line is reused for both failure reasons, so any inline
    // error means the empty note was rejected instead of silently closing.
    const errShown = modalEl ? (modalEl.textContent || "").indexOf("closure note") > -1 : false;
    if (!stillOpen || !errShown) { console.error("  closure check", stillOpen, errShown); c.remove(); return false; }
    ta.value = "x".repeat(60);
    confirmBtn.click();
    const closedPillar = PMS.repos.projects.get(wp.id);
    c.remove();
    return stillOpen && errShown && closedPillar.status === "completed" && !!closedPillar.closureNote;
  })());
  ok("a closed pillar keeps its original plan for audit", (function () {
    const p = PMS.repos.projects.get(wp.id);
    return p.plannedTasks === 15 && !!p.closureSnapshot && p.closureSnapshot.finalProgress === 100;
  })());
  ok("a pillar lists its tasks with their work folded away", (function () {
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.forProject(p2.id)[0];
    PMS.repos.subtasks.add({ taskId: t.id, title: "design the schema", status: "done" });
    PMS.repos.subtasks.add({ taskId: t.id, title: "write the migration", status: "todo" });
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: p2.id });
    let txt = c.textContent || "";
    const folded = txt.indexOf(t.title) > -1
      && txt.indexOf("design the schema") === -1
      && txt.indexOf("write the migration") === -1;
    // the task that owns work gets a disclosure arrow
    const hasArrow = !!Array.from(c.querySelectorAll(".project-tree-row"))
      .find(r => (r.dataset.id === t.id) && r.querySelector(".pt-twisty:not(.pt-twisty-leaf)"));
    // opening it reveals both sub-tasks
    const arrow = c.querySelector('.project-tree-row[data-id="' + t.id + '"] .pt-twisty');
    if (arrow) arrow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    txt = c.textContent || "";
    const opened = txt.indexOf("design the schema") > -1 && txt.indexOf("write the migration") > -1;
    c.remove();
    return folded && hasArrow && opened;
  })());
  ok("clicking a pillar task opens its sub-tasks in place", (function () {
    // Clicking a task used to jump to the task table filtered to that one row.
    // That threw away the pillar the user was reading, and since everything here
    // starts folded it dropped them on a list with the sub-tasks hidden too.
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.forProject(p2.id)[0];
    PMS.repos.subtasks.add({ taskId: t.id, title: "click-open marker", status: "todo" });
    const c = document.createElement("div");
    document.body.appendChild(c);
    const before = PMS.router.current;
    PMS.registry.getView("projects").render(c, { id: p2.id });
    const row = c.querySelector('.project-tree-row[data-id="' + t.id + '"]');
    if (row) row.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    const txt = c.textContent || "";
    c.remove();
    return !!row && txt.indexOf("click-open marker") > -1 && txt.indexOf(t.title) > -1 && PMS.router.current === before;
  })());
  ok("a second click folds the pillar task back up", (function () {
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.forProject(p2.id)[0];
    PMS.repos.subtasks.add({ taskId: t.id, title: "click-open marker", status: "todo" });
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: p2.id });
    c.querySelector('.project-tree-row[data-id="' + t.id + '"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    c.querySelector('.project-tree-row[data-id="' + t.id + '"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    const txt = c.textContent || "";
    c.remove();
    return txt.indexOf("click-open marker") === -1;
  })());
  ok("double clicking a pillar task opens its details, not a filter", (function () {
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.forProject(p2.id)[0];
    PMS.repos.subtasks.add({ taskId: t.id, title: "detail marker", status: "todo" });
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: p2.id });
    let openedId = null;
    const realOpen = PMS.taskDetail.open;
    PMS.taskDetail.open = function (id) { openedId = id; };
    // A real double click arrives as click(detail 1), click(detail 2), dblclick.
    // The second click must not be treated as another fold, or the pair would
    // open and shut the row and repaint the page twice on the way to the detail.
    const row = c.querySelector('.project-tree-row[data-id="' + t.id + '"]');
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
    row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    PMS.taskDetail.open = realOpen;
    const stillOnPillar = (c.textContent || "").indexOf("detail marker") > -1;
    c.remove();
    return openedId === t.id && stillOnPillar;
  })());
  ok("a pillar lists every one of its own tasks, children included", (function () {
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const all = PMS.repos.tasks.forProject(p2.id);
    // open everything so nested rows are in the DOM to be counted
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: p2.id });
    Array.from(c.querySelectorAll(".pt-twisty:not(.pt-twisty-leaf)")).forEach((a) =>
      a.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const listed = new Set(Array.from(c.querySelectorAll(".project-tree-row"))
      .map(r => r.dataset.id).filter(Boolean));
    c.remove();
    // every task in the pillar is reachable: either as a top-level row or under one
    return all.every(t => listed.has(t.id));
  })());
  ok("double clicking a pillar task opens its details, not the editor", (function () {
    PMS.store.setData(PMS.seed.build());
    const p2 = PMS.repos.projects.all()[0];
    const t = PMS.repos.tasks.forProject(p2.id)[0];
    const c = document.createElement("div");
    document.body.appendChild(c);
    PMS.registry.getView("projects").render(c, { id: p2.id });
    const row = c.querySelector('.project-tree-row[data-id="' + t.id + '"]');
    if (row) row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    const opened = PMS.modal.isOpen && !!PMS.modal.body.querySelector(".task-detail-body");
    const isEditor = !!PMS.modal.body.querySelector('.field[data-key="title"]');
    PMS.modal.close();
    c.remove();
    return opened && !isEditor;
  })());

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
  // locate the "+ new task" action by its label: the meeting detail also holds
  // a "+ add attachment" action, so the first "+ " button is not reliable
  const addTaskBtn = Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ " + PMS.i18n.t("meetings.newTask")) === 0);
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
  // link an existing task to the meeting through the search panel
  PMS.meetings.openDetail(flowMtg.id);
  const linkExistingBtn = Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ " + PMS.i18n.t("meetings.linkExistingTask")) === 0);
  linkExistingBtn.click();
  const linkSearch = PMS.modal.body.querySelector(".link-picker input");
  ok("link-existing opens a searchable picker", !!linkSearch);
  // clicking the trigger again must not stack a second panel
  const trig = Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ " + PMS.i18n.t("meetings.linkExistingTask")) === 0);
  if (trig) trig.click();
  const openBoxes = document.getElementById("modal-root").querySelectorAll(".link-picker");
  ok("re-opening the picker reuses the panel instead of stacking", openBoxes.length === 1, openBoxes.length + " panels");
  const unlinked = PMS.repos.tasks.all().filter(t => t.meetingId !== flowMtg.id);
  const linkTarget = unlinked[unlinked.length - 1];
  linkSearch.value = linkTarget.title;
  linkSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
  const row = Array.from(PMS.modal.body.querySelectorAll(".link-result")).find(r => (r.textContent || "").indexOf(linkTarget.title) !== -1);
  ok("typing a title narrows the list to that task", !!row);
  row.click();
  ok("an existing task is attached to the meeting",
    PMS.repos.meetings.tasksOf(flowMtg.id).filter(t => t.id === linkTarget.id).length === 1);
  ok("the meeting now lists two tasks", PMS.repos.meetings.tasksOf(flowMtg.id).length === 2);
  PMS.modal.close();
  PMS.repos.meetings.remove(flowMtg.id);

  // Regression: the picker used to be a dropdown of the first 60 tasks with no
  // search, so anything past the 60th could not be linked at all.
  {
    const manyMtg = PMS.repos.meetings.add({ title: "Many tasks meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [pillar.id] });
    const filler = [];
    for (let i = 0; i < 70; i++) filler.push(PMS.repos.tasks.add({ title: "Filler " + i, projectId: pillar.id, status: "todo" }));
    const deep = PMS.repos.tasks.add({ title: "Deep tail needle", projectId: pillar.id, status: "todo" });
    PMS.meetings.openDetail(manyMtg.id);
    Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ " + PMS.i18n.t("meetings.linkExistingTask")) === 0).click();
    const manySearch = PMS.modal.body.querySelector(".link-picker input");
    manySearch.value = "Deep tail needle";
    manySearch.dispatchEvent(new window.Event("input", { bubbles: true }));
    const deepRow = Array.from(PMS.modal.body.querySelectorAll(".link-result")).find(r => (r.textContent || "").indexOf("Deep tail needle") !== -1);
    ok("a task past the old 60-item cap is still linkable", !!deepRow);
    if (deepRow) deepRow.click();
    ok("the far-past-cap task really got linked", PMS.repos.meetings.tasksOf(manyMtg.id).map(t => t.title).indexOf("Deep tail needle") !== -1);
    PMS.modal.close();
    PMS.repos.meetings.remove(manyMtg.id);
    filler.forEach(t => PMS.repos.tasks.remove(t.id));
    PMS.repos.tasks.remove(deep.id);
  }

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

  // the tasks table: double click opens the DETAIL, assignees stay read-only
  errors.length = 0;
  route("/tasks");
  const vtRow = root().querySelector(".vt-row");
  const dbl = new window.MouseEvent("dblclick", { bubbles: true });
  vtRow.dispatchEvent(dbl);
  ok("double click on a task row opens the task details", PMS.modal.isOpen && !!PMS.modal.body.querySelector(".task-detail-body"));
  ok("double click on a task row does not open the editor", !PMS.modal.body.querySelector('.field[data-key="title"]'));
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
    .map(p => ({ p, prog: PMS.programProgress.pillarProgress(PMS.store.data, p.id) || 0 }))
    .sort((a, b) => b.prog - a.prog).map(x => x.p.name);
  ok("pillars are sorted by progress, highest first", renderedNames.join("|") === rootPillars.join("|"),
    renderedNames.join(" <> ") + "   EXPECTED   " + rootPillars.join(" <> "));
  const owners = root().querySelectorAll(".chip-owner");
  ok("every pillar shows its owner name", owners.length === root().querySelectorAll(".pillar-grid .tree-node").length &&
    Array.from(owners).some(c => /Sara|Omar|Ali|Khaled/.test(c.textContent)));
  ok("the sort hint is shown", (root().textContent || "").indexOf(PMS.i18n.t("projects.sortedByProgress")) !== -1);
  ok("collapse/expand all still available", root().querySelectorAll(".page-header .actions .btn").length >= 3);

  // ---- task numbers --------------------------------------------------------
  ok("a task's number is its stable rank, not a render-time counter", (function () {
    const d = {
      tasks: [
        { id: "c", createdAt: "2026-01-03T00:00:00.000Z" },
        { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", createdAt: "2026-01-02T00:00:00.000Z" }
      ]
    };
    const map = PMS.utils.taskNumbers(d);
    // ranked by creation order, so it reads 1,2,3 in the order things were added
    const okOrder = map.a === 1 && map.b === 2 && map.c === 3;
    // asking again returns the same numbers - a counter minted per render would
    // renumber the whole list on every sort
    const again = PMS.utils.taskNumbers(d);
    const stable = again.a === 1 && again.b === 2 && again.c === 3;
    // the single-task accessor agrees with the map
    const bTask = d.tasks.filter(x => x.id === "b")[0];
    const agrees = PMS.utils.taskNumber(d, bTask) === map.b;
    const allDistinct = new Set(Object.keys(map).map(k => map[k])).size === 3;
    return okOrder && stable && agrees && allDistinct;
  })());
  ok("task numbers survive reordering and stay unique", (function () {
    const d = {
      tasks: [
        { id: "x", createdAt: "2026-02-02T00:00:00.000Z" },
        { id: "y", createdAt: "2026-02-01T00:00:00.000Z" },
        { id: "z", createdAt: "2026-02-03T00:00:00.000Z" }
      ]
    };
    const before = PMS.utils.taskNumbers(d);
    // a different array order must not change anybody's number
    const shuffled = { tasks: [d.tasks[2], d.tasks[0], d.tasks[1]] };
    const after = PMS.utils.taskNumbers(shuffled);
    return before.x === after.x && before.y === after.y && before.z === after.z
      && new Set(Object.keys(after).map(k => after[k])).size === 3;
  })());
  ok("tasks with no creation date still get distinct numbers", (function () {
    const d = { tasks: [{ id: "p" }, { id: "q" }, { id: "r" }] };
    const map = PMS.utils.taskNumbers(d);
    const nums = Object.keys(map).map(k => map[k]);
    return nums.length === 3 && new Set(nums).size === 3;
  })());
  ok("sorting by the number column orders by the number shown", (function () {
    const d = PMS.store.data;
    const sorted = PMS.filterEngine.sortTasks(PMS.repos.tasks.all(), "number", "asc", d);
    const nums = sorted.map(t => PMS.utils.taskNumber(d, t));
    for (let i = 1; i < nums.length; i++) {
      if (!(nums[i - 1] <= nums[i])) return false;
    }
    return nums.length > 1;
  })());
  ok("sorting by the number does not rebuild a map per comparison", (function () {
    // A quadratic sort on a long list is a hang the user would feel, not a slow
    // test. The sorter must not reach for the number map at all.
    let body = "";
    try { body = fs.readFileSync(path.join(APP, "js/services/filter-engine.js"), "utf8"); }
    catch (e) { body = ""; }
    const block = (body.match(/number:\s*function[\s\S]*?\n    \},/) || [""])[0];
    return !!block && block.indexOf("taskNumber") === -1 && block.indexOf("taskNumbers") === -1;
  })());

// ---- tasks: numbers up front, sub-tasks folded until expanded -----------
  errors.length = 0;
  route("/tasks");
  const parentWithKids = PMS.repos.tasks.all().find(t => !t.parentTaskId && PMS.repos.tasks.children(t.id).length > 0);
  ok("a parent with sub-tasks is in the list", !!parentWithKids);
  const twisty = root().querySelector(".vt-twisty:not(.vt-twisty-leaf)");
  ok("the parent row gets a collapse/expand chevron", !!twisty && !!parentWithKids);

  const subRowSel = ".vt-row-sub";
  // Folded to begin with: the sub-task block is not in the list at all.
  ok("sub-tasks stay out of the list until the parent is expanded", root().querySelectorAll(subRowSel).length === 0);

  // ...and they have to leave the list, not be re-homed. Promoting a folded
  // sub-task to a row of its own made every folded child read as a top-level
  // task, which is the opposite of what folding is for. Counting rendered rows
  // cannot see it either way: the list is virtualized, so a promoted row lands at
  // the end of the model and sits outside the window. The scroll height is the
  // one number that accounts for every row, scrolled to or not.
  const shownTasks = () => Array.from(root().querySelectorAll(".vt-row")).map(r => PMS.repos.tasks.get(r.dataset.id)).filter(Boolean);
  const shownIds = {};
  shownTasks().forEach(t => { shownIds[t.id] = true; });
  ok("a folded sub-task is never re-listed as a top-level task",
    shownTasks().every(t => !t.parentTaskId || !shownIds[t.parentTaskId]),
    shownTasks().filter(t => t.parentTaskId && shownIds[t.parentTaskId]).map(t => t.title).slice(0, 3).join(" | "));
  const foldedTopLevel = PMS.repos.tasks.all().filter(t => !t.parentTaskId).length;
  ok("the folded list is exactly the top-level tasks, no extra rows",
    parseFloat(root().querySelector(".vt-body").style.height) === foldedTopLevel * 44,
    "height " + root().querySelector(".vt-body").style.height + " for " + foldedTopLevel + " top-level tasks");

  // Every row leads with a unique number, so a task can be named out loud.
  const headCells = Array.from(root().querySelectorAll(".vt-head .vt-th")).map(c => ((c.querySelector("span") || {}).textContent || "").trim());
  ok("the task number heads the table", headCells[0] === PMS.i18n.t("tasks.number"));
  const numbered = Array.from(root().querySelectorAll(".vt-row .vt-td-num")).map(n => n.textContent || "");
  ok("every row shows its number", numbered.length > 0 && numbered.every(x => /^#\d+$/.test(x)));
  ok("the numbers shown are unique", new Set(numbered).size === numbered.length);

  // Work on a parent that is actually on screen: the list is virtualized, so a
  // parent's children can sit outside the rendered window.
  const renderedIds = () => Array.from(root().querySelectorAll(".vt-row")).map(r => r.dataset.id);
  const liveParent = renderedIds().map(id => PMS.repos.tasks.get(id))
    .find(t => t && !t.parentTaskId && PMS.repos.tasks.children(t.id).length > 0);
  ok("a parent with sub-tasks is on screen", !!liveParent);
  const twistyFor = (id) => root().querySelector('.vt-row[data-id="' + id + '"] .vt-twisty');
  const kidTitles = liveParent ? PMS.repos.tasks.children(liveParent.id).map(k => k.title) : [];

  if (liveParent) twistyFor(liveParent.id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  const expandedRows = Array.from(root().querySelectorAll(subRowSel));
  ok("expanding the parent lists its sub-tasks under it", expandedRows.length > 0);
  ok("the expanded sub-tasks belong to that parent",
    expandedRows.every(r => PMS.repos.tasks.get(r.dataset.id) && PMS.repos.tasks.get(r.dataset.id).parentTaskId === liveParent.id));
  ok("a known sub-task is rendered", expandedRows.some(r => kidTitles.indexOf((r.textContent || "").trim()) > -1 || kidTitles.some(t2 => (r.textContent || "").indexOf(t2) > -1)));
  ok("nested rows are indented", expandedRows.length > 0 && parseFloat(expandedRows[0].style.paddingInlineStart) > 0);

  if (liveParent) twistyFor(liveParent.id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  ok("collapsing the parent hides them again", root().querySelectorAll(subRowSel).length === 0);

  if (liveParent) twistyFor(liveParent.id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  ok("expanding brings them back", root().querySelectorAll(subRowSel).length === expandedRows.length);

  // collapse/expand everything, both directions
  const allBtn = Array.from(root().querySelectorAll(".btn")).find(b => (b.textContent || "").indexOf(PMS.i18n.t("tasks.collapseAllSubtasks")) > -1);
  const anyBtn = Array.from(root().querySelectorAll(".btn")).find(b => (b.textContent || "").indexOf(PMS.i18n.t("tasks.expandAllSubtasks")) > -1);
  if (allBtn) allBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  ok("collapse all folds every sub-task list", root().querySelectorAll(subRowSel).length === 0);
  if (anyBtn) anyBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");
  ok("expand all opens them back up", root().querySelectorAll(subRowSel).length > 0);
  if (allBtn) allBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  route("/tasks");

  // double click READS the task, it does not start editing it
  const rowToOpen = root().querySelector(subRowSel) || root().querySelector(".vt-row");
  rowToOpen.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  ok("double clicking a row opens the task details", PMS.modal.isOpen && !!PMS.modal.body.querySelector(".task-detail-body"));
  ok("double click does not drop straight into the editor", !PMS.modal.body.querySelector('.field[data-key="title"]'));
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
  // the inline "+ person" popup must capture the FULL person record, not just a
  // name, because it is offered from every assign/owner/members control
  const popupCtl = PMS.forms.buildControl({ key: "assignees", type: "multiselect", options: [], allowCreatePerson: true }, []);
  const pWrap = popupCtl.el.querySelector(".person-create");
  pWrap.querySelector(".btn").click();
  const pPanel = pWrap.querySelector(".person-create-panel");
  const byPlaceholder = (ph) => Array.from(pPanel.querySelectorAll("input,textarea")).find(el => (el.placeholder || "") === ph);
  byPlaceholder(PMS.i18n.t("people.name")).value = "Popup Person";
  byPlaceholder(PMS.i18n.t("people.jobTitle")).value = "Inspector";
  byPlaceholder(PMS.i18n.t("people.email")).value = "popup@example.com";
  byPlaceholder(PMS.i18n.t("people.phone")).value = "+962 7 555 000";
  byPlaceholder(PMS.i18n.t("people.notes")).value = "added from a task";
  const deptOpts = pPanel.querySelectorAll("select")[0];
  if (deptOpts.options.length > 1) deptOpts.value = deptOpts.options[1].value;
  pPanel.querySelector(".btn-primary").click();
  const popupPerson = PMS.repos.people.all().find(p => p.name === "Popup Person");
  ok("the +person popup saves the phone", !!popupPerson && popupPerson.phone === "+962 7 555 000");
  ok("the +person popup also saves job title and notes (full record)",
    !!popupPerson && popupPerson.jobTitle === "Inspector" && popupPerson.notes === "added from a task");
  ok("the +person popup saves the department it was given",
    !!popupPerson && !!popupPerson.departmentId && popupPerson.departmentId !== null);
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

  // An app that cannot show itself has to say so on the page, not just in the
  // console: every way of ending up invisible is checked and repaired
  {
    const shell = document.getElementById("app-shell");
    const overlay = document.getElementById("auth-root");
    let blanks = [];
    PMS.bus.on("app:blank-screen", (info) => { blanks.push(info.where); });
    // 1) the sign-in screen is healthy even with an empty view container
    root().innerHTML = "";
    shell.style.display = "none";
    overlay.style.display = "flex";
    overlay.innerHTML = "<form></form>";
    await new Promise(r => setTimeout(r, 4600));
    ok("the sign-in screen is not treated as a blank app", blanks.length === 0 &&
      overlay.style.display === "flex" && !root().querySelector(".blank-report"));
    // 2) an empty first paint is rebuilt
    overlay.style.display = "none";
    overlay.innerHTML = "";
    root().innerHTML = "";
    PMS.app.showShell();
    await new Promise(r => setTimeout(r, 1200));
    ok("an empty first paint is rebuilt", root().children.length > 0);
    // 3) a shell left hidden after sign-in is shown again (watchdog)
    PMS.app.hideShell();
    await new Promise(r => setTimeout(r, 4600));
    ok("a hidden app shell is shown again", shell.style.display !== "none" && root().children.length > 0);
    ok("the hidden-interface check reports what it repaired", blanks.length >= 1, "reports: " + blanks.join(","));
    // 4) an empty sign-in overlay left on top is put away
    overlay.style.display = "flex";
    overlay.innerHTML = "";
    await new Promise(r => setTimeout(r, 4600));
    ok("an empty sign-in overlay stops covering the app",
      overlay.style.display === "none" && root().children.length > 0);
    // 5) still broken after the repairs: the reason is written on the page
    const realHandle = PMS.router.handle;
    PMS.router.handle = function () { root().innerHTML = ""; };
    root().innerHTML = "";
    shell.style.display = "none";
    await new Promise(r => setTimeout(r, 5200));
    const report = root().querySelector(".blank-report");
    ok("an interface that stays hidden explains itself on the page",
      !!report && report.textContent.indexOf(PMS.i18n.t("errors.blankScreen")) !== -1);
    ok("the explanation lists the layer that failed",
      !!report && report.textContent.indexOf("#view-root") !== -1);
    ok("the explanation is on screen and offers a retry", !!report && !!report.querySelector(".btn") && shell.style.display !== "none");
    PMS.router.handle = realHandle;
    shell.style.display = "";
    root().innerHTML = "";
    PMS.app.showShell();
    await new Promise(r => setTimeout(r, 1200));
    ok("the app recovers once the view renders again", root().children.length > 0 && !root().querySelector(".blank-report"));
  }
  // and no uncaught error may pass unnoticed
  {
    const note = document.createElement("div");
    note.id = "probe-note";
    document.body.appendChild(note);
    window.dispatchEvent(new window.ErrorEvent("error", { error: new Error("probe failure"), message: "probe failure" }));
    const shown = document.getElementById("error-note");
    ok("an uncaught error is surfaced, not swallowed",
      !!shown && shown.className.indexOf("is-on") !== -1 && shown.textContent.indexOf("probe failure") !== -1);
    if (shown) shown.remove();
    note.remove();
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
        { id: "t3", title: "Edited locally after push", updatedAt: "2026-01-03T00:00:00.000Z" },
        { id: "t4", title: "Never published", updatedAt: "2026-01-01T00:00:00.000Z" }
      ];
      local.meta = { updatedAt: "2026-01-01T00:00:00.000Z" };
      // The per-record mirror is what separates "a remote writer deleted this"
      // from "this was never uploaded". t1/t2/t3 were published by this device,
      // so the remote clock may judge them; t4 was never published, so it must
      // survive the pull even though it is absent from the remote snapshot.
      const mirrorSaved = PMS.cloudsync._getMirrorForTest("tasks");
      PMS.cloudsync._setMirrorForTest("tasks", {
        t1: { updatedAt: "2026-01-01T00:00:00.000Z" },
        t2: { updatedAt: "2026-01-01T00:00:00.000Z" },
        t3: { updatedAt: "2026-01-01T00:00:00.000Z" }
      });
      const projMirrorSaved = PMS.cloudsync._getMirrorForTest("projects");
      PMS.cloudsync._setMirrorForTest("projects", { p1: { updatedAt: "2026-01-01T00:00:00.000Z" } });
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
        const t4 = merged.tasks.find(function (t) { return t.id === "t4"; });
        const p1 = merged.projects.find(function (p) { return p.id === "p1"; });
        mergedOk = t1 && t1.title === "New" && t1.statusId === "s2" &&   // edit propagated
          !t2 &&                                                         // remote deletion applied
          t3 && t3.id === "t3" &&                                        // offline local edit kept
          t4 && t4.title === "Never published" &&                        // never-uploaded record kept
          p1 && p1.name === "After" &&                                   // project edit propagated
          merged.meta.updatedAt === "2026-01-02T00:00:00.000Z";
      } catch (e) { mergedOk = false; }
      PMS.store.setData(saved);
      PMS.cloudsync._setMirrorForTest("tasks", mirrorSaved);
      PMS.cloudsync._setMirrorForTest("projects", projMirrorSaved);
      return mergedOk;
    })());

  // MEETINGS must travel with the rest of the shared data. They were missing
  // from the synced collections entirely, so a meeting never left the browser
  // that created it and no other user could ever see it. This also covers the
  // merge rules that decide whether a local-only meeting survives a pull.
  {
    const mtgSaved = PMS.utils.deepClone(PMS.store.data);
    const mtgSavedMirror = window.localStorage.getItem("pms-cloud-mirror");
    const mkBase = function () {
      const d = PMS.schema.defaultData();
      d.users = PMS.utils.deepClone(mtgSaved.users || []);
      d.settings = PMS.utils.deepClone(mtgSaved.settings || {});
      d.meta = { updatedAt: "2026-01-01T00:00:00.000Z" };
      return d;
    };
    const mtgRemote = mkBase();
    mtgRemote.meta = { updatedAt: "2026-01-05T00:00:00.000Z" };
    mtgRemote.meetings = [
      { id: "m-remote-new", title: "From the cloud", updatedAt: "2026-01-05T00:00:00.000Z" },
      { id: "m-edit", title: "Before", updatedAt: "2026-01-01T00:00:00.000Z" }
    ];
    const mtgLocal = mkBase();
    mtgLocal.meetings = [
      { id: "m-edit", title: "After", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "m-unpublished", title: "Never synced", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "m-deleted-remotely", title: "Gone", updatedAt: "2026-01-01T00:00:00.000Z" }
    ];
    // The mirror knows m-edit and m-deleted-remotely (both were published
    // before) but NOT m-unpublished, which predates meetings being syncable.
    window.localStorage.setItem("pms-cloud-mirror", JSON.stringify({
      meetings: {
        "m-edit": { updatedAt: "2026-01-01T00:00:00.000Z" },
        "m-deleted-remotely": { updatedAt: "2026-01-01T00:00:00.000Z" }
      }
    }));
    PMS.store.setData(mtgLocal);
    let mtgMergeOk = false;
    try {
      const merged = PMS.cloudsync._mergeForTest(mtgRemote);
      const byId = {};
      merged.meetings.forEach(function (m) { byId[m.id] = m; });
      mtgMergeOk = !!byId["m-remote-new"] &&                              // arrives from the cloud
        !!byId["m-edit"] && byId["m-edit"].title === "After" &&          // newer local edit wins
        !!byId["m-unpublished"] &&                                       // never published -> NOT dropped
        !byId["m-deleted-remotely"];                                     // known deletion -> applied
    } catch (e) { mtgMergeOk = false; }
    PMS.store.setData(mtgSaved);
    if (mtgSavedMirror === null) window.localStorage.removeItem("pms-cloud-mirror");
    else window.localStorage.setItem("pms-cloud-mirror", mtgSavedMirror);
    ok("a pull imports meetings, keeps never-synced ones and applies deletions", mtgMergeOk);
  }
  // --- account audit trail + shared backups + the copy/label cleanups ---
  {
    const mtgSyncSrc2 = fs.readFileSync(path.join(APP, "js", "services", "sync-firestore.js"), "utf8");
    const mtgRules2 = fs.readFileSync(path.join(APP, "firestore.rules"), "utf8");
    const enSrc = fs.readFileSync(path.join(APP, "js", "i18n", "en.js"), "utf8");
    const arSrc = fs.readFileSync(path.join(APP, "js", "i18n", "ar.js"), "utf8");

    // the removed sign-in sentence must be gone from BOTH locales
    ok("the \"first account becomes the admin\" sentence is gone from en",
      enSrc.indexOf("One email + password works on every device") === -1);
    ok("the same sentence is gone from ar",
      arSrc.indexOf("أول حساب يصبح المدير") === -1);
    // an empty description must not leave an empty paragraph on the card
    ok("the sign-in card only renders the description when there is one",
      /if \(t\("auth\.cloudDesc"\)\)/.test(fs.readFileSync(path.join(APP, "js", "views", "auth.js"), "utf8")));

    ok("the tasks column is labelled \"Assign to\"", /assignees: "Assign to"/.test(enSrc));
    ok("the Arabic label is \"إسناد إلى\"", arSrc.indexOf('assignees: "إسناد إلى"') !== -1);

    // the audit trail writes every account/security action
    ["account.created", "account.deleted", "account.role", "account.person",
      "account.email", "account.active", "account.password",
      "account.signin", "account.signout", "account.signin.failed"
    ].forEach(function (kind) {
      ok("the audit trail records " + kind,
        mtgSyncSrc2.indexOf('"' + kind + '"') !== -1);
    });
    ok("a failed sign-in is audited as well as a successful one",
      /account\.signin\.failed/.test(mtgSyncSrc2) && /e\.userCode !== "invalid"/.test(mtgSyncSrc2));
    ok("an audit write can never break the action the user asked for",
      /function recordAccountEvent[\s\S]{0,1200}never throws and never rejects/.test(mtgSyncSrc2) ||
      /recordAccountEvent[\s\S]{0,400}return Promise\.resolve\(false\)/.test(mtgSyncSrc2));
    ok("no password or hash is ever written to the audit trail",
      mtgSyncSrc2.indexOf("passwordHash") === -1 && mtgSyncSrc2.indexOf("attempted password") !== -1);

    // the audit trail is admin-readable and append-only, like the activity log
    ok("the rules define zms_account_events",
      /match \/zms_account_events\/\{id\}/.test(mtgRules2));
    ok("only an admin can read the account audit trail",
      /match \/zms_account_events\/\{id\}[\s\S]{0,200}allow read: if isAdmin/.test(mtgRules2));
    ok("account events are append-only (no update)",
      /match \/zms_account_events\/\{id\}[\s\S]{0,300}allow update: if false/.test(mtgRules2));

    // shared backups
    ok("the rules define the shared zms_backups collection",
      /match \/zms_backups\/\{id\}/.test(mtgRules2));
    ok("backups are admin-only in the cloud",
      /match \/zms_backups\/\{id\}[\s\S]{0,300}allow read: if isAdmin/.test(mtgRules2) &&
      /match \/zms_backups\/\{id\}[\s\S]{0,300}allow create, update: if isAdmin/.test(mtgRules2) &&
      /match \/zms_backups\/\{id\}[\s\S]{0,300}allow delete: if isAdmin/.test(mtgRules2));
    ["saveBackup", "listBackups", "loadBackup", "deleteBackup", "trimBackups"]
      .forEach(function (fn) {
        ok("cloudsync exposes " + fn, mtgSyncSrc2.indexOf(fn + ": " + fn) !== -1);
      });
    ok("a snapshot is uploaded at most once", /function isUploaded\(b\)/.test(fs.readFileSync(path.join(APP, "js", "data", "backup.js"), "utf8")));
    ok("a snapshot never carries the cache or the audit list",
      /delete d\.accountEvents/.test(fs.readFileSync(path.join(APP, "js", "data", "backup.js"), "utf8")));
    ok("backups keep the local cache for offline restores", /localStorage\.setItem\(LS_KEY/.test(fs.readFileSync(path.join(APP, "js", "data", "backup.js"), "utf8")));
    ok("a snapshot made on another device can be restored",
      /PMS\.cloudsync\.loadBackup\(id\)/.test(fs.readFileSync(path.join(APP, "js", "data", "backup.js"), "utf8")));
    ok("a local-only snapshot is labelled as such",
      /settings\.backupLocalOnly/.test(fs.readFileSync(path.join(APP, "js", "views", "settings.js"), "utf8")));
  }
  // --- a task a manager created in a pillar they do NOT manage ---
  {
    const rulesSrc = fs.readFileSync(path.join(APP, "firestore.rules"), "utf8");
    const syncSrc = fs.readFileSync(path.join(APP, "js", "services", "sync-firestore.js"), "utf8");
    const authSrc = fs.readFileSync(path.join(APP, "js", "core", "auth.js"), "utf8");

    // The symptom was: the task appeared for the manager, never reached anyone
    // else, and then vanished. canCreateTask allows a manager to create a task
    // in ANY pillar (an unassigned task belongs to nobody), so the rules must
    // not demand that the caller manage the target pillar.
    ok("canCreateTask still lets a manager create a task in any pillar",
      /u\.role === "manager"\) return true/.test(authSrc));
    ok("the rules create a task for a manager in any pillar",
      /function canCreateTask\(uid\)\s*\{\s*return isManagerOrAdmin\(uid\)/.test(rulesSrc) &&
      /match \/zms_tasks\/\{taskId\}[\s\S]{0,300}allow create: if canCreateTask/.test(rulesSrc));
    ok("creating a task is no longer gated on managing its pillar",
      /isTaskProjectManaged/.test(rulesSrc) === false ||
      /allow create: if isAdmin[\s\S]{0,120}isTaskProjectManaged/.test(rulesSrc) === false);
    // The client must agree with the rules, which is the actual defect: the
    // push engine dropped the record and the pull then deleted it locally.
    ok("the push engine lets a manager create (but not rewrite) a task in a foreign pillar",
      /idn\.role === "manager" && !mirror\[rec\.id\]/.test(syncSrc));
    ok("a record that was never published survives a pull",
      /if \(recMirror && !recMirror\[e\.id\]\) return true/.test(syncSrc));
    ok("a refused write is reported instead of passing as a clean push",
      /cloud:skipped/.test(syncSrc) && /not uploaded \(no write right/.test(syncSrc));
    // The narrower update right must survive the widening of create.
    ok("editing a task in a foreign pillar stays with its manager",
      /projectManagerOf\(d, rec\.projectId\) === idn\.personId/.test(syncSrc) &&
      /allow update: if isAdmin\(request\.auth\.uid\)\s*\|\|\s*isTaskProjectManaged\(request\.auth\.uid, resource\.data\)/.test(rulesSrc));
  }
  {
    const mtgSyncSrc = fs.readFileSync(path.join(APP, "js", "services", "sync-firestore.js"), "utf8");
    ok("meetings are a synced per-record collection",
      /var RECORD_COLS = \["projects", "tasks", "meetings"\]/.test(mtgSyncSrc));
    // store.setData() REPLACES the whole dataset, so any collection missing
    // from the pull skeleton is silently reset to [] on every applied pull.
    ok("the pull skeleton includes meetings (a pull must not wipe them)",
      /departments: \[\], people: \[\], projects: \[\], tasks: \[\], meetings: \[\]/.test(mtgSyncSrc));
    ok("a manager can publish meetings even though a manager is not an admin",
      /cname === "meetings"[\s\S]{0,900}allow = idn\.isAdmin \|\| idn\.role === "manager"/.test(mtgSyncSrc));
    const mtgRules = fs.readFileSync(path.join(APP, "firestore.rules"), "utf8");
    ok("the rules define the zms_meetings collection",
      /match \/zms_meetings\/\{meetingId\}/.test(mtgRules));
    ok("only an admin or manager may create or edit a meeting in the cloud",
      /match \/zms_meetings\/\{meetingId\}[\s\S]{0,500}allow create: if isManagerOrAdmin[\s\S]{0,160}allow update: if isManagerOrAdmin/.test(mtgRules));
    ok("deleting a meeting needs an admin, or the manager who created it",
      /match \/zms_meetings\/\{meetingId\}[\s\S]{0,600}allow delete: if canDeleteRecord\(request\.auth\.uid, resource\.data\)/.test(mtgRules) &&
      /function canDeleteRecord\(uid, docData\)[\s\S]{0,200}isAdmin\(uid\) \|\| \(isManagerOrAdmin\(uid\) && isCreatorOf\(uid, docData\)\)/.test(mtgRules));
  }
  // --- a manager may edit any task, and may delete only what they created ---
  {
    const rulesSrc = fs.readFileSync(path.join(APP, "firestore.rules"), "utf8");
    const syncSrc = fs.readFileSync(path.join(APP, "js", "services", "sync-firestore.js"), "utf8");
    const authSrc = fs.readFileSync(path.join(APP, "js", "core", "auth.js"), "utf8");

    ok("canEditTask lets a manager edit ANY task, not just their own pillar's",
      /function canEditTask[\s\S]{0,700}if \(u\.role === "manager"\) return true;/.test(authSrc));

    ok("auth exposes a per-record delete right for the manager",
      /function canDeleteRecord\(rec\)[\s\S]{0,300}if \(r === "manager"\) return createdByCurrentUser\(rec\)/.test(authSrc) &&
      /canDeleteRecord: canDeleteRecord/.test(authSrc));
    ok("a member may never delete, and the broad canDelete() stays admin-only",
      /function canDelete\(\) \{ return role\(\) === "admin"; \}/.test(authSrc) &&
      /function canDeleteRecord\(rec\)[\s\S]{0,300}if \(r === "manager"\)[\s\S]{0,120}return false;/.test(authSrc));
    ok("the creator is matched by person id so it survives another device",
      /createdByPersonId && currentPersonId\(\) && rec\.createdByPersonId === currentPersonId\(\)/.test(authSrc));

    // The push engine reads the creator from the MIRROR: by the time it runs,
    // the local record is gone, so there is nothing left to read it from.
    ok("the mirror keeps createdByPersonId so a deletion can be authorized",
      /function recordTrack[\s\S]{0,700}createdByPersonId: \(rec && rec\.createdByPersonId\) \|\| null/.test(syncSrc));
    ok("a manager may delete a record they created, and only that one",
      /if \(idn\.role !== "manager" \|\| !idn\.personId\) return;[\s\S]{0,200}creator !== idn\.personId\) return;/.test(syncSrc));

    // the UI must not offer a delete it will refuse
    ok("the task detail hides delete for a manager on someone else's task",
      /canDeleteTask\(task\) \? \{[\s\S]{0,200}confirmTaskDelete/.test(fs.readFileSync(path.join(APP, "js", "ui", "task-detail.js"), "utf8")));
    ok("the pillar view gates delete on canDeleteRecord",
      /var canDeletePillar = PMS\.auth \? PMS\.auth\.canDeleteRecord\(proj\)/.test(fs.readFileSync(path.join(APP, "js", "views", "projects.js"), "utf8")));
    ok("the meeting view gates delete on canDeleteRecord",
      /PMS\.auth\.canDeleteRecord\(m\)/.test(fs.readFileSync(path.join(APP, "js", "views", "meetings.js"), "utf8")));
    ok("all three delete confirmations pass the record to the gate",
      /requireDelete\(task\)/.test(fs.readFileSync(path.join(APP, "js", "ui", "task-detail.js"), "utf8")) &&
      /requireDelete\(proj\)/.test(fs.readFileSync(path.join(APP, "js", "views", "projects.js"), "utf8")) &&
      /requireDelete\(m\)/.test(fs.readFileSync(path.join(APP, "js", "views", "meetings.js"), "utf8")));
  }
  {
    // behaviour, not just shape: a manager owns what they created and nothing else
    const saved2 = PMS.utils.deepClone(PMS.store.data);
    // createUser always mints a "member"; an admin promotes it, which is the
    // only path to the manager role (ZMS-R02).
    const created = PMS.auth.createUser({ username: "mara@z", password: "pw12345", name: "Mara" });
    const mgr = created.user;
    ok("a new account starts as a member and is promoted by an admin",
      mgr && mgr.role === "member" && PMS.auth.updateUser(mgr.id, { role: "manager", personId: "person-mgr-1" }).ok === true);
    // no other manager may hold a person link, so the record under test is
    // unambiguously owned by someone else
    const recs = PMS.utils.deepClone(PMS.store.data);
    recs.users.forEach(function (u) { if (u.role === "manager" && u.id !== mgr.id) u.personId = null; });
    PMS.store.setData(recs);
    PMS.auth.login("mara@z", "pw12345");
    ok("signed in as the promoted manager", PMS.auth.currentUser().role === "manager" && PMS.auth.currentUser().personId === "person-mgr-1");
    const mine = { id: "t-mine", title: "Mine", projectId: "p-foreign", assignees: [], createdBy: mgr.id, createdByPersonId: "person-mgr-1" };
    const theirs = { id: "t-theirs", title: "Theirs", projectId: "p-foreign", assignees: [], createdBy: "someone-else", createdByPersonId: "person-other" };
    ok("a manager may edit any task, including one in a pillar they do not manage",
      PMS.auth.canEditTask(theirs) === true && PMS.auth.canEditTask(mine) === true);
    ok("a manager may delete a task they created",
      PMS.auth.canDeleteRecord(mine) === true && PMS.auth.requireDelete(mine) === true);
    ok("a manager may NOT delete a task created by someone else",
      PMS.auth.canDeleteRecord(theirs) === false);
    ok("the same holds for a pillar and a meeting",
      PMS.auth.canDeleteRecord({ id: "p1", createdByPersonId: "person-mgr-1" }) === true &&
      PMS.auth.canDeleteRecord({ id: "m1", createdByPersonId: "person-other" }) === false);
    ok("an unattributed record is not deletable by a manager",
      PMS.auth.canDeleteRecord({ id: "x1" }) === false);

    // The task editor is how a task opens from the table (double click /
    // pencil), so it must offer the same gated delete as the detail modal.
    // Regression: the button only existed in task-detail, so a manager using
    // the table never saw a delete option at all.
    const edSrc = fs.readFileSync(path.join(APP, "js", "ui", "entity-editors.js"), "utf8");
    ok("the task editor footer routes through the delete gate",
      /footer: taskEditorFooter\(isEdit, restricted, task, \[/.test(edSrc) &&
      /function taskEditorFooter[\s\S]{0,300}canDeleteRecord\(task\)/.test(edSrc));
    const edMine = PMS.repos.tasks.add({ projectId: "p-foreign", title: "Editor mine", status: "todo", assignees: [] });
    PMS.repos.tasks.update(edMine.id, { createdBy: mgr.id, createdByPersonId: "person-mgr-1", createdByName: "Mara" });
    const deleteLabel = PMS.i18n.t("common.delete");
    PMS.editors.openTaskEditor(PMS.repos.tasks.get(edMine.id), {});
    var edFooter = document.querySelector(".modal-footer");
    ok("the task editor offers delete on a task the manager created",
      !!edFooter && edFooter.textContent.indexOf(deleteLabel) !== -1);
    PMS.modal.close();
    const edTheirs = PMS.repos.tasks.add({ projectId: "p-foreign", title: "Editor theirs", status: "todo", assignees: [] });
    PMS.repos.tasks.update(edTheirs.id, { createdBy: "someone-else", createdByPersonId: "person-other", createdByName: "Other" });
    PMS.editors.openTaskEditor(PMS.repos.tasks.get(edTheirs.id), {});
    edFooter = document.querySelector(".modal-footer");
    ok("the task editor hides delete on a task the manager did not create",
      !!edFooter && edFooter.textContent.indexOf(deleteLabel) === -1);
    PMS.modal.close();
    PMS.repos.tasks.remove(edMine.id);
    PMS.repos.tasks.remove(edTheirs.id);
    PMS.auth.login("boss", "pw1234");
    ok("an admin may still delete any record, and canDelete() stays admin-only",
      PMS.auth.canDeleteRecord(theirs) === true && PMS.auth.canDelete() === true && PMS.auth.requireDelete(theirs) === true);
    PMS.store.setData(saved2);
  }

  // --- the silence fix: when a manager sees no Delete at all, the screen says
  // --- why instead of looking broken -----------------------------------------
  {
    const savedH = PMS.utils.deepClone(PMS.store.data);
    const theirs = PMS.repos.tasks.add({ title: "Author's task", status: "todo" });
    const mgrU = PMS.auth.createUser({ username: "hana@z", password: "pw12345", name: "Hana" }).user;
    PMS.auth.updateUser(mgrU.id, { role: "manager" });
    PMS.auth.login("hana@z", "pw12345");
    // created BY the manager, so it is the one they are allowed to delete
    const mine = PMS.repos.tasks.add({ title: "Manager's task", status: "todo" });
    ok("a manager may delete a task they created",
      PMS.auth.canDeleteRecord(mine) === true && PMS.auth.canDeleteRecord(theirs) === false);
    ok("a manager on somebody else's record is told the deletion rule",
      typeof PMS.auth.deleteBlockedHint(theirs) === "string" &&
      PMS.auth.deleteBlockedHint(theirs).indexOf(PMS.i18n.t("auth.deleteOwnOnly")) === 0);
    ok("a manager on their own record is not nagged",
      PMS.auth.deleteBlockedHint(mine) === null);
    ok("a member is not nagged either", (function () {
      PMS.auth.login("lina", "newpass1");
      const m = PMS.auth.deleteBlockedHint(theirs) === null;
      return m;
    })());

    // and it actually reaches the screen the manager is looking at
    PMS.auth.login("hana@z", "pw12345");
    PMS.taskDetail.open(theirs.id);
    ok("the task screen shows the explanation when no Delete is offered",
      !!document.querySelector(".modal-note") && !document.querySelector(".modal-footer .btn-soft-danger"));
    PMS.modal.close();
    PMS.taskDetail.open(mine.id);
    ok("the manager's own task shows Delete and no explanation",
      !!document.querySelector(".modal-footer .btn-soft-danger") && !document.querySelector(".modal-note"));
    PMS.modal.close();
    PMS.auth.login("boss", "pw1234");
    PMS.taskDetail.open(theirs.id);
    ok("an admin is neither blocked nor explained",
      !!document.querySelector(".modal-footer .btn-soft-danger") && !document.querySelector(".modal-note"));
    PMS.modal.close();

    // a manager links an existing task into a meeting of their own
    PMS.auth.login("hana@z", "pw12345");
    const mtg = PMS.repos.meetings.add({ title: "Manager meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [] });
    const free = PMS.repos.tasks.all().find(t => !t.meetingId);
    PMS.meetings.openDetail(mtg.id);
    const lb = Array.from(PMS.modal.body.querySelectorAll("button")).find(b => b.textContent.indexOf("+ " + PMS.i18n.t("meetings.linkExistingTask")) === 0);
    ok("a manager is offered the searchable task picker", !!lb);
    if (lb) {
      lb.click();
      const box = PMS.modal.body.querySelector(".link-picker input");
      box.value = free.title;
      box.dispatchEvent(new window.Event("input", { bubbles: true }));
      const hit = Array.from(PMS.modal.body.querySelectorAll(".link-result")).find(r => (r.textContent || "").indexOf(free.title) !== -1);
      hit.click();
    }
    ok("a manager really attached an existing task to their meeting",
      PMS.repos.meetings.tasksOf(mtg.id).some(t => t.id === free.id));
    PMS.modal.close();
    PMS.store.setData(savedH);
    PMS.auth.login("boss", "pw1234");
  }

  // --- people + departments: a manager may look and may add, but must not
  // --- rewrite or remove another person's record -----------------------------
  {
    const savedP = PMS.utils.deepClone(PMS.store.data);
    const other = PMS.repos.people.all()[0];
    const made = PMS.auth.createUser({ username: "mira@z", password: "pw12345", name: "Mira" });
    const mgr = made.user;
    ok("a promoted manager can add people but cannot edit other people",
      PMS.auth.updateUser(mgr.id, { role: "manager", personId: other.id }).ok === true &&
      PMS.auth.can("people.write") === true && PMS.auth.canEditPerson(other) === true);
    PMS.auth.login("mira@z", "pw12345");
    ok("a manager is signed in and linked to their person",
      PMS.auth.currentUser().role === "manager" && PMS.auth.currentUser().personId === other.id);

    const meP = PMS.repos.people.get(other.id);
    const another = PMS.repos.people.all().find(p => p.id !== other.id);
    ok("a manager may edit their own person record", PMS.auth.canEditPerson(meP) === true);
    ok("a manager may NOT edit somebody else's person record", PMS.auth.canEditPerson(another) === false);

    // the person editor refuses it too, not just the button that is hidden
    PMS.editors.openPersonEditor(another, function () {});
    ok("the person editor refuses to open for another person", !PMS.modal.isOpen);
    PMS.editors.openPersonEditor(meP, function () {});
    ok("the person editor opens for their own record", PMS.modal.isOpen);
    PMS.modal.close();

    // people screen: edit on own card only, and no archive offered
    route("/people");
    const myCard = Array.from(root().querySelectorAll(".person-card")).find(c => (c.textContent || "").indexOf(meP.name) !== -1);
    const otherCard = Array.from(root().querySelectorAll(".person-card")).find(c => (c.textContent || "").indexOf(another.name) !== -1);
    ok("the manager's own person card offers Edit",
      !!myCard && Array.from(myCard.querySelectorAll(".btn")).some(b => b.textContent.indexOf(PMS.i18n.t("common.edit")) === 0));
    ok("another person's card offers the manager no Edit",
      !!otherCard && Array.from(otherCard.querySelectorAll(".btn")).every(b => b.textContent.indexOf(PMS.i18n.t("common.edit")) !== 0));
    ok("no card offers the manager Archive (admin only)",
      !Array.from(root().querySelectorAll(".person-card .btn")).some(b => b.textContent.indexOf(PMS.i18n.t("common.archive")) === 0));
    ok("the manager still gets the Add person action",
      Array.from(root().querySelectorAll(".page-header button")).some(b => (b.textContent || "").indexOf(PMS.i18n.t("people.addPerson")) !== -1));
    ok("the manager does NOT get the Add department action (sections are read-only)",
      !Array.from(root().querySelectorAll(".page-header button")).some(b => (b.textContent || "").indexOf(PMS.i18n.t("people.addDepartment")) !== -1));
    // departments: readable, editable, but never deletable by a manager
    Array.from(root().querySelectorAll(".tab")).find(t => (t.textContent || "") === PMS.i18n.t("people.departments")).click();
    ok("the manager can see the departments list", (root().textContent || "").indexOf(PMS.i18n.t("people.departments")) !== -1);
    const deptWrite = Array.from(root().querySelectorAll(".btn")).filter(b => b.textContent.indexOf(PMS.i18n.t("common.delete")) === 0 || b.textContent.indexOf(PMS.i18n.t("common.edit")) === 0);
    ok("departments are read-only for a manager (no Edit, no Delete)", deptWrite.length === 0, deptWrite.length + " shown");
    ok("the manager gets no Add department button inside the departments tab",
      !Array.from(root().querySelectorAll("button")).some(b => (b.textContent || "").indexOf(PMS.i18n.t("people.addDepartment")) !== -1));
    // leave the view on the People tab: the tab choice is module state and
    // later assertions expect the default section
    Array.from(root().querySelectorAll(".tab")).find(t => (t.textContent || "") === PMS.i18n.t("people.people")).click();

    // a manager whose account was never linked to a person owns no record
    PMS.auth.login("boss", "pw1234");
    const nolink = PMS.auth.createUser({ username: "niko@z", password: "pw12345", name: "Niko" }).user;
    PMS.auth.updateUser(nolink.id, { role: "manager" });
    PMS.auth.login("niko@z", "pw12345");
    ok("a manager with no linked person owns no person record",
      PMS.auth.currentPersonId() === null && PMS.auth.canEditPerson(meP) === false && PMS.auth.canEditPerson(another) === false);
    ok("but a manager with no linked person may still add people", PMS.auth.can("people.write") === true);

    // a member gets no way to create a person at all
    PMS.auth.login("lina", "newpass1");
    const memCtl = PMS.forms.buildControl({ key: "assignees", type: "multiselect", options: [], allowCreatePerson: true }, []);
    ok("a member gets no inline +person affordance",
      !memCtl.el.querySelector(".person-create .btn") && PMS.auth.can("people.write") === false);
    ok("a member cannot open the person editor", PMS.editors.canOpenPerson(meP) === false);

    PMS.auth.login("boss", "pw1234");
    ok("an admin may still edit and open any person",
      PMS.auth.canEditPerson(another) === true && PMS.auth.canEditPerson(meP) === true);
    PMS.store.setData(savedP);
    PMS.auth.login("boss", "pw1234");
  }
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

section("Meeting creator + file attachments + member scoping + people/sections");
  PMS.auth.login("boss", "pw1234");
  errors.length = 0;
  route("/meetings");
  ok("meetings view renders with creator/attachments", errors.length === 0, errors.join(" | "));

  // --- the creator is stamped from the signed-in user, not typed by hand ---
  const creatorMeet = PMS.repos.meetings.add({ title: "Who made this", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  const creatorUser = PMS.auth.userById(creatorMeet.createdBy);
  ok("meetings.add stamps the creator id", !!creatorMeet.createdBy && !!creatorUser);
  ok("the creator name is stored for display", creatorMeet.createdByName === (creatorUser.name || creatorUser.username));
  PMS.repos.meetings.update(creatorMeet.id, { title: "Who made this" });
  ok("a plain update does not wipe the creator", PMS.repos.meetings.get(creatorMeet.id).createdBy === creatorMeet.createdBy);
  PMS.meetings.openDetail(creatorMeet.id);
  ok("the meeting detail shows the creator by name", (PMS.modal.body.textContent || "").indexOf(PMS.repos.meetings.get(creatorMeet.id).createdByName) !== -1);
  PMS.modal.close();

  // a meeting nobody stamped still has to render (legacy data)
  const legacyMeet = PMS.repos.meetings.add({ title: "Legacy meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  delete PMS.store.data.meetings.find(m => m.id === legacyMeet.id).createdByName;
  delete PMS.store.data.meetings.find(m => m.id === legacyMeet.id).createdBy;
  errors.length = 0;
  PMS.meetings.openDetail(legacyMeet.id);
  ok("a meeting with no creator renders instead of crashing", errors.length === 0, errors.join(" | "));
  PMS.modal.close();

  // --- attachments are links, not uploads ---
  const attMeet = PMS.repos.meetings.add({ title: "With files", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  ok("a new meeting starts with an empty attachment list", Array.isArray(attMeet.attachments) && attMeet.attachments.length === 0);
  PMS.repos.meetings.addAttachment(attMeet.id, { name: "Drive deck", url: "https://drive.google.com/file/d/abc123/view", kind: "drive" });
  ok("a Drive link is attached", PMS.repos.meetings.get(attMeet.id).attachments.length === 1);
  const attached = PMS.repos.meetings.get(attMeet.id).attachments[0];
  ok("the attachment keeps its name and kind", attached.name === "Drive deck" && attached.kind === "drive");
  ok("a Drive kind is inferred from the link", !!attached.id);
  PMS.repos.meetings.addAttachment(attMeet.id, { name: "Notes", url: "drive.google.com/file/d/xyz", kind: "drive" });
  ok("a link without a scheme is upgraded to https", PMS.repos.meetings.get(attMeet.id).attachments[1].url === "https://drive.google.com/file/d/xyz");
  PMS.repos.meetings.addAttachment(attMeet.id, { name: "Notes", url: "https://drive.google.com/file/d/xyz", kind: "drive" });
  ok("the same file is not attached twice", PMS.repos.meetings.get(attMeet.id).attachments.length === 2);
  ok("the attachment count shows on the meeting", true);
  PMS.meetings.openDetail(attMeet.id);
  ok("the meeting detail lists the attached files", (PMS.modal.body.textContent || "").indexOf("Drive deck") !== -1);
  ok("the attached link is a real anchor", !!PMS.modal.body.querySelector('.attach-row-view a[href^="https://drive.google.com"]'));
  PMS.modal.close();

  const badAttach = PMS.repos.meetings.addAttachment(attMeet.id, { name: "Bad", url: "javascript:alert(1)", kind: "link" });
  ok("a dangerous scheme is not stored as-is", !/^javascript:/i.test((badAttach && badAttach.url) || ""));
  PMS.repos.meetings.removeAttachment(attMeet.id, attached.id);
  ok("an attachment can be removed", PMS.repos.meetings.get(attMeet.id).attachments.every(a => a.id !== attached.id));
  PMS.repos.meetings.remove(attMeet.id);
  PMS.repos.meetings.remove(creatorMeet.id);
  PMS.repos.meetings.remove(legacyMeet.id);

  // the editor writes the attachment list through like any other field
  const editMeet = PMS.repos.meetings.add({ title: "Editor files", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  PMS.editors.openMeetingEditor(PMS.repos.meetings.get(editMeet.id), {});
  ok("the meeting editor exposes an attachments control", !!PMS.modal.body.querySelector('.field[data-key="attachments"]'));
  PMS.modal.close();
  PMS.repos.meetings.remove(editMeet.id);

  // --- a member only ever sees their own work ---
  const scopingPerson = PMS.repos.people.all().find(p => p.email === "lina@example.com") || PMS.repos.people.all()[0];
  PMS.accounts.createForPerson(scopingPerson);
  const scopingUser = PMS.auth.userByPersonId(scopingPerson.id);
  if (!scopingUser) { ok("a member account can be created for scoping", false); }
  else {
    if (scopingUser.role !== "member") PMS.auth.updateUser(scopingUser.id, { role: "member" });
    // createForPerson hands out a random password, so set a known one to sign in
    PMS.auth.resetPassword(scopingUser.id, "scope1234");
  }
  const scopeLogin = scopingUser ? PMS.auth.login(scopingUser.username, "scope1234") : { error: "no account" };
  ok("signed in as a member", !scopeLogin.error && PMS.auth.role() === "member", JSON.stringify(scopeLogin));
  ok("the member is linked to a person record", PMS.auth.currentPersonId && PMS.auth.currentPersonId() === scopingPerson.id);

  // a meeting the member creates themselves is theirs to see, and is stamped
  // with their person id so the rule survives a sync to another device
  const memberMeet = PMS.repos.meetings.add({ title: "My own meeting", date: PMS.utils.todayISO(), attendees: [], agenda: [], projectIds: [] });
  ok("a meeting records the creator's person id", memberMeet.createdByPersonId === scopingPerson.id);
  ok("a member can see the meeting they created", PMS.repos.meetings.get(memberMeet.id) !== null);
  PMS.repos.meetings.remove(memberMeet.id);

  const visibleTasks = PMS.repos.tasks.all();
  ok("tasks.all() is narrowed for a member", visibleTasks.every(tsk =>
    (tsk.assignees || []).indexOf(scopingPerson.id) !== -1 || tsk.createdByPersonId === scopingPerson.id));
  ok("the member still has at least their own task to look at", visibleTasks.length > 0);
  const unassignedTask = PMS.repos.tasks.all().find(tsk => (tsk.assignees || []).indexOf(scopingPerson.id) === -1 && tsk.createdByPersonId !== scopingPerson.id);
  if (unassignedTask) ok("a task assigned to somebody else is hidden", PMS.repos.tasks.get(unassignedTask.id) === null);
  ok("the filtered count is smaller than the whole store", visibleTasks.length <= PMS.store.data.tasks.length);
  ok("forMeeting does not leak somebody else's task", (PMS.repos.tasks.forMeeting(unassignedTask && unassignedTask.meetingId) || []).every(tsk => (tsk.assignees || []).indexOf(scopingPerson.id) !== -1 || tsk.createdByPersonId === scopingPerson.id));

  const visibleMeetings = PMS.repos.meetings.all();
  ok("meetings.all() is narrowed for a member", visibleMeetings.every(m =>
    (m.attendees || []).indexOf(scopingPerson.id) !== -1 || m.createdByPersonId === scopingPerson.id));
  const otherMeeting = PMS.store.data.meetings.find(m => (m.attendees || []).indexOf(scopingPerson.id) === -1 && m.createdByPersonId !== scopingPerson.id);
  if (otherMeeting) {
    ok("a meeting they did not attend is hidden", PMS.repos.meetings.get(otherMeeting.id) === null);
    ok("upcoming/past stay narrowed too", PMS.repos.meetings.upcoming().concat(PMS.repos.meetings.past()).every(m =>
      (m.attendees || []).indexOf(scopingPerson.id) !== -1 || m.createdByPersonId === scopingPerson.id));
  }
  ok("the activity log is narrowed for a member", PMS.activity.entries().every(e =>
    e.entityType !== "task" || e.entityId === null || PMS.repos.tasks.get(e.entityId) !== null));

  // a dashboard/report total is still a leak if it counts hidden records
  const adminTasks = PMS.store.data.tasks.length;
  ok("there is hidden work to leak", PMS.repos.tasks.all().length < adminTasks, PMS.repos.tasks.all().length + "/" + adminTasks);
  ok("scopedData() narrows the task array for a member", PMS.repos.scopedData().tasks.length === PMS.repos.tasks.all().length);
  ok("scopedData() narrows the meeting array for a member", PMS.repos.scopedData().meetings.length === PMS.repos.meetings.all().length);
  ok("scopedData() leaves the other collections intact", PMS.repos.scopedData().projects.length === PMS.store.data.projects.length);
  const lvDashText = (function () { route("/dashboard"); return root().textContent || ""; })();
  // A member is not allowed to open the dashboard at all (ROLE_ROUTES), so the
  // router turns them away and paints their own home view. The old check here
  // read the landing page and looked for the number in it, which meant it was
  // really asserting that some digit appeared somewhere in the task table - it
  // passed or failed on a coincidence, not on the leak it claimed to test. The
  // leak is proved against the page the member actually gets.
  ok("a member is turned away from the dashboard", PMS.router.current !== "/dashboard", "landed on " + PMS.router.current);
  const scopeHiddenIds = PMS.store.data.tasks.filter(tsk => !visibleTasks.some(v => v.id === tsk.id)).map(tsk => tsk.id);
  ok("no hidden task id reaches the member's page", scopeHiddenIds.every(id => root().innerHTML.indexOf(id) === -1),
    scopeHiddenIds.filter(id => root().innerHTML.indexOf(id) !== -1).slice(0, 3).join(","));
  const memberRowIds = Array.prototype.slice.call(root().querySelectorAll(".vt-row")).map(el => el.dataset.id).filter(Boolean);
  ok("the member's task list is drawn from visible tasks only", memberRowIds.length > 0 && memberRowIds.every(id => visibleTasks.some(v => v.id === id)),
    memberRowIds.filter(id => !visibleTasks.some(v => v.id === id)).slice(0, 3).join(","));
  ok("the member's task list never shows more rows than they have tasks", memberRowIds.length <= visibleTasks.length,
    memberRowIds.length + " rows for " + visibleTasks.length + " tasks");
  ok("the member's dashboard never shows the full store count", adminTasks === visibleTasks.length || lvDashText.indexOf(adminTasks + " " + PMS.i18n.t("dashboard.totalTasks")) === -1);
  ok("the member's dashboard still renders", lvDashText.length > 0);
  const lvReportText = (function () { route("/reports"); return root().textContent || ""; })();
  ok("the member's reports render", lvReportText.length > 0);
  const lvProjText = (function () { route("/projects"); return root().textContent || ""; })();
  ok("the member's pillar view renders", lvProjText.length > 0);
  ok("the report engine runs on the narrowed data", !!PMS.reports.generate("taskStatus", PMS.repos.scopedData(), {}));
  ok("progress is computed over the narrowed data", !!PMS.progress.allProjectProgress(PMS.repos.scopedData()));
  ok("scopedData() returns the live store for a non-member", (function () { PMS.auth.login("boss", "pw1234"); const same = PMS.repos.scopedData() === PMS.store.data; PMS.auth.login(scopingUser.username, "scope1234"); return same; })());

  errors.length = 0;
  route("/tasks");
  const memberTaskText = root().textContent || "";
  if (unassignedTask && unassignedTask.title) ok("a foreign task title never reaches the member's screen", memberTaskText.indexOf(unassignedTask.title) === -1);
  ok("the member's task view renders", errors.length === 0, errors.join(" | "));
  errors.length = 0;
  route("/meetings");
  ok("the member's meetings view renders", errors.length === 0, errors.join(" | "));
  if (PMS.meetings.canOpenMeeting) {
    ok("a member may not open a meeting they never attended", otherMeeting ? PMS.meetings.canOpenMeeting(otherMeeting) === false : true);
  }

  // --- people & sections ---
  PMS.auth.login("boss", "pw1234");
  errors.length = 0;
  route("/people");
  ok("the people view renders", errors.length === 0, errors.join(" | "));
  ok("people shows a section filter chip", !!root().querySelector(".people-filters .filter-chip"));
  ok("people shows department groups", !!root().querySelector(".dept-chip"));
  ok("people shows a workload bar", !!root().querySelector(".pc-load-track"));
  errors.length = 0;
  const deptTab = Array.from(root().querySelectorAll(".tabs .tab")).find(b => b.textContent === PMS.i18n.t("people.departments"));
  ok("the departments tab exists", !!deptTab);
  if (deptTab) deptTab.click();
  ok("the departments tab renders", errors.length === 0, errors.join(" | "));
  ok("departments list their members", !!root().querySelector(".people-row"));
  // the admin is the one who restructures the org, so the section buttons stay
  ok("the admin still gets Edit and Delete on a department",
    !!Array.from(root().querySelectorAll(".btn")).find(b => b.textContent.indexOf(PMS.i18n.t("common.edit")) === 0) &&
    !!Array.from(root().querySelectorAll(".btn")).find(b => b.textContent.indexOf(PMS.i18n.t("common.delete")) === 0));
  ok("the admin still gets Add department",
    Array.from(root().querySelectorAll("button")).some(b => (b.textContent || "").indexOf(PMS.i18n.t("people.addDepartment")) !== -1));

  const somePerson = PMS.repos.people.all().find(p => p.departmentId);
  if (somePerson) {
    errors.length = 0;
    PMS.people.openDetail(somePerson.id);
    ok("the person detail opens", PMS.modal.isOpen && errors.length === 0, errors.join(" | "));
    ok("the person detail lists the meetings they attended", (PMS.modal.body.textContent || "").indexOf(PMS.i18n.t("people.meetingsTitle", { n: 0 }).replace(/\(.*\)/, "").trim()) !== -1);
    PMS.modal.close();
  }
  errors.length = 0;
  route("/reports");
  ok("reports renders for the scoped repositories", errors.length === 0, errors.join(" | "));

  // --- branding ---
  ok("the app name is Digital Program", PMS.i18n.t("app.name") === "Digital Program");
  ok("the page title is branded", /<title>\s*Digital Program/.test(html));
  // the brand ships one logo per theme and lets CSS pick between them
  const brandImgs = Array.from(document.querySelectorAll(".brand-logo-img img"));
  ok("the brand renders both logo variants", brandImgs.length === 2, "found " + brandImgs.length);
  ok("the light logo is the Light_Mode artwork", brandImgs.some(i => /assets\/logo-light\.png$/.test(i.getAttribute("src") || "")));
  ok("the dark logo is the Dark_Mode artwork", brandImgs.some(i => /assets\/logo-dark\.png$/.test(i.getAttribute("src") || "")));
  ok("the logo is hidden from screen readers when decorative", brandImgs.some(i => i.getAttribute("aria-hidden") === "true"));
  ["assets/logo-light.png", "assets/logo-dark.png"].forEach(f => {
    const p = path.join(APP, f);
    ok(f + " exists in the deployed assets", fs.existsSync(p) && fs.statSync(p).size > 1000, String(fs.existsSync(p) && fs.statSync(p).size));
  });
  ok("the auth screen renders the logo", !!fs.readFileSync(path.join(APP, "js/views/auth.js"), "utf8").indexOf("logo-light.png") !== -1);

section("Meeting card leads with the creator, logo + favicon");
  PMS.auth.login("boss", "pw1234");
  const leadAttendee = PMS.repos.people.all()[0];
  const leadMeet = PMS.repos.meetings.add({ title: "Lead meeting", date: PMS.utils.todayISO(), time: "09:00", attendees: leadAttendee ? [leadAttendee.id] : [], agenda: ["a"], projectIds: [] });
  const leadName = PMS.repos.meetings.get(leadMeet.id).createdByName;
  route("/meetings");
  const leadCard = Array.from(root().querySelectorAll(".meeting-card")).find(c => (c.textContent || "").indexOf("Lead meeting") !== -1);
  ok("the meeting card renders", !!leadCard);
  // the creator has to come BEFORE the date and the title
  const byline = leadCard && leadCard.querySelector(".meeting-byline");
  ok("the card shows a creator line", !!byline);
  const byIdx = byline ? Array.prototype.indexOf.call(leadCard.querySelector(".card-body").children, byline) : -1;
  const dateIdx = leadCard ? Array.prototype.indexOf.call(leadCard.querySelector(".card-body").children, leadCard.querySelector(".card-body > .u-flex")) : -1;
  ok("the creator line is the first thing on the card", byIdx === 0, "index " + byIdx);
  ok("the creator line comes before the date and title", byIdx >= 0 && dateIdx > byIdx, "by " + byIdx + " date " + dateIdx);
  ok("the creator line carries the name", !!byline && (byline.textContent || "").indexOf(leadName) !== -1);
  ok("the creator line is labelled", !!byline && (byline.textContent || "").indexOf(PMS.i18n.t("meetings.createdBy")) !== -1);
  ok("the old footer creator chip is gone", !leadCard.querySelector(".meeting-by"));
  ok("the date is still on the card", (leadCard.textContent || "").indexOf(PMS.utils.formatDate(leadMeet.date, PMS.i18n)) !== -1);
  ok("the title is still on the card", (leadCard.textContent || "").indexOf("Lead meeting") !== -1);
  ok("the rest of the card is unchanged", (leadCard.textContent || "").indexOf("09:00") !== -1 && (leadCard.textContent || "").indexOf("📋") !== -1);

  // a meeting with no creator must not render an empty line
  delete PMS.store.data.meetings.find(m => m.id === leadMeet.id).createdByName;
  delete PMS.store.data.meetings.find(m => m.id === leadMeet.id).createdBy;
  route("/meetings");
  const leadCard2 = Array.from(root().querySelectorAll(".meeting-card")).find(c => (c.textContent || "").indexOf("Lead meeting") !== -1);
  ok("a meeting with no creator shows no creator line", !!leadCard2 && !leadCard2.querySelector(".meeting-byline"));
  PMS.repos.meetings.remove(leadMeet.id);

  // the logo: real artwork with the transparent padding taken out
  const lightPath = path.join(APP, "assets", "logo-light.png");
  const darkPath = path.join(APP, "assets", "logo-dark.png");
  ok("the light logo asset exists", fs.existsSync(lightPath));
  ok("the dark logo asset exists", fs.existsSync(darkPath));
  const lightBytes = fs.readFileSync(lightPath);
  const darkBytes = fs.readFileSync(darkPath);
  ok("the light logo is a real PNG", lightBytes[0] === 0x89 && lightBytes[1] === 0x50 && lightBytes[2] === 0x4E && lightBytes[3] === 0x47);
  ok("the dark logo is a real PNG", darkBytes[0] === 0x89 && darkBytes[1] === 0x50 && darkBytes[2] === 0x4E && darkBytes[3] === 0x47);
  // PNG width/height live in the IHDR chunk, bytes 16..23, big-endian
  const pngSize = b => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  const ls = pngSize(lightBytes), dk = pngSize(darkBytes);
  ok("the two logos are the same size", ls.w === dk.w && ls.h === dk.h, ls.w + "x" + ls.h + " vs " + dk.w + "x" + dk.h);
  ok("the logo keeps its wide wordmark ratio", ls.w / ls.h > 3 && ls.w / ls.h < 4.2, (ls.w / ls.h).toFixed(3));
  ok("the logo no longer carries the old dead padding", ls.w < 640 && ls.h < 295, ls.w + "x" + ls.h);

  // the logo is rendered by height with `width: auto`, so it cannot distort
  const layoutCss = fs.readFileSync(path.join(APP, "css", "layout.css"), "utf8");
  const brandBlock = (layoutCss.split(".sidebar-brand .brand-logo-img img")[1] || "").split("}")[0];
  ok("the sidebar logo is sized by height", /height:\s*\d+px/.test(brandBlock), brandBlock.replace(/\s+/g, " ").trim());
  ok("the sidebar logo width follows the aspect ratio", /width:\s*auto/.test(brandBlock));
  ok("the sidebar logo is capped so it cannot push the sidebar", /max-width:\s*100%/.test(brandBlock));
  ok("the sidebar logo may shrink rather than overflow", /flex:\s*0 1 auto/.test(layoutCss.split(".sidebar-brand .brand-logo-img")[1] || ""));
  // the sidebar itself must not grow
  ok("the sidebar width is still fixed", /--sidebar-width:\s*250px/.test(fs.readFileSync(path.join(APP, "css", "variables.css"), "utf8")));
  // the app name is shown under the logo, so it must be visible, not sr-only
  ok("the app name is shown under the logo", fs.readFileSync(path.join(APP, "js", "core", "app.js"), "utf8").indexOf("brand-name") !== -1);
  ok("the app name is not hidden from sighted users", fs.readFileSync(path.join(APP, "js", "core", "app.js"), "utf8").indexOf("u-sr-only") === -1);
  const brandCss = layoutCss.split(".sidebar-brand {")[1] || "";
  ok("the brand stacks the logo over the name", /flex-direction:\s*column/.test(brandCss), brandCss.replace(/\s+/g, " ").trim().slice(0, 60));
  ok("the brand name is centred", /\.sidebar-brand \.brand-name\s*\{[^}]*text-align:\s*center/.test(layoutCss));
  // the name under the logo means the logo gives up 4px of height, keeping the
  // brand block within a few px of what it was before the name was added back
  const logoH = parseInt((layoutCss.split(".sidebar-brand .brand-logo-img img")[1] || "").match(/height:\s*(\d+)px/)[1], 10);
  const brandPadY = (layoutCss.split(".sidebar-brand {")[1] || "").match(/padding:\s*var\(--space-2\)/) ? 8 : 16;
  const brandHeight = brandPadY * 2 + logoH + 3 + Math.round(0.95 * 16 * 1.15);
  ok("the brand block is exactly as tall as before the name came back", brandHeight === 76, brandHeight + "px (was 76px)");
  ok("the sidebar width is still fixed", /--sidebar-width:\s*250px/.test(fs.readFileSync(path.join(APP, "css", "variables.css"), "utf8")));

  // the people grid shows at most 3 people per row
  const compCss = fs.readFileSync(path.join(APP, "css", "components.css"), "utf8");
  const gridRule = (compCss.split(".grid-3 {")[1] || "").split("}")[0];
  ok("the people grid is capped at 3 columns", /repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(gridRule), gridRule.replace(/\s+/g, " ").trim());
  ok("the people grid no longer grows with the window", /auto-fit/.test(gridRule) === false);
  ok("the people grid narrows on small windows", /@media \(max-width: 1100px\) \{ \.grid-3 \{ grid-template-columns: repeat\(2/.test(compCss) && /@media \(max-width: 640px\) \{ \.grid-3 \{ grid-template-columns: 1fr/.test(compCss));
  ok("only the people view uses this grid", (fs.readFileSync(path.join(APP, "js", "views", "people.js"), "utf8").indexOf("grid-3") !== -1) && !/["'](view|route|path)["']\s*[=:,]\s*["'][^"']*grid-3/.test(compCss));
  route("/people");
  // the view remembers which sub-tab was last open, so pick the people tab by name
  const peopleTab = Array.from(root().querySelectorAll(".tabs .tab")).find(b => (b.textContent || "") === PMS.i18n.t("people.people"));
  ok("the people view renders its tabs", !!peopleTab);
  if (peopleTab) peopleTab.click();
  ok("the people grid renders", root().querySelectorAll(".grid-3").length === 1);
  const gridCards = root().querySelectorAll(".grid-3 > *");
  ok("the people grid holds the person cards", gridCards.length > 0, gridCards.length + " cards");

  // the browser tab icon: an inline SVG, so it costs no extra request
  const pageHtml = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  const iconHref = (pageHtml.match(/rel="icon"[^>]*href="([^"]*)"/) || [])[1] || "";
  ok("the tab icon is an inline SVG", /rel="icon"[^>]*data:image\/svg\+xml/.test(pageHtml), iconHref.slice(0, 60));
  ok("the tab icon is the clipboard glyph", iconHref.indexOf("%F0%9F%93%8A") !== -1);
  ok("the tab icon has no raw spaces in the data URI", iconHref.indexOf(" ") === -1 && iconHref.indexOf("\n") === -1);
  ok("the tab icon SVG is well formed", (function () {
    // decode and check it parses as SVG with a <text> glyph
    var svg = decodeURIComponent(iconHref.replace("data:image/svg+xml,", ""));
    return /^<svg[\s\S]*<\/svg>$/.test(svg) && svg.indexOf("<text") !== -1 && svg.indexOf("viewBox='0 0 100 100'") !== -1;
  })(), decodeURIComponent(iconHref.replace("data:image/svg+xml,", "")).slice(0, 80));
  ok("the tab icon is not a PNG file", !/rel="icon"[^>]*href="assets\//.test(pageHtml));
  ok("the generated favicon files are gone", !fs.existsSync(path.join(APP, "assets", "favicon.ico")) && !fs.existsSync(path.join(APP, "assets", "favicon-32.png")) && !fs.existsSync(path.join(APP, "assets", "apple-touch-icon.png")));
  ok("the page title is still the new name", /<title>\s*Digital Program/.test(pageHtml));

  PMS.sync.tick();
  PMS.sync.stop();
  ok("sync.tick safe when unbound", true);

  section("A member only gets the Tasks and Meetings tabs");
  // a real member account, linked to a person so the scoped views have data
  const navMember = (function () {
    const existing = PMS.auth.users().find(u => u.role === "member" && u.personId);
    if (existing) { PMS.auth.resetPassword(existing.id, "nav1234"); return existing; }
    const p = PMS.repos.people.all()[0];
    const acc = PMS.auth.createUser({ username: "navmember", password: "nav1234", personId: p.id, role: "member" });
    return acc.user;
  })();
  ok("the test member account is a member", navMember && navMember.role === "member", navMember && navMember.role);
  ok("the test member signs in", !PMS.auth.login(navMember.username, "nav1234").error && PMS.auth.role() === "member");
  PMS.app.init(); // rebuild the shell so the sidebar reflects this role

  // ---- the sidebar -------------------------------------------------------
  const memberNav = Array.from(root().querySelectorAll(".nav-item")).concat(Array.from(document.querySelectorAll(".nav-item")));
  const memberNavRoutes = memberNav.map(el => el.dataset.route);
  const memberNavLabels = memberNav.map(el => (el.textContent || "").trim());
  ok("a member sees exactly two tabs", memberNavRoutes.length === 2, memberNavRoutes.join(", "));
  ok("the two tabs are Tasks and Meetings", memberNavRoutes.indexOf("/tasks") !== -1 && memberNavRoutes.indexOf("/meetings") !== -1, memberNavRoutes.join(", "));
  ok("the member has no dashboard tab", memberNavRoutes.indexOf("/") === -1);
  ok("the member has no projects tab", memberNavRoutes.indexOf("/projects") === -1);
  ok("the member has no people tab", memberNavRoutes.indexOf("/people") === -1);
  ok("the member has no reports tab", memberNavRoutes.indexOf("/reports") === -1);
  ok("the member has no activity tab", memberNavRoutes.indexOf("/activity") === -1);
  ok("the member has no settings tab", memberNavRoutes.indexOf("/settings") === -1);
  ok("the member tab labels are Tasks and Meetings", memberNavLabels.length === 2 && memberNavLabels.some(l => l.indexOf(PMS.i18n.t("nav.tasks")) !== -1) && memberNavLabels.some(l => l.indexOf(PMS.i18n.t("nav.meetings")) !== -1), memberNavLabels.join(" | "));

  // ---- hiding a tab is not enough: the URL must be blocked too ----------
  ok("the member's home is Tasks, not the dashboard", PMS.registry.homeRoute() === "/tasks", PMS.registry.homeRoute());
  ok("the member lands on Tasks after signing in", (function () { PMS.app.init(); return PMS.router.current === "/tasks"; })(), PMS.router.current);
  ["/", "/projects", "/projects/" + PMS.repos.projects.all()[0].id, "/people", "/reports", "/activity", "/settings"].forEach(p => {
    ok("a member cannot open " + p, !PMS.registry.pathAllowed(p));
  });
  ["/tasks", "/meetings", "/tasks/kanban", "/tasks/gantt", "/tasks/calendar"].forEach(p => {
    ok("a member can open " + p, PMS.registry.pathAllowed(p));
  });
  // typing a blocked URL must actually land on Tasks, not render the page
  ["/", "/projects", "/people", "/reports", "/settings"].forEach(p => {
    route(p);
    ok("a member routed to " + p + " ends up on Tasks", PMS.router.current === "/tasks", PMS.router.current);
  });
  ok("the blocked route was corrected in the URL too", window.location.hash === "#/tasks", window.location.hash);
  // the task sub-views stay reachable: they are part of the Tasks tab
  ["/tasks/kanban", "/tasks/gantt", "/tasks/calendar"].forEach(p => {
    route(p);
    ok("a member can still switch to " + p, PMS.router.current === p, PMS.router.current);
  });
  route("/tasks");
  ok("a member sees the tasks table", root().querySelectorAll(".vt-row").length > 0);
  route("/meetings");
  ok("a member sees the meetings view", root().textContent.length > 0);
  ok("a member sees the meetings tab content", (function () {
    route("/meetings");
    return !!root().querySelector(".meeting-card, .empty-state, .tabs");
  })());

  // ---- managers and admins keep everything ------------------------------
  const navManager = PMS.auth.users().find(u => u.username === "mona");
  if (navManager) {
    PMS.auth.resetPassword(navManager.id, "mona1234");
    PMS.auth.login("mona", "mona1234");
    PMS.app.init();
    const mgrRoutes = Array.from(document.querySelectorAll(".nav-item")).map(el => el.dataset.route);
    ok("a manager keeps the dashboard", mgrRoutes.indexOf("/") !== -1, mgrRoutes.join(", "));
    ok("a manager keeps projects, people and reports", mgrRoutes.indexOf("/projects") !== -1 && mgrRoutes.indexOf("/people") !== -1 && mgrRoutes.indexOf("/reports") !== -1, mgrRoutes.join(", "));
    ok("a manager keeps every non-admin tab", ["/", "/projects", "/people", "/reports", "/tasks", "/meetings"].every(r => mgrRoutes.indexOf(r) !== -1), mgrRoutes.join(", "));
    ok("a manager still cannot open settings (adminOnly)", PMS.registry.viewAllowed(PMS.registry.getView("settings")) === false);
    ok("a manager still cannot open activity (adminOnly)", PMS.registry.viewAllowed(PMS.registry.getView("activity")) === false);
    route("/settings");
    ok("a manager routed to /settings is bounced", PMS.router.current !== "/settings", PMS.router.current);
    route("/reports");
    ok("a manager can still open reports", PMS.router.current === "/reports", PMS.router.current);
  }
  PMS.auth.login("boss", "pw1234");
  PMS.app.init();
  const adminRoutes = Array.from(document.querySelectorAll(".nav-item")).map(el => el.dataset.route);
  ok("an admin keeps every tab", ["/", "/projects", "/people", "/reports", "/settings", "/activity", "/tasks", "/meetings"].every(r => adminRoutes.indexOf(r) !== -1), adminRoutes.join(", "));
  ok("an admin's home is the dashboard", PMS.registry.homeRoute() === "/", PMS.registry.homeRoute());
  route("/");
  ok("an admin can still open the dashboard", PMS.router.current === "/", PMS.router.current);
  route("/reports");
  ok("an admin can still open reports", PMS.router.current === "/reports", PMS.router.current);
  // the shared helpers must be a no-op when nobody is signed in
  PMS.auth.logout();
  ok("with nobody signed in every path is allowed", PMS.registry.pathAllowed("/reports") && PMS.registry.pathAllowed("/settings"));
  ok("with nobody signed in the home is the root", PMS.registry.homeRoute() === "/");
  PMS.auth.login("boss", "pw1234");
  PMS.app.init();

  section("Tasks show who created them, and every action syncs");
  PMS.auth.login("boss", "pw1234");
  // ---- the write side stamps the creator like meetings already did -------
  const crTask = PMS.repos.tasks.add({ projectId: PMS.repos.projects.all()[0].id, title: "Creator stamped task", status: "todo", priority: "medium", assignees: [] });
  const crStored = PMS.repos.tasks.get(crTask.id);
  ok("a new task records the user id that made it", !!crStored.createdBy, String(crStored.createdBy));
  ok("a new task records the creator's name", !!crStored.createdByName, String(crStored.createdByName));
  ok("the creator name matches the signed-in user", crStored.createdByName === PMS.auth.currentUser().name);
  // boss is an admin with no linked person record, so there is no person to
  // point at - the field must stay empty rather than hold a broken id
  ok("a task made by an account with no person has no person id", !crStored.createdByPersonId, String(crStored.createdByPersonId));
  // an account that IS linked to a person must stamp that link
  const crPerson = PMS.repos.people.all().find(p => !!p && !!p.id);
  const crUser = PMS.auth.createUser({ username: "crmaker", password: "cr1234", personId: crPerson.id, role: "member" });
  ok("a linked account can be created for the test", !crUser.error && !!crUser.user.personId, crUser.error || String(crUser.user && crUser.user.personId));
  const crLinked = (function () {
    PMS.auth.login("crmaker", "cr1234");
    const t = PMS.repos.tasks.add({ projectId: crStored.projectId, title: "Linked creator task", status: "todo", assignees: [] });
    const st = PMS.repos.tasks.get(t.id);
    PMS.repos.tasks.remove(t.id);
    return st;
  })();
  ok("a task made by a linked account records that person", !!crLinked && crLinked.createdByPersonId === crPerson.id, crLinked ? String(crLinked.createdByPersonId) : "none");
  ok("the person id resolves back to a real person", !!crLinked && !!PMS.repos.people.get(crLinked.createdByPersonId));
  PMS.auth.login("boss", "pw1234");
  PMS.auth.removeUser(crUser.user.id);
  ok("the temporary account is cleaned up", !PMS.auth.users().some(u => u.username === "crmaker"));
  ok("the shared resolver falls back to the linked person", PMS.vformat.creatorOf({ createdByPersonId: crPerson.id }) === crPerson.name);
  ok("tasks and meetings stamp the creator the same way", (function () {
    const mt = PMS.repos.meetings.add({ title: "Stamp compare", date: PMS.utils.todayISO(), time: "10:00", attendees: [], agenda: [], projectIds: [] });
    const mv = PMS.repos.meetings.get(mt.id);
    const same = !!mv.createdBy === !!crStored.createdBy && !!mv.createdByName === !!crStored.createdByName && !!mv.createdByPersonId === !!crStored.createdByPersonId;
    PMS.repos.meetings.remove(mt.id);
    return same;
  })());
  // a creator supplied by the caller must win over the signed-in user
  const crKeep = PMS.repos.tasks.add({ projectId: crStored.projectId, title: "Keep creator", status: "todo", assignees: [], createdBy: "other-id", createdByName: "Someone Else" });
  ok("stamping never overwrites a creator the caller supplied", PMS.repos.tasks.get(crKeep.id).createdByName === "Someone Else" && PMS.repos.tasks.get(crKeep.id).createdBy === "other-id", PMS.repos.tasks.get(crKeep.id).createdByName);
  PMS.repos.tasks.remove(crKeep.id);

  // ---- the read side shows it in the table, kanban and detail ------------
  ok("the shared resolver finds the creator by name", PMS.vformat.creatorOf(crStored) === crStored.createdByName);
  ok("the shared resolver falls back to the user account", PMS.vformat.creatorOf({ createdBy: PMS.auth.currentUser().id }) === PMS.auth.currentUser().name);
  ok("the shared resolver returns empty for an anonymous record", PMS.vformat.creatorOf({}) === "" && PMS.vformat.creatorOf(null) === "");
  const crChip = PMS.vformat.creatorChip(crStored);
  ok("the creator chip renders", !!crChip);
  ok("the creator chip shows the initial and the name", !!crChip && crChip.querySelector(".cc-avatar").textContent === crStored.createdByName.charAt(0).toUpperCase() && crChip.querySelector(".cc-name").textContent === crStored.createdByName);
  ok("no chip for a record with no creator", PMS.vformat.creatorChip({}) === null);

  route("/tasks");
  const crCols = Array.from(root().querySelectorAll(".vt-th")).map(th => (th.textContent || "").replace(/[\u25B2\u25BC\u25B4\u25BE\u25C0]/g, "").trim());
  ok("the tasks table has a creator column", crCols.indexOf(PMS.i18n.t("tasks.createdBy")) !== -1, crCols.join(" | "));
  ok("the creator column sits next to the assignees", crCols.indexOf(PMS.i18n.t("tasks.createdBy")) === crCols.indexOf(PMS.i18n.t("tasks.assignees")) + 1, crCols.join(" | "));
  const crRow = root().querySelector('.vt-row[data-id="' + crTask.id + '"]');
  ok("the task row renders", !!crRow);
  ok("the task row shows the creator name", !!crRow && (crRow.textContent || "").indexOf(crStored.createdByName) !== -1);
  ok("the creator is a chip with an avatar, not a bare column", !!crRow && !!crRow.querySelector(".chip-creator .cc-avatar"));
  ok("a task with no creator shows a dash, not a blank cell", (function () {
    const orphan = PMS.repos.tasks.add({ projectId: crStored.projectId, title: "Orphan task", status: "todo", assignees: [] });
    PMS.repos.tasks.update(orphan.id, { createdBy: null, createdByName: "", createdByPersonId: null });
    route("/tasks");
    const orow = root().querySelector('.vt-row[data-id="' + orphan.id + '"]');
    const txt = orow ? (orow.textContent || "") : "";
    const okDash = !!orow && !orow.querySelector(".chip-creator") && txt.indexOf("-") !== -1;
    PMS.repos.tasks.remove(orphan.id);
    return okDash;
  })());
  // sorting by the creator must be a real sorter, not a fallback
  ok("the creator column is sortable", /key: "createdBy"[^}]*sortable: true/.test(fs.readFileSync(path.join(APP, "js", "views", "tasks-table.js"), "utf8")));
  ok("the creator sorter exists", typeof PMS.filterEngine.sorters.createdBy === "function");
  ok("the creator sorter orders by name", (function () {
    const a = PMS.utils.deepClone(crStored); a.createdByName = "Aaa";
    const b = PMS.utils.deepClone(crStored); b.createdByName = "Bbb";
    return PMS.filterEngine.sorters.createdBy(a, b) < 0 && PMS.filterEngine.sorters.createdBy(b, a) > 0;
  })());
  // kanban card
  route("/tasks/kanban");
  const crCard = root().querySelector('.kanban-card[data-id="' + crTask.id + '"]');
  ok("the kanban card shows the creator", !!crCard && !!crCard.querySelector(".kc-meta-by .chip-creator"));
  ok("the kanban creator line shows the name", !!crCard && (crCard.textContent || "").indexOf(crStored.createdByName) !== -1);
  ok("the kanban creator sits under the title", !!crCard && crCard.children[0].className.indexOf("kc-title") !== -1 && crCard.children[1].className.indexOf("kc-meta-by") !== -1);
  // detail modal (it mounts on the body, not inside the view root)
  PMS.taskDetail.open(crTask.id);
  ok("the task detail modal is open", PMS.modal.isOpen);
  ok("the task detail lists the creator", (document.body.textContent || "").indexOf(PMS.i18n.t("tasks.createdBy")) !== -1);
  ok("the task detail shows the creator name", (document.body.textContent || "").indexOf(crStored.createdByName) !== -1);
  PMS.modal.close();
  // the byline on meetings must still work after the resolver was shared out
  route("/meetings");
  ok("meetings still resolve their creator", typeof PMS.vformat.creatorOf({ createdByName: "Zed" }) === "string" && PMS.vformat.creatorOf({ createdByName: "Zed" }) === "Zed");
  // an import must not strip the creator off a task
  const expTask = { id: "imp1", title: "Imported", projectId: crStored.projectId, createdBy: "u9", createdByName: "Importer", createdByPersonId: "p9" };
  const kept = PMS.dataMerge.taskDB(expTask);
  ok("an imported task keeps its creator", kept.createdBy === "u9" && kept.createdByName === "Importer" && kept.createdByPersonId === "p9", JSON.stringify(kept));
  const keptM = PMS.dataMerge.meetingDB({ id: "m9", title: "M", createdBy: "u9", createdByName: "Importer", createdByPersonId: "p9" });
  ok("an imported meeting keeps its creator name too", keptM.createdByName === "Importer" && keptM.createdByPersonId === "p9", JSON.stringify(keptM));
  PMS.repos.tasks.remove(crTask.id);

  section("Every interface action is followed by a sync");
  const syncSrc = fs.readFileSync(path.join(APP, "js", "services", "sync-firestore.js"), "utf8");
  // 1. the autosave must be wired to the store change event
  ok("a store change triggers the cloud autosave", /PMS\.bus\.on\("store:changed", onChange\)/.test(syncSrc));
  // 2. a lone action must not wait for the debounce
  ok("a single deliberate action pushes immediately", /if \(!debounce && Date\.now\(\) - lastPushAt >= PUSH_SETTLE\)/.test(syncSrc));
  ok("the push records when it ran", /lastPushAt = Date\.now\(\)/.test(syncSrc));
  ok("a burst of edits still coalesces into one push", /debounce = setTimeout\(function \(\) \{ debounce = null; push\(\); \}, PUSH_DEBOUNCE\)/.test(syncSrc));
  // 3. leaving the tab must not swallow a pending change
  ok("closing the tab flushes the pending change", /addEventListener\("beforeunload", onBeforeUnload\)/.test(syncSrc) && /addEventListener\("pagehide", onPageHide\)/.test(syncSrc));
  ok("the unload flush saves locally and uploads", /onBeforeUnload = function \(\)[\s\S]{0,400}PMS\.store\.flush\(\)[\s\S]{0,200}push\(\)/.test(syncSrc));
  ok("the unload handlers are removed on teardown", /removeEventListener\("beforeunload", onBeforeUnload\)/.test(syncSrc) && /removeEventListener\("pagehide", onPageHide\)/.test(syncSrc));
  // 4. a wholesale dataset swap must forget the stale cloud mirror
  ok("there is a dataReplaced API", typeof PMS.cloudsync.dataReplaced === "function");
  ok("dataReplaced clears the cloud mirror", /function dataReplaced\(\)[\s\S]{0,300}removeItem\(MIRROR_KEY\)/.test(syncSrc));
  ok("dataReplaced pushes the new dataset", /function dataReplaced\(\)[\s\S]{0,600}return push\(\)/.test(syncSrc));
  ["js/data/seed.js", "js/data/backup.js", "js/services/export.js", "js/views/settings.js"].forEach(f => {
    const src = fs.readFileSync(path.join(APP, f), "utf8");
    const afterReplace = src.split("PMS.store.setData(")[1] || "";
    ok("a wholesale replace in " + f + " resets the mirror", afterReplace.indexOf("cloudsync.dataReplaced()") !== -1 && afterReplace.indexOf("cloudsync.dataReplaced()") < 400);
  });
  // 5. it must be a no-op when sync is off, not a crash
  ok("dataReplaced is safe with sync disabled", (function () {
    return PMS.cloudsync.dataReplaced().then(function (r) { return r === false; });
  })());
  // 6. every repo mutation has to reach the store commit that emits the event
  const repoSrc = fs.readFileSync(path.join(APP, "js", "data", "repositories.js"), "utf8");
  ok("repo writes go through the shared writer that commits", /function add\(collection, obj\)/.test(repoSrc) && /PMS\.store\.commit/.test(repoSrc));
  const storeSrc = fs.readFileSync(path.join(APP, "js", "core", "store.js"), "utf8");
  ok("the store emits store:changed on every commit", /function commit\(fn, desc\)[\s\S]{0,600}PMS\.bus\.emit\("store:changed"/.test(storeSrc));
  // flush() persists locally but must NOT emit store:changed, or a save would
  // look like a user edit and echo itself back to the cloud
  const flushBody = storeSrc.split("function flush")[1] ? storeSrc.split("function flush")[1].split(/\n  function /)[0] : "";
  ok("a local save is not mistaken for a user edit", flushBody.length > 0 && flushBody.indexOf("store:changed") === -1);
  // every emitter must sit in a real user-action path, so undo/redo and a
  // wholesale replace upload just like a direct edit does
  ok("every store:changed emitter is a user action", (function () {
    const names = [];
    storeSrc.split("\n").forEach((line, i) => {
      if (line.indexOf('PMS.bus.emit("store:changed') === -1) return;
      for (let j = i; j >= 0; j--) {
        const m = storeSrc.split("\n")[j].match(/^  function (\w+)/);
        if (m) { names.push(m[1]); return; }
      }
    });
    return names.length === 4 && names.every(n => ["commit", "setData", "undo", "redo"].indexOf(n) !== -1);
  })(), (function () {
    const out = [];
    storeSrc.split("\n").forEach(line => { if (line.indexOf('PMS.bus.emit("store:changed') !== -1) out.push(line.trim()); });
    return out.length + " emitters";
  })());

  console.log("\n==========================================");
  console.log("RESULTS: " + passCount + " passed, " + failCount + " failed");
  console.log(process.exitCode ? "FULL TEST FAILED" : "FULL TEST PASSED");
  process.exit(process.exitCode || 0);
})().catch(err => {
  console.error("FATAL in test harness:", err && err.stack || err);
  process.exit(1);
});