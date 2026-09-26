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
    var keys = ["departments", "people", "projects", "tasks", "users", "customFieldDefs",
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
    if (!d.settings) d.settings = { lang: "en", theme: "light", weightByTime: false, autoBackupEnabled: true, autoBackupEveryMin: 30, maxBackups: 5, autoSync: true };
    else {
      d.settings.lang = d.settings.lang || "en";
      d.settings.theme = d.settings.theme || "light";
      d.settings.autoSync = d.settings.autoSync !== false;
    }
    if (!d.schemaVersion) d.schemaVersion = PMS.schema.VERSION;
    if (!d.meta) d.meta = { updatedAt: null };
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