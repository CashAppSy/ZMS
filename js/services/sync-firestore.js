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
  // Only user-authored collections count as "real data": built-in statuses etc.
  // are present on every fresh device and must never be mistaken for content
  // to share (that is how a new empty browser used to wipe the shared cloud).
  var USER_COLS = ["departments", "people", "projects", "tasks"];

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
    if (window.firebase && window.firebase.firestore && window.firebase.auth) return Promise.resolve();
    var urls = [
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-app-compat.js",
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-firestore-compat.js",
      "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-auth-compat.js"
    ];
    var chain = Promise.resolve();
    urls.forEach(function (url) {
      chain = chain.then(function () {
        if (window.firebase && window.firebase.firestore && window.firebase.auth) return undefined;
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

  /* ---------------- shared cloud login (Firebase Auth) ---------------- */
  // One email + password per person works on every device. Roles live in
  // Firestore (zms_auth_users/<uid> + a zms_auth/bootstrap doc recording the
  // first admin). The app still keeps a slim local record through the
  // PMS.auth bridge so existing role gates and person linking keep working.
  function authx() {
    return loadSDK().then(function () {
      if (!window.firebase || !window.firebase.auth) return Promise.reject(new Error("missing-auth-sdk"));
      return ensureReady().then(function () {
        return window.firebase.auth(window.firebase.app(APP_NAME));
      });
    });
  }
  function bootRef() { return docRef("zms_auth/bootstrap"); }
  function cloudUserRef(uid) { return docRef("zms_auth_users/" + uid); }

  function hasCloudAdmin() {
    return loadSDK().then(function () {
      return ensureReady().then(function () {
        return bootRef().get();
      });
    }).then(function (snap) { return !!(snap && snap.exists); });
  }

  function authErrorMessage(e) {
    var code = e && e.code || "";
    switch (code) {
      case "auth/wrong-password":
      case "auth/user-not-found":
      case "auth/invalid-email":
      case "auth/invalid-login-credentials":
      case "auth/invalid-credential":
        return "invalid";
      case "auth/email-already-in-use":
        return "duplicate";
      case "auth/weak-password":
        return "weak";
      case "auth/network-request-failed":
        return "network";
      case "auth/operation-not-allowed":
        return "authNotEnabled";
      case "auth/unauthorized-domain":
        return "domainNotAllowed";
      case "auth/api-not-activated":
        return "apiNotActivated";
      default:
        return "generic";
    }
  }

  function signUpWithPassword(opts) {
    if (!opts || !opts.email || !opts.password) return Promise.reject(new Error("bad-input"));
    return authx().then(function (a) {
      return a.createUserWithEmailAndPassword(opts.email, opts.password);
    }).then(function (cred) {
      var uid = cred.user.uid;
      return bootRef().get().then(function (b) {
        var role = opts.role === "admin" || opts.role === "manager" || opts.role === "member"
          ? opts.role
          : (b.exists ? "member" : "admin");
        var rec = {
          email: opts.email, role: role,
          displayName: opts.name || "", personId: opts.personId || null, createdAt: now()
        };
        return cloudUserRef(uid).set(rec).then(function () {
          if (!b.exists) return bootRef().set({ firstUid: uid, updatedAt: now() });
          return undefined;
        }).then(function () {
          return { uid: uid, email: opts.email, role: role, displayName: opts.name || "", isAdmin: role === "admin" };
        });
      });
    }).catch(function (e) { e.userCode = authErrorMessage(e); throw e; });
  }

  function signInWithPassword(opts) {
    if (!opts || !opts.email || !opts.password) return Promise.reject(new Error("bad-input"));
    return authx().then(function (a) {
      return a.signInWithEmailAndPassword(opts.email, opts.password);
    }).then(function (cred) {
      var uid = cred.user.uid;
      return cloudUserRef(uid).get().then(function (s) {
        var d = s.exists && s.data() ? s.data() : {};
        return {
          uid: uid, email: cred.user.email || opts.email,
          role: d.role === "admin" || d.role === "manager" || d.role === "member" ? d.role : "member",
          displayName: d.displayName || "" 
        };
      });
    }).catch(function (e) { e.userCode = authErrorMessage(e); throw e; });
  }

  function signOut() {
    return authx().then(function (a) { return a.signOut(); }).catch(function () { return null; });
  }

  function resetPassword(email) {
    if (!email) return Promise.reject(new Error("bad-input"));
    return authx().then(function (a) { return a.sendPasswordResetEmail(email); }).then(function () { return true; });
  }

  // Keep role changes made in Settings mirrored to the cloud so the next
  // device sign-in sees the same role. Fire-and-forget.
  function setCloudRole(uid, role) {
    if (!uid || !role) return Promise.resolve(false);
    return ensureReady().then(function () {
      return cloudUserRef(uid).set({ role: role }, { merge: true });
    }).catch(function () { return false; });
  }

  /* ---------------- push (local -> cloud) ---------------- */
  function push() {
    if (!enabled || applying) return Promise.resolve(false);
    var d = PMS.store.data;
    // Never share/clobber an empty device dataset — refuse to push when there
    // is no real user content at all.
    if (!USER_COLS.some(function (c) { return Array.isArray(d && d[c]) && d[c].length > 0; })) return Promise.resolve(false);
    return ensureReady().then(function () {
      var t = now();
      var ops = [];
      COLLECTIONS.forEach(function (cname) {
        if (Array.isArray(d[cname])) {
          ops.push(colRef(cname).set({ items: PMS.utils.deepClone(d[cname]), updatedAt: t }));
        }
      });
      ops.push(stateRef().set({ updatedAt: t, schemaVersion: PMS.schema.VERSION, writer: PAGE_ID, hasData: true }));
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
      console.info("[cloudsync] push ok", COLLECTIONS.filter(function (c) { return Array.isArray(d && d[c]); }).reduce(function (o, c) { o[c] = (d[c] || []).length; return o; }, {}));
      return true;
    }).catch(function (e) {
      console.error("[cloudsync] push failed:", e);
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
      var localData = PMS.store.data;
      var localUpdated = localData.meta && localData.meta.updatedAt;
      var localEmpty = USER_COLS.every(function (c) { return !Array.isArray(localData[c]) || localData[c].length === 0; });
      if (mode !== "replace" && mode !== "merge") {
        // automatic pull: apply when the remote is newer, or whenever this
        // device has no real content yet (fresh browser) so it adopts the
        // shared dataset regardless of clocks. An empty local store must never
        // be treated as "ahead" of a populated cloud.
        if (!remoteUpdated) return null;
        if (!localEmpty && localUpdated && remoteUpdated <= localUpdated) return null;
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
      // Replace is destructive (whole dataset is overwritten by the remote
      // copy). Automatic / merge pulls UNION by id, so a slow device whose
      // pushes failed (e.g. editing before cloud rules were ready) keeps its
      // local additions instead of silently losing them to a newer clock.
      if (mode !== "replace") obj = mergeWithLocal(obj);
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

  // Returns true when `a` is newer than `b`. ISO-8601 timestamps compare
  // lexicographically, so a plain string comparison is correct.
  function isNewer(a, b) {
    if (!a || !b) return false;
    return String(a) > String(b);
  }

  // Merge remote into the current dataset, propagating EDITS as well as
  // additions and deletions:
  //  - a new id -> appended (addition, already worked)
  //  - same id   -> the writer with the newer per-item updatedAt wins
  //                 (this is what lets a status change made by the admin show
  //                 up on every other device)
  //  - local-only id last touched at or before the remote's latest push was
  //    deleted by that push's writer -> dropped (remote deletions reach all
  //    devices). A local item edited or created AFTER that push is kept, so
  //    offline edits are never silently discarded.
  function mergeWithLocal(remoteObj) {
    var merged = PMS.utils.deepClone(PMS.store.data);
    var remoteAt = remoteObj.meta && remoteObj.meta.updatedAt;
    COLLECTIONS.forEach(function (cname) {
      var incoming = remoteObj[cname] || [];
      var existing = merged[cname] || [];
      incoming.forEach(function (item) {
        var idx = -1;
        for (var i = 0; i < existing.length; i++) {
          if (existing[i].id === item.id) { idx = i; break; }
        }
        if (idx === -1) { existing.push(item); return; }
        if (!isNewer(existing[idx].updatedAt, item.updatedAt)) existing[idx] = item;
      });
      merged[cname] = existing.filter(function (e) {
        if (!(remoteAt && e.updatedAt && String(e.updatedAt) <= String(remoteAt))) return true;
        return incoming.some(function (r) { return r.id === e.id; });
      });
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
    var local = PMS.store.data;
    var hasLocal = USER_COLS.some(function (c) { return Array.isArray(local[c]) && local[c].length > 0; });
    return stateRef().get().then(function (s) {
      if (!s.exists) return hasLocal ? push() : false;
      var d = s.data() || {};
      // a cloud whose last push carried no real data (hasData:false) is hollow —
      // repopulate it from this device when it actually has content
      if (d.hasData === false) return hasLocal ? push() : false;
      var remote = d.updatedAt;
      if (!remote) return hasLocal ? push() : false;
      var localAt = local.meta && local.meta.updatedAt;
      if (localAt && remote < localAt) return hasLocal ? push() : false;
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
      // seed the cloud with this device's data when it is empty or older, so
      // other devices can pull a real dataset from the very first load
      return pushIfLocalIsAhead().then(function (pushed) {
        return !!(changed || pushed);
      });
    }).then(function (synced) {
      if (synced && PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.synced"), "success");
      if (synced && PMS.router && PMS.router.handle) PMS.router.handle();
      PMS.bus.emit("cloud:state", { booted: true });
      return synced;
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
    embedded: embedded,
    isConfigured: isConfigured,
    isEnabled: isEnabled,
    auth: authx,
    bootRef: bootRef,
    hasCloudAdmin: hasCloudAdmin,
    signUpWithPassword: signUpWithPassword,
    signInWithPassword: signInWithPassword,
    signOut: signOut,
    resetPassword: resetPassword,
    setCloudRole: setCloudRole,
    authErrorMessage: authErrorMessage,
    // internal helper exported for the offline test suite
    _mergeForTest: mergeWithLocal
  };
})(window.PMS);