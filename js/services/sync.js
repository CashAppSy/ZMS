/* ==========================================================================
   PMS.sync - automatic synchronization with the bound file.
   While autoSync is enabled and a file is bound, the app periodically reads
   that file. If the file's meta.updatedAt is newer than the local data, the
   app imports it automatically (replace) so edits made in another browser on
   the same file appear here without manual action.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var INTERVAL = 15000; // poll every 15s
  var COOLDOWN = 3000; // minimum gap between file reads
  var IMPORT_COOLDOWN = 5000; // don't re-import right after an import

  var timer = null;
  var started = false;
  var lastRead = 0;
  var lastImport = 0;
  var duringImport = false;

  function isEnabled() {
    return !!(PMS.store.data.settings && PMS.store.data.settings.autoSync);
  }

  function start() {
    if (started) return;
    started = true;
    tick();
    timer = setInterval(tick, INTERVAL);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) tick();
    });
    PMS.bus.on("save:done", function () {
      // shortly after a local save, re-check the file (equal updatedAt = no-op)
      setTimeout(tick, 2000);
    });
  }

  function stop() {
    started = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function tick() {
    if (!started) return;
    if (!PMS.store.initialized) return;
    if (!isEnabled()) return;
    if (PMS.fileStorage.status() !== "bound") return;
    if (duringImport) return;

    var now = Date.now();
    if (now - lastRead < COOLDOWN) return;
    lastRead = now;

    PMS.fileStorage.read().then(function (text) {
      if (!text) return;
      var obj;
      try { obj = JSON.parse(text); } catch (e) { return; }
      var check = PMS.exportService.validateImport(obj);
      if (!check.valid) return;

      var diskUpdated = obj.meta && obj.meta.updatedAt;
      var localUpdated = PMS.store.data.meta && PMS.store.data.meta.updatedAt;
      if (!diskUpdated || (localUpdated && diskUpdated <= localUpdated)) return;
      if (now - lastImport < IMPORT_COOLDOWN) return;
      lastImport = now;

      duringImport = true;
      PMS.exportService.importJSON(obj, "replace");
      duringImport = false;
      PMS.toast.show(PMS.i18n.t("sync.synced"), "success");
      PMS.router.handle(); // re-render the current view immediately
    }).catch(function () { /* not bound / read failed: silently retry later */ });
  }

  PMS.sync = { start: start, stop: stop, tick: tick, isEnabled: isEnabled };
})(window.PMS);