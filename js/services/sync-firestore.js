/* ==========================================================================
   PMS.cloudsync - automatic cloud synchronization via Firebase Firestore.

   Keeps the whole dataset shared across every device that enables the same
   Firebase project, so the team works on one copy with no export/import.

   - Data lives in one Firestore doc per collection (avoids the 1MiB
     single-doc limit) plus a "state" doc used as a last-writer-wins clock.
   - Accounts (users[]) and device preferences (settings) are NOT synced:
     each browser keeps its own local accounts, matching the local-access
     design. Only project data (departments, people, projects, tasks,
     statuses, priorities, custom field defs, saved filters) is shared.
   - The Firebase SDK is loaded dynamically from the Google CDN only when
     the feature is enabled, so the app keeps working fully offline and the
     test harness never touches the network.
   - Connection settings come from PMS.cloudConfig (js/cloud-config.js,
     committed with the site). That makes sync automatic: every device that
     opens the deployed site connects to the same cloud with no per-device
     setup. A per-device localStorage override is optional for power users.

   NOTICE: Firestore rules must allow public read/write (or the equivalent)
   for this to work with the local-accounts model. That is UI-level sharing,
   not server security — anyone who finds the project can read the data.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var CONFIG_KEY = "pms-cloud-config";
  var APP_NAME = "pms-cloud";
  var SDK_VERSION = "10.12.2";
  var INTERVAL = 15000;       // poll interval for remote changes
  var COOLDOWN = 3000;        // min gap between pulls
  var PUSH_DEBOUNCE = 500;    // debounce between a local edit and its upload

  var COLLECTIONS = ["departments", "people", "projects", "tasks",
    "taskStatuses", "projectStatuses", "priorities", "customFieldDefs", "savedFilters"];

  var PAGE_ID = null;

  var firestore = null;
  var enabled = false;
  var applying = false;   // true while we apply a pulled dataset (no echo push)
  var debounce = null;
  var timer = null;
  var lastPulled = 0;
  var lastPushed = 0;

  var unsubChanged = null;
  var unsubSaved = null;
  var onFocus = null;
  var onVisibility = null;

  function now() { return new Date().toISOString(); }

  function config() {
    // Per-device override (saved from the Settings UI) wins when present,
    // otherwise fall back to the embedded build config so that a deployed
    // site connects automatically on every device with zero setup.
    var local = null;
    try { local = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || "null"); }
    catch (e) { local = null; }
    if (local && local.projectId) return local;
    var emb = window.PMS.cloudConfig || {};
    if (emb.projectId) return emb;
    return local;
  }

  function embedded() { return window.PMS.cloudConfig || {}; }

  function saveConfig(c) {
    try { window.localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function clearConfig() {
    try { window.localStorage.removeItem(CONFIG_KEY); } catch (e) {}
  }

  function status() {
    var c = config();
    return {
      enabled: enabled,
      projectId: c ? c.projectId : null,
      config: c,
      realtime: enabled,
      lastSyncAt: lastPushed && lastPulled ? (lastPushed > lastPulled ? lastPushed : lastPulled) : (lastPushed || lastPulled || null)
    };
  }

  function isConfigured() { return !!config(); }
  function isEnabled() { return enabled; }

  /* ---------------- Firebase SDK loader (dynamic) ---------------- */
  function injectScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error("cdn:" + url.split("/").pop())); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function loadSDK() {
    if (window.firebase && window.firebase.firestore) return Promise.resolve();
    var urls = [
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-firestore-compat.js"
    ];
    var chain = Promise.resolve();
    urls.forEach(function (url) {
      chain = chain.then(function () {
        if (window.firebase && window.firebase.firestore) return undefined;
        return injectScript(url);
      });
    });
    return chain;
  }

  function ensureReady() {
    if (firestore) return Promise.resolve(firestore);
    var c = config();
    if (!window.firebase || !window.firebase.firestore) return Promise.reject(new Error("missing-config"));
    var existing = window.firebase.apps && window.firebase.apps.find(function (a) { return a.name === APP_NAME; });
    if (existing) { try { existing.delete(); } catch (e) {} }
    var app = window.firebase.initializeApp(c, APP_NAME);
    firestore = window.firebase.firestore(app);
    return Promise.resolve(firestore);
  }

  function docRef(path) {
    return firestore.doc(path);
  }
  function colRef(name) { return docRef("zms_" + name + "/data"); }
  function stateRef() { return docRef("zms_meta/state"); }
  function probeRef() { return docRef("zms_meta/probe"); }

  /* ---------------- push (local -> cloud) ---------------- */
  function push() {
    if (!enabled || applying) return Promise.resolve(false);
    return ensureReady().then(function () {
      var d = PMS.store.data;
      if (!d) return false;
      var t = now();
      var ops = [];
      COLLECTIONS.forEach(function (cname) {
        if (Array.isArray(d[cname])) {
          ops.push(colRef(cname).set({ items: PMS.utils.deepClone(d[cname]), updatedAt: t }));
        }
      });
      ops.push(stateRef().set({ updatedAt: t, schemaVersion: PMS.schema.VERSION, writer: PAGE_ID }));
      return Promise.all(ops);
    }).then(function () {
      // align the in-memory clock with what we uploaded (and persist it) so
      // the next poll/reboot does not re-import our own data back onto this
      // device. flush() does not emit "store:changed", so this cannot loop.
      var d = PMS.store.data;
      if (d && d.meta) {
        d.meta.updatedAt = new Date().toISOString();
        PMS.store.flush();
      }
      lastPushed = Date.now();
      PMS.bus.emit("cloud:state", { pushed: true });
      return true;
    }).catch(function (e) {
      PMS.bus.emit("cloud:state", { error: e && e.message ? e.message : String(e) });
      return false;
    });
  }

  /* ---------------- pull (cloud -> local) ---------------- */
  // mode: undefined (only when remote is newer) | "replace" | "merge"
  function pull(mode) {
    if (!enabled) return Promise.resolve(false);
    return ensureReady().then(function () {
      return stateRef().get();
    }).then(function (snap) {
      if (!snap.exists) return null;
      var remoteUpdated = snap.data().updatedAt;
      var localUpdated = PMS.store.data.meta && PMS.store.data.meta.updatedAt;
      if (mode !== "replace" && mode !== "merge") {
        if (!remoteUpdated || (localUpdated && remoteUpdated <= localUpdated)) return null;
      }
      return Promise.all(COLLECTIONS.map(function (cname) {
        return colRef(cname).get();
      })).then(function (snaps) {
        var obj = {
          schemaVersion: PMS.schema.VERSION,
          departments: [], people: [], projects: [], tasks: [],
          taskStatuses: [], projectStatuses: [], priorities: [],
          customFieldDefs: [], savedFilters: [],
          meta: { updatedAt: remoteUpdated }
        };
        snaps.forEach(function (s, i) {
          if (s.exists && s.data() && Array.isArray(s.data().items)) obj[COLLECTIONS[i]] = s.data().items;
        });
        return obj;
      });
    }).then(function (obj) {
      if (!obj) return false;
      if (mode === "merge") obj = mergeWithLocal(obj);
      // accounts + per-device preferences never come from the cloud
      obj.users = PMS.utils.deepClone((PMS.store.data && PMS.store.data.users) || []);
      obj.settings = PMS.utils.deepClone((PMS.store.data && PMS.store.data.settings) || PMS.schema.defaultData().settings);
      applying = true;
      PMS.store.setData(obj);
      applying = false;
      lastPulled = Date.now();
      PMS.bus.emit("cloud:state", { pulled: true });
      return true;
    }).catch(function (e) {
      PMS.bus.emit("cloud:state", { error: e && e.message ? e.message : String(e) });
      return false;
    });
  }

  // Union remote items into the current local dataset by id (no duplicates).
  function mergeWithLocal(remoteObj) {
    var merged = PMS.utils.deepClone(PMS.store.data);
    COLLECTIONS.forEach(function (cname) {
      var incoming = remoteObj[cname] || [];
      var existing = merged[cname] || [];
      incoming.forEach(function (item) {
        var dup = existing.some(function (e) { return e.id === item.id; });
        if (!dup) existing.push(item);
      });
      merged[cname] = existing;
    });
    merged.meta = { updatedAt: remoteObj.meta.updatedAt };
    return merged;
  }

  /* ---------------- wiring ---------------- */
  function teardown() {
    if (timer) { clearInterval(timer); timer = null; }
    if (unsubChanged) { unsubChanged(); unsubChanged = null; }
    if (unsubSaved) { unsubSaved(); unsubSaved = null; }
    if (onFocus) { window.removeEventListener("focus", onFocus); onFocus = null; }
    if (onVisibility) { document.removeEventListener("visibilitychange", onVisibility); onVisibility = null; }
    clearTimeout(debounce);
    if (window.firebase && window.firebase.apps) {
      var app = window.firebase.apps.find(function (a) { return a.name === APP_NAME; });
      if (app) { try { app.delete(); } catch (e) {} }
    }
    firestore = null;
  }
  function onChange() {
    if (applying || !enabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(function () { push(); }, PUSH_DEBOUNCE);
  }

  function tick() {
    if (!enabled || applying) return;
    if (!PMS.store.initialized) return;
    var t = Date.now();
    if (t - lastPulled < COOLDOWN) return;
    lastPulled = t;
    pull().then(function (changed) {
      if (!changed) return;
      if (PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.synced"), "success");
      if (PMS.router && PMS.router.handle) PMS.router.handle();
    }).catch(function () {});
  }

  function startPoller() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, INTERVAL);
    onFocus = tick;
    onVisibility = function () { if (!document.hidden) tick(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    unsubSaved = PMS.bus.on("save:done", function () { setTimeout(tick, 1500); });
  }

  function attachAutosave() {
    unsubChanged = PMS.bus.on("store:changed", onChange);
  }

  // Push local data only when the cloud is empty or strictly older — so
  // enabling on a fresh device seeds the cloud, but never clobbers newer
  // changes another device already uploaded.
  function pushIfLocalIsAhead() {
    return stateRef().get().then(function (s) {
      if (!s.exists) return push();
      var remote = s.data().updatedAt;
      var local = PMS.store.data.meta && PMS.store.data.meta.updatedAt;
      if (!remote || !local || remote < local) return push();
      return false;
    });
  }

  /* ---------------- API ---------------- */
  function enable(cfg) {
    if (cfg && cfg.projectId) saveConfig(cfg);
    var c = config();
    if (!c || !c.projectId) return Promise.reject(new Error("bad-config"));
    if (PAGE_ID === null) PAGE_ID = PMS.ids.uuid();
    return loadSDK().then(function () {
      return ensureReady().then(function () {
        return probeRef().get(); // connectivity check (doc may not exist)
      });
    }).then(function () {
      enabled = true;
      attachAutosave();
      startPoller();
      // pull the shared state immediately, then seed it with local data when
      // the cloud is empty or older than this device
      return pull().then(function () {
        return pushIfLocalIsAhead();
      });
    }).then(function () {
      PMS.bus.emit("cloud:state", { enabled: true, connected: true });
      return true;
    }).catch(function (e) {
      enabled = false;
      teardown();
      PMS.bus.emit("cloud:state", { error: e && e.message ? e.message : String(e) });
      return Promise.reject(e);
    });
  }

  function disable() {
    enabled = false;
    teardown();
    PMS.bus.emit("cloud:state", { disabled: true, enabled: false });
    return Promise.resolve();
  }

  // Called after login on every load: resurrects the saved connection and
  // pulls any newer remote data without blocking the UI.
  function boot() {
    if (!isConfigured()) return Promise.resolve(false);
    if (PAGE_ID === null) PAGE_ID = PMS.ids.uuid();
    return loadSDK().then(function () {
      return ensureReady();
    }).then(function () {
      enabled = true;
      attachAutosave();
      startPoller();
      return pull();
    }).then(function (changed) {
      if (changed && PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.synced"), "success");
      if (changed && PMS.router && PMS.router.handle) PMS.router.handle();
      PMS.bus.emit("cloud:state", { booted: true });
      return changed;
    }).catch(function (e) {
      enabled = false;
      teardown();
      if (PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.bootFailed"), "error");
      console.error("[cloudsync] boot failed", e);
      return false;
    });
  }

  PMS.cloudsync = {
    enable: enable,
    disable: disable,
    boot: boot,
    push: push,
    pull: pull,
    status: status,
    config: config,
    saveConfig: saveConfig,
    clearConfig: clearConfig,
    isConfigured: isConfigured,
    isEnabled: isEnabled
  };
})(window.PMS);