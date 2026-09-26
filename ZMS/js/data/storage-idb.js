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

  function load() {
    return new Promise(function (resolve) {
      // Try IndexedDB first
      idbGet().then(function (data) {
        resolve(data);
      }).catch(function () {
        // fallback to localStorage
        try {
          var raw = window.localStorage.getItem(KEY);
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function save(data) {
    return idbPut(data).catch(function () {
      // IndexedDB unavailable/failed -> fall back to localStorage. If we hit a
      // quota error, prune old auto-backups first, then retry once.
      var json;
      try {
        json = JSON.stringify(data);
      } catch (e) {
        return Promise.reject(e);
      }
      try {
        window.localStorage.setItem(KEY, json);
        return Promise.resolve();
      } catch (e) {
        try { pruneLocalBackupsForSpace(); } catch (e2) { /* noop */ }
        try {
          window.localStorage.setItem(KEY, json);
          return Promise.resolve();
        } catch (e2) {
          return Promise.reject(e2);
        }
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
    return idbDelete().catch(function () {
      try { window.localStorage.removeItem(KEY); } catch (e) { /* noop */ }
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