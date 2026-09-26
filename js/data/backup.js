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

  function persist() {
    try {
      var slim = backups.map(function (b) {
        return { id: b.id, createdAt: b.createdAt, data: b.data };
      });
      window.localStorage.setItem(LS_KEY, JSON.stringify(slim.slice(-30)));
    } catch (e) { /* localStorage may be full */ }
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(LS_KEY);
      backups = raw ? JSON.parse(raw) : [];
    } catch (e) { backups = []; }
    return backups;
  }

  function list() {
    return backups.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
  }

  function create() {
    var b = {
      id: PMS.ids.uuid(),
      createdAt: new Date().toISOString(),
      data: sanitizedData()
    };
    backups.push(b);
    // keep only last N
    var max = (PMS.store.data && PMS.store.data.settings && PMS.store.data.settings.maxBackups) || 10;
    if (backups.length > max) {
      backups.sort(function (a, bb) { return bb.createdAt.localeCompare(a.createdAt); });
      backups = backups.slice(0, max);
    }
    persist();
    PMS.bus.emit("backups:changed", list());
    return b;
  }

  function restore(id) {
    // Destructive operation: admin only (ZMS-13).
    if (!adminOnly()) return Promise.reject(new Error("forbidden"));
    var b = backups.find(function (x) { return x.id === id; });
    if (!b) return Promise.reject(new Error("backup not found"));
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
    return Promise.resolve();
  }

  function remove(id) {
    if (!adminOnly()) return;
    backups = backups.filter(function (x) { return x.id !== id; });
    persist();
    PMS.bus.emit("backups:changed", list());
  }

  function startAuto() {
    var s = PMS.store.data && PMS.store.data.settings || {};
    if (!s.autoBackupEnabled) return;
    var every = Math.max(1, Number(s.autoBackupEveryMin) || 30) * 60000;
    setInterval(function () {
      if (PMS.store.data && PMS.store.data.settings.autoBackupEnabled) create();
    }, every);
  }

  PMS.backup = { create: create, restore: restore, remove: remove, list: list, load: load, startAuto: startAuto };
})(window.PMS);