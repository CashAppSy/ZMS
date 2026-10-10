/* ==========================================================================
   PMS.storage - IndexedDB persistence layer (fallback: localStorage for
   browsers that block IndexedDB on file:// such as Firefox private mode).
   Single object store "app" with one record keyed "pms-data".
   ========================================================================== */
(function (PMS) {
  "use strict";

  var DB_NAME = "pms-db";
  var DB_VERSION = 1;
  var STORE = "app";
  var KEY = "pms-data";

  var db = null;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (db) return resolve(db);
      if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
      var req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = function (e) {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error("IDB open failed")); };
    });
  }

  function idbGet() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readonly");
        var r = tx.objectStore(STORE).get(KEY);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbPut(value) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Local save revisions distinguish a newer fallback write from stale IDB.
  // Keep datasets in the legacy shape so older app builds can still read them.
  var lastRevision = 0;
  function decode(value) {
    if (!value) return null;
    if (value.__pmsStorage === 1) {
      if (!value.data || typeof value.data !== "object" || !Number.isFinite(value.revision)) {
        throw new Error("Invalid storage envelope");
      }
      return { data: value.data, revision: value.revision };
    }
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored dataset");
    var revision = value.meta && value.meta.localSaveRevision;
    return { data: value, revision: Number.isFinite(revision) ? revision : Date.parse(value.meta && value.meta.updatedAt) || 0 };
  }

  function readFallback() {
    var raw = window.localStorage.getItem(KEY);
    return decode(raw ? JSON.parse(raw) : null);
  }

  function load() {
    var fallback = null, fallbackError = null;
    try { fallback = readFallback(); } catch (e) { fallbackError = e; }
    return idbGet().then(function (raw) {
      var primary = decode(raw);
      var latest = fallback && (!primary || fallback.revision > primary.revision) ? fallback : primary;
      if (!latest && fallbackError) throw fallbackError;
      if (!latest) return null;
      lastRevision = Math.max(lastRevision, latest.revision);
      return latest.data;
    }).catch(function (e) {
      if (fallback) {
        lastRevision = Math.max(lastRevision, fallback.revision);
        return fallback.data;
      }
      // An unavailable IDB with readable, empty fallback is a fresh install.
      // A failed/corrupt fallback must never masquerade as an empty database.
      if (!fallbackError && !window.indexedDB) return null;
      var error = new Error("Stored data could not be read; existing data has been preserved.");
      error.cause = fallbackError || e;
      throw error;
    });
  }

  function save(data) {
    lastRevision = Math.max(Date.now(), lastRevision + 1);
    var snapshot = PMS.utils.deepClone(data);
    if (!snapshot.meta) snapshot.meta = {};
    snapshot.meta.localSaveRevision = lastRevision;
    return idbPut(snapshot).then(function () {
      // Only discard a fallback superseded by this successful write.
      try {
        var fallback = readFallback();
        if (fallback && fallback.revision <= snapshot.meta.localSaveRevision) window.localStorage.removeItem(KEY);
      } catch (e) { /* preserve unreadable fallback for recovery */ }
    }).catch(function () {
      var json = JSON.stringify(snapshot);
      try {
        window.localStorage.setItem(KEY, json);
      } catch (e) {
        pruneLocalBackupsForSpace();
        window.localStorage.setItem(KEY, json);
      }
    });
  }

  // Sets "pms-backups" to empty when localStorage is full, so the primary data
  // record can always be persisted. Backups are a convenience, data is not.
  function pruneLocalBackupsForSpace() {
    try {
      window.localStorage.setItem("pms-backups", "[]");
    } catch (e) { /* noop */ }
  }

  function clear() {
    return idbDelete().catch(function (e) {
      if (window.indexedDB) throw e;
    }).then(function () {
      window.localStorage.removeItem(KEY);
    });
  }

  /* File handle persistence (structured-cloneable) */
  function saveHandle(h) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(h, "pms-file-handle");
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadHandle() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readonly");
        var r = tx.objectStore(STORE).get("pms-file-handle");
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function clearHandle() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete("pms-file-handle");
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  PMS.storage = { load: load, save: save, clear: clear, saveHandle: saveHandle, loadHandle: loadHandle, clearHandle: clearHandle };
})(window.PMS);
