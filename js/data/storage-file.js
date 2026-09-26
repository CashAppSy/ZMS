/* ==========================================================================
   PMS.fileStorage - optional binding to a local JSON file via the File
   System Access API. Persists the file handle in IndexedDB and re-requests
   permission on reload (requires a user gesture).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var HANDLE_KEY = "pms-file-handle";
  var supported = !!(window.showSaveFilePicker && window.showOpenFilePicker);
  var handle = null;
  var bound = false;

  function persistHandle(h) {
    // Handles are structured-cloneable and can live in IndexedDB.
    return PMS.storage.saveHandle ? PMS.storage.saveHandle(h) : saveHandleFallback(h);
  }

  function loadHandle() {
    return PMS.storage.loadHandle ? PMS.storage.loadHandle() : Promise.resolve(null);
  }

  // If this build's storage module exposes handle store, use it. Otherwise use a tiny IDB.
  function saveHandleFallback(h) {
    return openHandleDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction("handles", "readwrite");
        tx.objectStore("handles").put(h, HANDLE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function openHandleDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("pms-fh", 1);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains("handles")) d.createObjectStore("handles");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function requestPermission(h) {
    if (!h || !h.queryPermission) return Promise.resolve(true);
    return h.queryPermission({ mode: "readwrite" }).then(function (state) {
      if (state === "granted") return true;
      if (h.requestPermission) {
        return h.requestPermission({ mode: "readwrite" }).then(function (s) {
          return s === "granted";
        });
      }
      return true;
    });
  }

  function status() {
    if (!supported) return "unsupported";
    if (!bound && !handle) return "unbound";
    return bound ? "bound" : "pending";
  }

  function init() {
    if (!supported) return Promise.resolve(false);
    return loadHandle().then(function (h) {
      if (!h) return false;
      handle = h;
      return requestPermission(h).then(function (granted) {
        bound = granted;
        return bound;
      });
    }).catch(function () { return false; });
  }

  function bind() {
    if (!supported) {
      return Promise.reject(new Error("File System Access API not supported"));
    }
    return window.showSaveFilePicker({
      suggestedName: "pms-data.json",
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
    }).then(function (h) {
      handle = h;
      bound = true;
      return persistHandle(h).then(function () { return true; });
    });
  }

  function save(data) {
    if (!bound || !handle) return Promise.reject(new Error("Not bound"));
    var w = handle.createWritable ? handle.createWritable() : Promise.resolve();
    return w.then(function (writer) {
      return writer.write(JSON.stringify(data, null, 2)).then(function () {
        return writer.close();
      });
    }).catch(function () {
      bound = false; // permission lost
      throw new Error("File permission lost");
    });
  }

  // Read current content of the bound file (used by auto-sync). Returns the
  // raw text, or null if the handle cannot be read.
  function read() {
    if (!bound || !handle) return Promise.reject(new Error("Not bound"));
    if (!handle.getFile) return Promise.resolve(null);
    return handle.getFile().then(function (f) { return f.text(); });
  }

  function open() {
    if (!supported) return Promise.reject(new Error("File System Access API not supported"));
    return window.showOpenFilePicker({
      types: [{ description: "JSON", accept: { "application/json": [".json", ".pms"] } }]
    }).then(function (files) {
      if (!files || !files.length) throw new Error("No file selected");
      var h = files[0];
      if (h.getFile) {
        return h.getFile().then(function (f) { return f.text(); })
          .then(function (text) { return { handle: h, text: text }; });
      }
      return { handle: h, text: null };
    });
  }

  // Bind to an already-picked handle (called only after the user confirms
  // importing its content). Kept separate from open() so a cancelled import
  // never silently binds/overwrites the chosen file.
  function adopt(h) {
    handle = h;
    bound = true;
    return persistHandle(h).then(function () { return true; });
  }

  function unbind() {
    handle = null;
    bound = false;
    if (PMS.storage.clearHandle) return PMS.storage.clearHandle();
    return openHandleDB().then(function (d) {
      return new Promise(function (resolve) {
        var tx = d.transaction("handles", "readwrite");
        tx.objectStore("handles").delete(HANDLE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = function () { resolve(); };
      });
    });
  }

  PMS.fileStorage = {
    supported: supported,
    status: status,
    init: init,
    bind: bind,
    save: save,
    read: read,
    open: open,
    adopt: adopt,
    unbind: unbind
  };
})(window.PMS);