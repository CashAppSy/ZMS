/* ==========================================================================
   PMS.backup - automatic periodic + manual backups.
   Backups are snapshots of the whole data object kept in memory during the
   session (and optionally persisted to localStorage so they survive reload).
   The "last N" retention is configurable in settings.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var LS_KEY = "pms-backups";
  var backups = [];

  // SECURITY (ZMS-09): backups must not become a side-channel for stolen
  // password hashes. Snapshots keep account identity fields but never
  // passwordHash/salt.
  function sanitizedData() {
    var d = PMS.utils.deepClone(PMS.store.data || {});
    if (Array.isArray(d.users)) {
      d.users = d.users.map(function (u) {
        var c = PMS.utils.deepClone(u || {});
        if (c && typeof c === "object") { delete c.passwordHash; delete c.salt; }
        return c;
      });
    }
    return d;
  }

  function adminOnly() {
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return !!(u && u.role === "admin");
  }

  /* ---------------- Firestore: the shared source of truth -------------
     Backups were localStorage-only, which meant every device kept its own
     private history, a snapshot died with the browser, and a new device
     inherited nothing. They are now per-record documents in zms_backups, so
     ONE shared history exists for all admins and survives a cleared browser.

     localStorage is kept purely as an OFFLINE cache: a restore must still work
     when the network is down, and reading a snapshot is not a write. The cloud
     is the authority; on every refresh the local cache is replaced by the
     cloud list, and a snapshot that exists only locally is marked stale rather
     than presented as if it were shared.
     -------------------------------------------------------------------- */
  var META_KEY = "pms-backups-meta";

  function cloudReady() {
    return !!(PMS.cloudsync && PMS.cloudsync.isEnabled && PMS.cloudsync.isEnabled() && adminOnly());
  }

  function meta() {
    try { return JSON.parse(window.localStorage.getItem(META_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function setMeta(m) {
    try { window.localStorage.setItem(META_KEY, JSON.stringify(m || {})); } catch (e) {}
  }

  // Excludes the cache itself and the cloud-only account-event list, otherwise
  // every snapshot would carry every earlier snapshot's data.
  function snapshotData() {
    var d = sanitizedData();
    delete d.accountEvents;
    return d;
  }

  // A snapshot is uploaded once. This flag is what stops an admin's routine
  // auto-backup from re-uploading the shared history from a second device.
  function isUploaded(b) {
    var m = meta();
    return !!(m.uploaded && m.uploaded[b.id]);
  }

  function markUploaded(id) {
    var m = meta();
    if (!m.uploaded) m.uploaded = {};
    m.uploaded[id] = new Date().toISOString();
    setMeta(m);
  }

  function persist() {
    try {
      var slim = backups.map(function (b) {
        return { id: b.id, createdAt: b.createdAt, data: b.data, uploaded: !!isUploaded(b) };
      });
      window.localStorage.setItem(LS_KEY, JSON.stringify(slim));
    } catch (e) { /* localStorage may be full */ }
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      backups = raw ? JSON.parse(raw) : [];
    } catch (e) { backups = []; }
    backups.forEach(function (b) { if (b && b.uploaded === undefined) b.uploaded = isUploaded(b); });
    return backups;
  }

  // Newest first. A local-only snapshot is flagged `localOnly` so the UI can
  // say plainly that it has not reached the shared cloud.
  function list() {
    var rows = backups.slice();
    rows.forEach(function (b) { b.localOnly = !isUploaded(b); });
    return rows.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
  }

  // Replace the whole collection: delete anything the server has that is no
  // longer kept. Retention must therefore match the cloud, or the delete would
  // drop snapshots the cloud still has.
  function retention() {
    return (PMS.store.data && PMS.store.data.settings && PMS.store.data.settings.maxBackups) || 10;
  }

  function pushToCloud(b) {
    if (isUploaded(b)) return Promise.resolve(false);
    if (!cloudReady()) return Promise.resolve(false);
    return PMS.cloudsync.saveBackup(b).then(function (ok) {
      if (ok) { markUploaded(b.id); persist(); }
      return ok;
    }).catch(function (e) {
      console.warn("[backup] cloud upload deferred:", e);
      return false;
    });
  }

  // Enforce retention in the cloud. Admin-only (mirrors the rules).
  function trimCloud() {
    if (!cloudReady()) return Promise.resolve(false);
    return PMS.cloudsync.trimBackups(retention()).catch(function (e) {
      console.warn("[backup] cloud trim deferred:", e);
      return false;
    });
  }

  function create() {
    var b = {
      id: PMS.ids.uuid(),
      createdAt: new Date().toISOString(),
      data: snapshotData()
    };
    backups.push(b);
    var max = retention();
    if (backups.length > max) {
      backups.sort(function (a, bb) { return bb.createdAt.localeCompare(a.createdAt); });
      backups = backups.slice(0, max);
    }
    persist();
    PMS.bus.emit("backups:changed", list());
    // Upload the new snapshot and then enforce retention. A failure here is not
    // a data-loss event: the snapshot is already in the local cache and will be
    // retried on the next run.
    if (cloudReady()) {
      pushToCloud(b).then(function () { return trimCloud(); });
    }
    return b;
  }

  // Pull the shared list so a fresh device (or one whose cache was cleared)
  // inherits the team's history instead of starting empty.
  function refresh() {
    if (!cloudReady()) return Promise.resolve(list());
    return PMS.cloudsync.listBackups().then(function (rows) {
      if (!rows || !rows.length) return list();
      var byId = {};
      rows.forEach(function (r) { byId[r.id] = r; });
      // Keep any local snapshot the cloud does not have yet (a not-yet-uploaded
      // one); add every cloud snapshot we were missing.
      backups.forEach(function (b) { if (b && b.id && !byId[b.id]) byId[b.id] = b; });
      backups = Object.keys(byId).map(function (k) { return byId[k]; });
      backups.forEach(function (b) { markUploaded(b.id); });
      persist();
      PMS.bus.emit("backups:changed", list());
      return list();
    }).catch(function (e) {
      console.warn("[backup] cloud list unavailable:", e);
      return list();
    });
  }

  function restore(id) {
    // Destructive operation: admin only (ZMS-13).
    if (!adminOnly()) return Promise.reject(new Error("forbidden"));
    // ZMS-R16: restore is STRICTLY gated behind a freshly re-authenticated
    // admin password in production (token consumed once, so it cannot be fired
    // from the console without a verified password). Tests bypass via
    // window.__ZMS_TEST__.
    if (!window.__ZMS_TEST__ && !(PMS.auth && PMS.auth.consumeFreshAdmin())) {
      if (PMS.toast && PMS.toast.show) PMS.toast.show(PMS.i18n.t("confirm.sensitiveRequired"), "error");
      return Promise.resolve(false);
    }
    var b = backups.find(function (x) { return x.id === id; });
    // Not in the local cache: it is on a colleague's device, so read it from
    // the shared cloud rather than reporting a false "backup not found".
    if (!b) {
      if (!cloudReady()) return Promise.reject(new Error("backup not found"));
      return PMS.cloudsync.loadBackup(id).then(function (row) {
        if (!row) throw new Error("backup not found");
        return applyRestore(row);
      }, function () { throw new Error("backup not found"); });
    }
    return applyRestore(b);
  }

  function applyRestore(b) {
    var snap = PMS.utils.deepClone(b.data);
    // Keep current accounts when the snapshot predates them, so a restore can
    // never log everyone out of the app.
    if (!snap.users || !snap.users.length) snap.users = PMS.utils.deepClone((PMS.store.data && PMS.store.data.users) || []);
    // Snapshots carry NO password hashes (see sanitizedData). Re-hydrate the
    // live hash/salt for accounts that still exist so a restore does not lock
    // everyone out; brand-new restored accounts just need a password reset.
    if (Array.isArray(snap.users)) {
      var current = (PMS.store.data && PMS.store.data.users) || [];
      snap.users.forEach(function (u) {
        var live = current.find(function (x) { return x && x.id === u.id; });
        if (live) { u.passwordHash = live.passwordHash; u.salt = live.salt; }
      });
    }
    PMS.store.setData(snap);
    // wholesale replacement: the cloud mirror described the previous dataset,
    // so forget it before the next push reads it
    if (PMS.cloudsync && PMS.cloudsync.dataReplaced) PMS.cloudsync.dataReplaced();
    return Promise.resolve();
  }

  function remove(id) {
    if (!adminOnly()) return;
    backups = backups.filter(function (x) { return x.id !== id; });
    var m = meta();
    if (m.uploaded) delete m.uploaded[id];
    setMeta(m);
    persist();
    PMS.bus.emit("backups:changed", list());
    // Deleting a snapshot is destructive, so it is removed from the shared
    // history too. Best effort: the local list is already correct.
    if (cloudReady()) {
      PMS.cloudsync.deleteBackup(id).catch(function (e) {
        console.warn("[backup] cloud delete deferred:", e);
      });
    }
  }

  function startAuto() {
    var s = PMS.store.data && PMS.store.data.settings || {};
    if (!s.autoBackupEnabled) return;
    var every = Math.max(1, Number(s.autoBackupEveryMin) || 30) * 60000;
    setInterval(function () {
      if (PMS.store.data && PMS.store.data.settings.autoBackupEnabled) create();
    }, every);
  }

  PMS.backup = {
    create: create, restore: restore, remove: remove, list: list, load: load,
    refresh: refresh, startAuto: startAuto
  };
})(window.PMS);