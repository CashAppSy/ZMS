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

   SECURITY: shared data requires an ACTIVE cloud profile (see firestore.rules).
   Members are read-only on shared data; only managers/admins — or the bootstrap
   first account — may push (canWriteShared() mirrors this client-side).
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
  var functionsReady = null; // backend availability memo (null = unknown)

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

  function loadFunctionsSDK() {
    return loadSDK().then(function () {
      if (window.firebase && window.firebase.functions) return undefined;
      return injectScript("https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/firebase-functions-compat.js");
    });
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

  // The hardened rules require a SIGNED-IN Firebase user (with an active
  // profile) for every read/write. Firebase Auth restores the session
  // asynchronously after a reload, so any pull/push before that resolves
  // arrives as request.auth == null and is rejected with "Missing or
  // insufficient permissions". This waits for the auth state (with a timeout)
  // and resolves true only when a user is actually signed in — pulling/pushing
  // while signed out is skipped quietly instead of spamming rule denials.
  var signedInKnown = false;
  var signedInCache = false;
  var authStateTimer = null;
  function waitForSignedIn() {
    return authx().then(function (a) {
      if (a.currentUser) { signedInKnown = true; signedInCache = true; return true; }
      if (signedInKnown) return signedInCache; // already resolved as signed-out
      return new Promise(function (resolve) {
        var done = false;
        var finish = function (v) { if (done) return; done = true; clearTimeout(authStateTimer); authStateTimer = null; signedInKnown = true; signedInCache = v; resolve(v); };
        authStateTimer = setTimeout(function () { finish(false); }, 6000);
        var off = a.onAuthStateChanged(function (u) { if (u) { try { off(); } catch (e) {} finish(true); } });
      });
    }).catch(function () { signedInKnown = true; signedInCache = false; return false; });
  }

  function hasCloudAdmin() {
    return loadSDK().then(function () {
      return ensureReady().then(function () {
        return bootRef().get();
      });
    }).then(function (snap) { return !!(snap && snap.exists); });
  }

  // The account recorded in zms_auth/bootstrap.firstUid may still WRITE shared
  // data even when its stored role predates the elevated roles (migration
  // guard). Read once and cache it so push() does not re-read per keystroke.
  var cachedBootstrapOwner = null;
  var bootstrapOwnerLoaded = false;
  function bootstrapOwnerUid() {
    if (bootstrapOwnerLoaded) return Promise.resolve(cachedBootstrapOwner);
    return ensureReady().then(function () {
      return bootRef().get();
    }).then(function (snap) {
      cachedBootstrapOwner = (snap && snap.exists && snap.data().firstUid) || null;
      bootstrapOwnerLoaded = true;
      return cachedBootstrapOwner;
    }).catch(function () { bootstrapOwnerLoaded = true; return null; });
  }

  // True when THIS signed-in cloud user may push shared datasets. Mirrors the
  // Firestore rules (ZMS-RT-01/06): only admin/manager — or the bootstrap
  // owner (firstUid migration) — may write; plain members are read-only on
  // shared data, so their devices must not attempt whole-dataset writes.
  function canWriteShared() {
    var u = (PMS.auth && PMS.auth.currentUser) ? PMS.auth.currentUser() : null;
    if (!u || !u.cloudUid) return Promise.resolve(false);
    if (u.role === "admin" || u.role === "manager") return Promise.resolve(true);
    if (u.role !== "member") return Promise.resolve(false);
    return bootstrapOwnerUid().then(function (first) { return !!first && u.cloudUid === first; });
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

  // Decides which role may be written for a NEW cloud account.
  //  - while the bootstrap admin record does not exist yet, the very first
  //    account becomes the ADMIN (the client cannot choose this; the resolver
  //    decides strictly from server-visible state),
  //  - once the bootstrap exists every further signup is ALWAYS "member" —
  //    no client input, not even an admin caller, may mint an elevated role
  //    for a later account (promotion is an admin update / adminSetRole).
  // This mirrors what the Firestore rules enforce.
  function resolveSignupRole(role, bootstrapExists) {
    if (!bootstrapExists) return "admin";
    return "member";
  }

  // ZMS-R06: signup no longer accepts a role from the client at all. Whatever
  // the caller submits is ignored; the role comes only from the resolver above
  // (bootstrap admin for the very first account, member otherwise).
  function signUpWithPassword(opts) {
    if (!opts || !opts.email || !opts.password) return Promise.reject(new Error("bad-input"));
    return authx().then(function (a) {
      return a.createUserWithEmailAndPassword(opts.email, opts.password);
    }).then(function (cred) {
      var uid = cred.user.uid;
      return bootRef().get().then(function (b) {
        var role = resolveSignupRole("member", b.exists);
        if (role === "admin") cachedBootstrapOwner = uid;
        var rec = {
          email: opts.email, role: role,
          displayName: opts.name || "", personId: opts.personId || null, createdAt: now()
        };
        return cloudUserRef(uid).set(rec).then(function () {
          if (!b.exists) return bootRef().set({ firstUid: uid, updatedAt: now() });
          return undefined;
        }).then(function () {
          if (PMS.cloudBridge && PMS.cloudBridge.markVerified) PMS.cloudBridge.markVerified(uid);
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
      if (PMS.cloudBridge && PMS.cloudBridge.markVerified) PMS.cloudBridge.markVerified(uid);
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
  // device sign-in sees the same role.
  // SECURITY (ZMS-R07): authorized role changes run through the trusted
  // backend FIRST — the HTTPS callable "adminSetRole" (see functions/) checks
  // the caller's uid against zms_auth_users and only then writes the role.
  // The direct Firestore write is kept ONLY as a fallback for deployments
  // without the Cloud Functions (self-hosted/dev): it stays admin-gated in the
  // client and is additionally blocked for non-admins by the Firestore rules.
  function setRoleViaBackend(uid, role) {
    if (functionsReady === false) return Promise.resolve(false);
    return loadFunctionsSDK().then(function () {
      if (!window.firebase || !window.firebase.functions) { functionsReady = false; return false; }
      var fn = window.firebase.functions(window.firebase.app(APP_NAME)).httpsCallable("adminSetRole");
      return fn({ uid: uid, role: role }).then(function () { functionsReady = true; return true; }, function () { functionsReady = false; return false; });
    }, function () { functionsReady = false; return false; });
  }

  function setCloudRole(uid, role) {
    if (!uid || ["admin", "manager", "member"].indexOf(role) === -1) return Promise.resolve(false);
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.resolve(false);
    return setRoleViaBackend(uid, role).then(function (done) {
      if (done) return true;
      // fallback: no deployed function — direct write (rules are the real gate)
      return ensureReady().then(function () {
        return cloudUserRef(uid).set({ role: role }, { merge: true });
      }).then(function () { return true; }).catch(function () { return false; });
    });
  }

  // ZMS-R05: removing a shared cloud account must NOT be a client-side write.
  // It is done by the trusted backend callable "adminDeleteUser" (it verifies
  // the caller is an admin from Firestore, then deletes the account record).
  // Without deployed functions the operation is refused — there is no direct
  // browser fallback for deletions.
  function deleteCloudAccount(uid) {
    if (!uid) return Promise.reject(new Error("bad-input"));
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.reject({ userCode: "forbidden" });
    if (functionsReady === false) return Promise.reject({ userCode: "backendRequired" });
    return loadFunctionsSDK().then(function () {
      if (!window.firebase || !window.firebase.functions) throw { userCode: "backendRequired" };
      return window.firebase.functions(window.firebase.app(APP_NAME)).httpsCallable("adminDeleteUser")({ uid: uid });
    }).then(function () { functionsReady = true; return true; });
  }

  /* ---------------- push (local -> cloud) ---------------- */
  function push() {
    if (!enabled || applying) return Promise.resolve(false);
    var d = PMS.store.data;
    // Never share/clobber an empty device dataset — refuse to push when there
    // is no real user content at all.
    if (!USER_COLS.some(function (c) { return Array.isArray(d && d[c]) && d[c].length > 0; })) return Promise.resolve(false);
    // ZMS-RT-01/06: members are read-only on the shared datasets at the server;
    // do not even attempt whole-dataset writes from a member's device.
    return waitForSignedIn().then(function (ok) {
      if (!ok) return false;
      return canWriteShared().then(function (allowed) {
        if (!allowed) return false;
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
      });
    });
  }

  /* ---------------- pull (cloud -> local) ---------------- */
  // mode: undefined (only when remote is newer) | "replace" | "merge"
  function pull(mode) {
    if (!enabled) return Promise.resolve(false);
    return waitForSignedIn().then(function (ok) {
      if (!ok) return false;
      return ensureReady();
    }).then(function () {
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
    if (!hasLocal) return Promise.resolve(false);
    return waitForSignedIn().then(function (ok) {
      if (!ok) return false;
      return canWriteShared().then(function (can) {
        if (!can) return false;
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
    });
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
        return waitForSignedIn().then(function (ok) {
          if (!ok) return null; // signed out: skip the connectivity probe
          return probeRef().get(); // connectivity check (doc may not exist)
        });
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
      // wait for the (possibly still-restoring) Firebase Auth session; when
      // nobody is signed in yet the pull is skipped quietly instead of being
      // rejected by the rules as "Missing or insufficient permissions".
      return waitForSignedIn().then(function (ok) {
        if (!ok) return false;
        return pull();
      });
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
      // Diagnostics for the "Missing or insufficient permissions" case: report
      // the signed-in Firebase uid so we can verify it matches a profile doc
      // in zms_auth_users (the round-3 rules deny every read when it does not).
      // Captured BEFORE teardown() which deletes the Firebase app.
      var diagUid = null, diagEmail = null;
      try {
        if (window.firebase && window.firebase.apps) {
          var app = window.firebase.apps.find(function (a) { return a.name === APP_NAME; });
          if (app) {
            var cu = window.firebase.auth(app).currentUser;
            diagUid = cu && cu.uid; diagEmail = cu && cu.email;
          }
        }
      } catch (diagErr) { console.warn("[cloudsync] boot diagnostics unavailable", diagErr); }
      // Decisive probe: try reading the user's OWN profile doc (allowed for the
      // owner under round-3 regardless of role) and the sync state doc (needs
      // isActiveUser). Comparing the two tells us whether the live rules are
      // round-3-but-profile-missing vs. still-deny-everything.
      if (diagUid) {
        ensureReady().then(function () {
          return cloudUserRef(diagUid).get();
        }).then(function (s) {
          console.warn("[cloudsync] probe OWN zms_auth_users ->", s.exists ? "DOC FOUND" : "DOC MISSING", s.exists ? s.data() : "(read allowed, but doc does not exist)");
          return stateRef().get();
        }).then(function () {
          console.warn("[cloudsync] probe zms_meta/state -> allowed");
        }).catch(function (pe) {
          console.warn("[cloudsync] probe DENIED:", pe && pe.message ? pe.message : String(pe));
        }).then(function () {
          // granular matrix: which rule-paths deny? bootstrap uses a trivial
          // rule (request.auth != null); probe + meta use isActiveUser; the
          // datasets use isTeamMember && isActiveUser. This separates a broken
          // isActiveUser/exists() from a broken signupCanRead.
          var probes = [
            ["zms_auth/bootstrap (signupCanRead)", bootRef],
            ["zms_meta/probe (isActiveUser)", probeRef],
            ["zms_meta/state (isActiveUser)", stateRef],
            ["zms_tasks/data (isTeamMember && isActiveUser)", function () { return colRef("tasks"); }]
          ];
          ensureReady().then(function () {
            return probes.reduce(function (chain, p) {
              return chain.then(function () {
                return p[1]().get();
              }).then(function () {
                console.warn("[cloudsync] probe", p[0], "-> allowed");
              }).catch(function (pe) {
                console.warn("[cloudsync] probe", p[0], "-> DENIED:", pe && pe.message ? pe.message : String(pe));
              });
            }, Promise.resolve());
          }).then(function () {
            enabled = false;
            teardown();
            if (PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.bootFailed"), "error");
            console.error("[cloudsync] boot failed", e);
            return false;
          });
        });
        return; // handled async above
      }
      enabled = false;
      teardown();
      if (PMS.toast) PMS.toast.show(PMS.i18n.t("cloud.bootFailed"), "error");
      console.error("[cloudsync] boot failed", e);
      console.warn("[cloudsync] boot diagnostics uid=", diagUid, "email=", diagEmail);
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
    hasCloudAdmin: hasCloudAdmin,
    canWriteShared: canWriteShared,
    signUpWithPassword: signUpWithPassword,
    signInWithPassword: signInWithPassword,
    signOut: signOut,
    resetPassword: resetPassword,
    setCloudRole: setCloudRole,
    deleteCloudAccount: deleteCloudAccount,
    authErrorMessage: authErrorMessage
  };
  // ZMS-RT-03: test-only helpers are reachable only under the test harness
  // (window.__ZMS_TEST__ is set by tests/, never by a real browser) so
  // window.PMS.cloudsync carries no internal bridge/test surface in the app.
  if (typeof window !== "undefined" && window.__ZMS_TEST__) {
    PMS.cloudsync._mergeForTest = mergeWithLocal;
    PMS.cloudsync._resolveSignupRoleForTest = resolveSignupRole;
  }
})(window.PMS);