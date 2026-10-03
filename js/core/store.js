/* ==========================================================================
   PMS.store - central data store.
   - single source of truth (this.data)
   - all mutations flow through store.commit(fn, desc) which:
       * deep-clones data, runs fn, persists (debounced), emits "store:changed"
   - Undo/Redo snapshots (last N edits)
   NOTE: views must NEVER write to storage directly — only repositories call commit.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;
  var data = null;
  var initialized = false;

  var pendingSave = null; // debounce timer
  var saving = false;
  var saveQueue = Promise.resolve();
  var retryTimer = null;
  var retryCount = 0;

  var undoStack = [];
  var redoStack = [];
  var UNDO_LIMIT = 50;
  var savingSnapshot = false; // guard so undo/redo do not re-push snapshots

  function commit(fn, desc) {
    if (!data) return;
    var prev = U.deepClone(data);
    fn(data); // mutate in place
    data.meta.updatedAt = new Date().toISOString();
    if (!savingSnapshot) {
      undoStack.push({ data: prev, desc: desc || "edit" });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack = [];
    }
    scheduleSave();
    PMS.bus.emit("store:changed", { desc: desc });
  }

  function setData(newData) {
    data = newData;
    ensureShape(data); // imports/backups/sync set data directly; keep shape + statuses coherent
    undoStack = [];
    redoStack = [];
    scheduleSave();
    PMS.bus.emit("store:changed", { desc: "setData" });
  }

  function scheduleSave() {
    clearTimeout(pendingSave);
    pendingSave = setTimeout(flush, 300); // debounced autosave
  }

  function flush(dataToWrite) {
    if (saving) {
      // coalesce: queue a fresh flush after current finishes
      saveQueue = saveQueue.then(function () { return flush(dataToWrite || data); });
      return saveQueue;
    }
    clearTimeout(pendingSave);
    clearTimeout(retryTimer);
    if (!data) return Promise.resolve();
    var payload = dataToWrite || data;
    PMS.bus.emit("save:starting", payload);
    saving = true;
    var localOk = false;
    var p = Promise.resolve().then(function () {
      return PMS.storage.save(U.deepClone(payload));
    }).then(function () {
      localOk = true;
    }).catch(function (e) {
      console.error("[store] save attempt failed", e);
      // Retry once immediately, then fall back to a periodic backoff cleanup
      // so transient storage hiccups self-heal instead of nagging the user.
      return PMS.storage.save(U.deepClone(payload)).then(function () {
        localOk = true;
      }).catch(function (e2) {
        console.error("[store] save failed after retry, scheduling backoff", e2);
        retryCount++;
        retryTimer = setTimeout(flush, Math.min(30000, 1500 * Math.pow(2, retryCount)));
        PMS.bus.emit("save:error", { error: e2, message: e2 && e2.message ? e2.message : String(e2) });
      });
    }).then(function () {
      if (retryTimer) { retryCount = 0; clearTimeout(retryTimer); retryTimer = null; }
      if (localOk) {
        PMS.bus.emit("save:done", { local: true });
        return mirrorToFile(payload);
      }
    }).catch(function (e) {
      console.error("[store] post-save error", e);
    }).then(function () {
      saving = false;
    });
    saveQueue = saveQueue.then(function () { return p; });
    return saveQueue;
  }

  // Best-effort file mirror. MUST never reject: a file-sync failure is not a
  // data-loss event (IndexedDB already saved), so it must not surface as
  // "save:error". Promise.resolve().then() also swallows synchronous throws
  // (e.g. createWritable() throwing on a lost handle).
  function mirrorToFile(payload) {
    return Promise.resolve().then(function () {
      if (!PMS.fileStorage || PMS.fileStorage.status() !== "bound") return;
      return PMS.fileStorage.save(payload).then(function () {
        PMS.bus.emit("save:done", { file: true, local: true });
      }).catch(function () {
        PMS.bus.emit("save:file-error");
      });
    }).catch(function () {
      PMS.bus.emit("save:file-error");
    });
  }

  function needsMigration(raw) {
    if (!raw || typeof raw !== "object") return true;
    return (raw.schemaVersion || 1) < PMS.schema.VERSION;
  }

  function init() {
    return PMS.storage.load().then(function (raw) {
      if (needsMigration(raw)) {
        var migrated = PMS.migrations.migrate(raw);
        if (migrated) data = migrated;
        else data = PMS.schema.defaultData();
      } else {
        data = raw;
      }
      // ensure all arrays exist (schema coherence for older saved data)
      ensureShape(data);
      initialized = true;
      PMS.bus.emit("store:ready", data);
      return data;
    });
  }

  function ensureShape(d) {
    var keys = ["departments", "people", "projects", "tasks", "subtasks", "meetings", "users", "customFieldDefs",
      "taskStatuses", "projectStatuses", "priorities", "savedFilters", "activities"];
    keys.forEach(function (k) {
      if (!Array.isArray(d[k])) d[k] = [];
    });
    // Old builds did not persist statuses/priorities. Backfill the schema
    // defaults when they are missing or empty, otherwise views (kanban,
    // reports, settings) render with no rows at all.
    var defaults = PMS.schema.defaultData();
    if (!d.taskStatuses.length) d.taskStatuses = U.deepClone(defaults.taskStatuses);
    if (!d.projectStatuses.length) d.projectStatuses = U.deepClone(defaults.projectStatuses);
    if (!d.priorities.length) d.priorities = U.deepClone(defaults.priorities);
    // pct-per-status drives derived task progress; backfill old saved statuses
    (d.taskStatuses || []).forEach(function (s) {
      if (typeof s.pct !== "number") {
        var dft = defaults.taskStatuses.find(function (x) { return x.key === s.key; });
        s.pct = dft && typeof dft.pct === "number" ? dft.pct : 0;
      }
    });
    if (!d.settings) d.settings = { lang: "en", theme: "light", weightByTime: false, autoBackupEnabled: true, autoBackupEveryMin: 30, maxBackups: 5, autoSync: true };
    else {
      d.settings.lang = d.settings.lang || "en";
      d.settings.theme = d.settings.theme || "light";
      d.settings.autoSync = d.settings.autoSync !== false;
      // Program progress config: importance weights, status ceilings and the
      // planned-subtask baseline. Older saves predate them, so backfill.
      d.settings.importanceWeights = Object.assign({}, defaults.settings.importanceWeights, d.settings.importanceWeights || {});
      d.settings.statusCeilings = Object.assign({}, defaults.settings.statusCeilings, d.settings.statusCeilings || {});
      // The `review` ceiling used to ship as 99. 99.9 is the documented limit, and
      // that 99 was never a choice anybody made, so carry it forward.
      if (Number(d.settings.statusCeilings.review) === 99) d.settings.statusCeilings.review = 99.9;
      if (typeof d.settings.defaultPlannedSubtasks !== "number") {
        d.settings.defaultPlannedSubtasks = defaults.settings.defaultPlannedSubtasks;
      }
    }
    if (!d.schemaVersion) d.schemaVersion = PMS.schema.VERSION;
    if (!d.meta) d.meta = { updatedAt: null };
    // tasks: meeting backlink + task-to-task links are optional
    (d.tasks || []).forEach(function (t) {
      if (!Array.isArray(t.linkedTaskIds)) t.linkedTaskIds = [];
      if (t.meetingId === undefined) t.meetingId = null;
      // Planned-subtask scope + the priority weight it implies (spec 4/6/9).
      if (typeof t.plannedSubtasks !== "number" || isNaN(t.plannedSubtasks) || t.plannedSubtasks < 0) {
        t.plannedSubtasks = d.settings.defaultPlannedSubtasks;
      }
      t.plannedSubtasks = Math.floor(t.plannedSubtasks);
      // `importance` duplicated the existing `priority` field exactly, so a
      // record saved with it keeps that value and the duplicate is dropped.
      var LEVELS = PMS.programProgress.IMPORTANCE_LEVELS;
      if (LEVELS.indexOf(t.priority) === -1 && LEVELS.indexOf(t.importance) !== -1) {
        t.priority = t.importance;
      }
      if (LEVELS.indexOf(t.priority) === -1) t.priority = "medium";
      delete t.importance;
      // Same resolver the repositories use, so a custom weights map in settings
      // is honoured here too instead of being hard-coded to a fallback.
      t.importanceWeight = PMS.programProgress.importanceWeights(d)[t.priority];
    });
    // pillars: relative weight + planned slot scope. There is no `rawWeight`
    // beside `weight`: `weight` is the weight, and `plannedTasks` counts
    // low-priority slots.
    (d.projects || []).forEach(function (p) {
      // `rawWeight` shipped briefly beside `weight`. If a record only ever got
      // the old field, adopt its value instead of throwing it away.
      var pw = Number(p.weight);
      if (isNaN(pw) || pw <= 0) pw = Number(p.rawWeight);
      p.weight = isNaN(pw) || pw <= 0 ? 1 : pw;
      if (typeof p.plannedTasks !== "number" || isNaN(p.plannedTasks) || p.plannedTasks < 0) {
        p.plannedTasks = typeof p.plannedTaskCount === "number" ? p.plannedTaskCount : 0;
      }
      p.plannedTasks = Math.max(0, Math.floor(p.plannedTasks));
      p.plannedTaskCount = p.plannedTasks;
      delete p.rawWeight;
      delete p.defaultTaskImportance;
    });
    // subtasks: one owner task + one status, both required by the progress model
    (d.subtasks || []).forEach(function (s) {
      if (!s.taskId) s.taskId = null;
      if (!s.title) s.title = "";
      if (!s.status) s.status = "todo";
      if (typeof s.progress !== "number" || isNaN(s.progress)) s.progress = 0;
    });
  }

  function undo() {
    if (!undoStack.length) return false;
    if (savingSnapshot) return false;
    savingSnapshot = true;
    redoStack.push({ data: U.deepClone(data), desc: redoDesc() });
    var entry = undoStack.pop();
    data = entry.data;
    ensureShape(data);
    savingSnapshot = false;
    scheduleSave();
    PMS.bus.emit("store:changed", { desc: "undo:" + entry.desc });
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    savingSnapshot = true;
    undoStack.push({ data: U.deepClone(data), desc: "redo" });
    var entry = redoStack.pop();
    data = entry.data;
    ensureShape(data);
    savingSnapshot = false;
    scheduleSave();
    PMS.bus.emit("store:changed", { desc: "redo" });
    return true;
  }

  function redoDesc() {
    return "redo";
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  PMS.store = {
    init: init,
    commit: commit,
    setData: setData,
    flush: flush,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    ensureShape: ensureShape,
    get data() { return data; },
    get initialized() { return initialized; }
  };
})(window.PMS);