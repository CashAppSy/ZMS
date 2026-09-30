/* ==========================================================================
   PMS.cloudsync - automatic cloud synchronization via Firebase Firestore.

   Keeps the whole dataset shared across every device that enables the same
   Firebase project, so the team works on one copy with no export/import.

   DATA MODEL (ZMS-RT-05/06, round-4 per-record layout):
   - departments, people, taskStatuses, projectStatuses, priorities,
     customFieldDefs, savedFilters still live as ONE whole-dataset doc per
     collection (zms_<name>/data) because they are small, shared-by-everyone
     reference data that changes rarely (the 1MiB single-doc limit applies).
   - projects and tasks live PER RECORD (zms_projects/<id>, zms_tasks/<id>)
     so authorization can be checked per document at the server:
       * the project's manager (project.managerId == the caller's personId)
         may create/update that project and ANY task inside it;
       * the assignees of a task (the caller's personId inside assignees) may
         change only the STATUS of that task (status/progress/activity/
         updatedAt — the exact fields the status UI writes);
       * everything else on projects/tasks stays admin-only, and deleting a
         project/task record is ALWAYS admin-only.
   - The global ACTIVITY LOG (round 6) is a per-record append-only collection
     (zms_activities/<id>): any ACTIVE user may create an entry (recording
     their own action), everyone reads it, only admins delete (e.g. clearing
     the log). The push uploads entries the local mirror has not seen yet and
     never re-writes existing ones.
   - A "state" doc (zms_meta/state) is a last-writer-wins clock. Members'
     status changes may bump ONLY the clock (updatedAt) so other devices
     notice; they cannot touch schemaVersion/hasData/writer.
   - Round-3 clouds (zms_projects/data, zms_tasks/data whole-documents) are
     still read: the pull re-expands their items into per-record rows, and an
     admin's next push deletes the legacy wrapper once it is fully mirrored.

   - Accounts (users[]) and device preferences (settings) are NOT synced:
     each browser keeps its own local accounts, matching the local-access
     design. Only project data is shared.
   - The Firebase SDK is loaded dynamically from the Google CDN only when
     the feature is enabled, so the app keeps working fully offline and the
     test harness never touches the network.
   - Connection settings come from PMS.cloudConfig (js/cloud-config.js,
     committed with the site). That makes sync automatic: every device that
     opens the deployed site connects to the same cloud with no per-device
     setup. A per-device localStorage override is optional for power users.

   SECURITY: shared data requires an ACTIVE cloud profile (see firestore.rules).
   Members may change ONLY the status of tasks assigned to them (pushed as a
   targeted status-only update); managers/admins — or the bootstrap first
   account — may push the reference datasets and full per-record documents.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var CONFIG_KEY = "pms-cloud-config";
  var MIRROR_KEY = "pms-cloud-mirror";
  var APP_NAME = "pms-cloud";
  var SDK_VERSION = "10.12.2";
  var INTERVAL = 15000;       // poll interval for remote changes
  var COOLDOWN = 3000;        // min gap between pulls
  var PUSH_DEBOUNCE = 500;    // debounce between a local edit and its upload
  // How long the cloud must be quiet before the NEXT edit is treated as a
  // single deliberate action and uploaded immediately instead of debounced.
  var PUSH_SETTLE = 1500;

  // Reference datasets: one whole-document per collection (round-3 layout).
  var WHOLE_COLS = ["departments", "people", "taskStatuses", "projectStatuses",
    "priorities", "customFieldDefs", "savedFilters"];
  // Per-record collections (round-4 layout): one document PER project/task.
  var RECORD_COLS = ["projects", "tasks"];
  // Append-only per-record collections (round-6 layout): the global activity
  // log. Entries are only ever created (any active user) and deleted (admin,
  // e.g. clearing the log) — a push uploads new local entries the mirror has
  // not seen yet and never re-writes an existing entry.
  var APPEND_COLS = ["activities"];
  var COLLECTIONS = WHOLE_COLS.concat(RECORD_COLS).concat(APPEND_COLS);
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
  var lastPushAt = 0;   // when the last push STARTED, for the settle check

  var unsubChanged = null;
  var unsubSaved = null;
  var onFocus = null;
  var onVisibility = null;
  var onBeforeUnload = null;
  var onPageHide = null;
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
  // standard whole-dataset document: zms_<name>/data
  function colRef(name) { return docRef("zms_" + name + "/data"); }
  // per-record collection / document
  function recordCol(name) { return firestore.collection("zms_" + name); }
  function recordRef(name, id) { return firestore.collection("zms_" + name).doc(id); }
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

  // True when THIS signed-in cloud user may push the shared datasets.
  // Mirrors the Firestore rules (ZMS-RT-01/06): only a manager OR admin — or
  // the bootstrap owner (firstUid migration) — may write the whole-dataset
  // reference collections; plain members can only ever touch the STATUS of
  // tasks assigned to them (handled separately in buildRecordOps).
  function canWriteShared() {
    var u = (PMS.auth && PMS.auth.currentUser) ? PMS.auth.currentUser() : null;
    if (!u || !u.cloudUid) return Promise.resolve(false);
    if (u.role === "admin" || u.role === "manager") return Promise.resolve(true);
    if (u.role !== "member") return Promise.resolve(false);
    return bootstrapOwnerUid().then(function (first) { return !!first && u.cloudUid === first; });
  }

  // Identity + personId of the current local user (mirror of the cloud
  // profile; personId is propagated by Settings -> Accounts).
  function identity() {
    var u = (PMS.auth && PMS.auth.currentUser) ? PMS.auth.currentUser() : null;
    return {
      user: u,
      cloudUid: u ? (u.cloudUid || null) : null,
      role: u ? (u.role || "member") : "member",
      personId: u ? (u.personId || null) : null,
      isAdmin: !!(u && u.role === "admin")
    };
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
          displayName: d.displayName || "",
          personId: d.personId || null,
          active: d.active !== false
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

  // Mirror a linked PERSON (personId) to the cloud profile. The per-record
  // authorization model (managerId/assignees comparison) requires the cloud
  // profile to know which person the account is, so this must be written to
  // zms_auth_users/<uid> whenever Settings links/unlinks a person. Rules keep
  // it admin-only for other users, or the user's own profile (role unchanged).
  function setCloudPersonId(uid, personId) {
    if (!uid) return Promise.resolve(false);
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.resolve(false);
    return ensureReady().then(function () {
      return cloudUserRef(uid).set({ personId: personId || null }, { merge: true });
    }).then(function () { return true; }).catch(function () { return false; });
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

  // Create a cloud MEMBER account for a person via the trusted admin callable
  // "adminCreateUser" (it verifies the caller is an admin from Firestore, then
  // creates the Firebase Authentication identity with a random temporary
  // password). Doing this server-side means the admin's browser is never
  // signed in as the new user (client-side createUserWithEmailAndPassword
  // would hijack the session). The caller still sends the password-reset
  // email invite through PMS.cloudsync.resetPassword. Resolves
  // { uid } on success, rejects { userCode } otherwise.
  function createMemberAccount(opts) {
    var email = opts && opts.email ? String(opts.email).trim().toLowerCase() : "";
    if (!email) return Promise.reject({ userCode: "invalid" });
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.reject({ userCode: "forbidden" });
    if (functionsReady === false) return Promise.reject({ userCode: "backendRequired" });
    return loadFunctionsSDK().then(function () {
      if (!window.firebase || !window.firebase.functions) throw { userCode: "backendRequired" };
      return window.firebase.functions(window.firebase.app(APP_NAME)).httpsCallable("adminCreateUser")({
        email: email,
        name: opts.name || email,
        personId: opts.personId || null,
        active: opts.active !== false
      });
    }).then(function (res) {
      functionsReady = true;
      var uid = res && res.data && res.data.uid;
      if (uid && PMS.cloudBridge && PMS.cloudBridge.register) {
        PMS.cloudBridge.register({
          username: email,
          cloudUid: uid,
          role: "member",
          name: opts.name || email,
          personId: opts.personId || null,
          active: opts.active !== false
        });
      }
      return { uid: uid };
    });
  }

  // Enable/disable a cloud account (mirrors the person's active status) via
  // the trusted admin callable "adminSetActive". Resolves true on success,
  // rejects { userCode } otherwise. No direct-browser fallback — exactly like
  // deleteCloudAccount/setCloudEmail.
  function setCloudActive(uid, active) {
    if (!uid) return Promise.reject({ userCode: "invalid" });
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.reject({ userCode: "forbidden" });
    if (functionsReady === false) return Promise.reject({ userCode: "backendRequired" });
    return loadFunctionsSDK().then(function () {
      if (!window.firebase || !window.firebase.functions) throw { userCode: "backendRequired" };
      return window.firebase.functions(window.firebase.app(APP_NAME)).httpsCallable("adminSetActive")({ uid: uid, active: active !== false });
    }).then(function () { functionsReady = true; return true; });
  }
  // Change a cloud account's SIGN-IN email (Firebase Authentication). The
  // web SDK can never rewrite another account's email (even Firestore writes
  // only touch the profile doc), so this runs through the trusted admin
  // callable "adminUpdateEmail" — there is deliberately NO direct-browser
  // fallback, exactly like deleteCloudAccount. Resolves true on success,
  // rejects { userCode } otherwise.
  function setCloudEmail(uid, email) {
    if (!uid || !email) return Promise.reject({ userCode: "invalid" });
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return Promise.reject({ userCode: "forbidden" });
    if (functionsReady === false) return Promise.reject({ userCode: "backendRequired" });
    var clean = String(email).trim().toLowerCase();
    return loadFunctionsSDK().then(function () {
      if (!window.firebase || !window.firebase.functions) throw { userCode: "backendRequired" };
      return window.firebase.functions(window.firebase.app(APP_NAME)).httpsCallable("adminUpdateEmail")({ uid: uid, email: clean });
    }).then(function () { functionsReady = true; return true; });
  }

  /* ---------------- per-record change tracking (local mirror) ---------------- */
  // The per-record model writes individual documents, so we must know what we
  // LAST wrote (or last pulled) per record to avoid re-uploading unchanged data
  // and to detect local edits vs. deletions. The mirror is persisted per
  // device in localStorage and refreshed from every successful push/pull.
  // A record is considered CHANGED when its updatedAt differs from the mirror
  // (repositories.update() bumps updatedAt on every edit). For assignee
  // status-only updates we additionally compare status/progress/activity.

  function loadMirror() {
    try { return JSON.parse(window.localStorage.getItem(MIRROR_KEY) || "null") || {}; }
    catch (e) { return {}; }
  }
  function saveMirror(m) {
    try { window.localStorage.setItem(MIRROR_KEY, JSON.stringify(m)); } catch (e) {}
  }
  function mirrorFor(col) { return loadMirror()[col] || {}; }
  function setMirrorFor(col, map) {
    var m = loadMirror();
    m[col] = map || {};
    saveMirror(m);
  }

  // A whole-dataset replacement (load demo data, restore a backup, replace
  // import, erase all data) swaps the store wholesale without going through
  // repositories.update(), so the mirror still describes the PREVIOUS dataset.
  // Left alone, the next push would read the mirror as "these records used to
  // be there" and delete them from the cloud. Forget the mirror first, then
  // upload the new dataset.
  function dataReplaced() {
    clearTimeout(debounce);
    debounce = null;
    try { window.localStorage.removeItem(MIRROR_KEY); } catch (e) {}
    lastPulled = 0;
    lastPushAt = 0;
    if (!enabled || applying) return Promise.resolve(false);
    return push();
  }

  // Per-record models (create/update per document) cover both the mutable
  // projects/tasks and the append-only activities collection.
  function isRecordCol(cname) {
    return RECORD_COLS.indexOf(cname) !== -1 || APPEND_COLS.indexOf(cname) !== -1;
  }

  function statusTrack(rec) {
    return {
      updatedAt: rec.updatedAt || null,
      status: rec.status === undefined ? null : rec.status,
      progress: rec.progress === undefined ? null : rec.progress,
      activity: rec.activity === undefined ? null : PMS.utils.deepClone(rec.activity)
    };
  }

  function statusEquals(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.updatedAt === b.updatedAt &&
      a.status === b.status &&
      a.progress === b.progress &&
      JSON.stringify(a.activity || null) === JSON.stringify(b.activity || null);
  }

  // Serialized equality for a single status field (activity is an array).
  function statusFieldEquals(key, localRec, snap) {
    if (key === "activity") {
      return JSON.stringify(localRec[key] || null) === JSON.stringify(snap[key] || null);
    }
    return (localRec[key] === undefined ? null : localRec[key]) === snap[key];
  }

  // The managerId of the project a task belongs to (personId match drives the
  // task authorization model).
  function projectManagerOf(d, projectId) {
    if (!projectId) return null;
    var list = Array.isArray(d && d.projects) ? d.projects : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === projectId) return list[i].managerId || null;
    }
    return null;
  }

  // Builds every operation needed to push ONE record collection (projects or
  // tasks) from local state to the cloud, honoring the per-record rules:
  //  - admin: full set() for every changed record, delete for locally-deleted
  //  - project manager (by personId): full set() for records of their projects
  //  - task assignee (by personId): targeted update() with ONLY the status
  //    fields, never create/delete
  // Returns { ops, mirror } where mirror maps record id -> new mirror entry
  // (or null to drop it) so the mirror is only persisted after the write set
  // succeeded.
  function buildRecordOps(cname, d, idn, t) {
    var ops = [];
    var mirrorUpdates = {};
    var mirror = mirrorFor(cname);
    var local = Array.isArray(d && d[cname]) ? d[cname] : [];
    var have = {};
    local.forEach(function (rec) { if (rec && rec.id) have[rec.id] = true; });

    // deletions: admin only (rules forbid anyone else)
    Object.keys(mirror).forEach(function (id) {
      if (have[id]) return;
      if (!idn.isAdmin) return;
      ops.push(recordRef(cname, id).delete());
      mirrorUpdates[id] = null;
    });

    local.forEach(function (rec) {
      if (!rec || !rec.id) return;
      var allow = false;
      var statusOnly = false;
      if (cname === "projects") {
        // admin pushes any project; otherwise only the project whose managerId
        // matches the caller's personId
        allow = idn.isAdmin || (idn.personId && rec.managerId && rec.managerId === idn.personId);
      } else {
        // tasks: admin = all; manager-of-project = full; assignee = status only
        if (idn.isAdmin) allow = true;
        else if (!allow && idn.personId && projectManagerOf(d, rec.projectId) === idn.personId) allow = true;
        else if (!allow && idn.personId && Array.isArray(rec.assignees) && rec.assignees.indexOf(idn.personId) !== -1) { allow = true; statusOnly = true; }
      }
      if (!allow) return;

      var snap = mirror[rec.id];
      if (!snap) {
        // Never seen this record: full push. A brand-new task that the caller
        // can only ASSIGNEE-update cannot be created by them (rules: member
        // has no create right), so skip — it will arrive via a manager/admin.
        if (statusOnly) return;
        ops.push(recordRef(cname, rec.id).set(PMS.utils.deepClone(rec)));
        mirrorUpdates[rec.id] = statusTrack(rec);
        return;
      }

      if (statusOnly) {
        if (statusEquals(statusTrack(rec), snap)) return;
        // Send only the status fields that actually DIFFER from the last-known
        // remote snapshot, so a concurrent manager/admin edit of another field
        // (e.g. progress) is never clobbered by a stale local value. Every
        // field sent stays inside the {status, progress, activity, updatedAt}
        // allow-set the rules check via isStatusOnlyUpdate().
        var payload = { updatedAt: rec.updatedAt || t };
        ["status", "progress", "activity"].forEach(function (k) {
          if (!statusFieldEquals(k, rec, snap)) payload[k] = rec[k];
        });
        ops.push(recordRef(cname, rec.id).update(payload));
        mirrorUpdates[rec.id] = statusTrack(rec);
      } else {
        if (snap.updatedAt === rec.updatedAt) return;
        ops.push(recordRef(cname, rec.id).set(PMS.utils.deepClone(rec)));
        mirrorUpdates[rec.id] = statusTrack(rec);
      }
    });

    return { ops: ops, mirror: mirrorUpdates };
  }

  // Builds the ops to push an append-only collection (the global activity
  // log): create every local entry the mirror has not seen yet, and (admin
  // only) delete mirrored entries no longer present locally — e.g. when an
  // admin clears the log. Entries are immutable once created, so an update
  // is never emitted. Returns { ops, mirror } where mirror maps id -> true
  // (present in cloud) or null (dropped).
  function buildAppendOps(cname, d, idn, t) {
    var ops = [];
    var mirrorUpdates = {};
    var mirror = mirrorFor(cname);
    var local = Array.isArray(d && d[cname]) ? d[cname] : [];
    var have = {};
    local.forEach(function (rec) { if (rec && rec.id) have[rec.id] = true; });

    // deletions: admin only (rules forbid members from deleting entries)
    Object.keys(mirror).forEach(function (id) {
      if (have[id]) return;
      if (!idn.isAdmin) return;
      ops.push(recordRef(cname, id).delete());
      mirrorUpdates[id] = null;
    });

    local.forEach(function (rec) {
      if (!rec || !rec.id) return;
      if (mirror[rec.id]) return;
      ops.push(recordRef(cname, rec.id).set(PMS.utils.deepClone(rec)));
      mirrorUpdates[rec.id] = true;
    });

    return { ops: ops, mirror: mirrorUpdates };
  }

  // Round-3 clouds stored projects/tasks as whole-doc items inside
  // zms_projects/data / zms_tasks/data. The pull already re-expands those
  // items into per-record rows. Here an ADMIN removes the legacy wrapper doc
  // once every item it holds is present locally (so nothing is lost), leaving
  // per-record documents as the only source of truth.
  function legacyCleanupOps(idn) {
    if (!idn.isAdmin) return Promise.resolve([]);
    return Promise.all(RECORD_COLS.map(function (cname) {
      return colRef(cname).get().then(function (s) {
        if (!s.exists || !s.data() || !Array.isArray(s.data().items)) return [];
        var items = s.data().items || [];
        var localIds = {};
        var local = PMS.store.data && PMS.store.data[cname];
        if (Array.isArray(local)) local.forEach(function (it) { if (it && it.id) localIds[it.id] = true; });
        var mirrored = items.every(function (it) { return it && it.id && localIds[it.id]; });
        return mirrored ? [colRef(cname).delete()] : [];
      });
    })).then(function (groups) {
      var out = [];
      groups.forEach(function (g) { out = out.concat(g); });
      return out;
    });
  }

  /* ---------------- push (local -> cloud) ---------------- */
  function push() {
    if (!enabled || applying) return Promise.resolve(false);
    var d = PMS.store.data;
    // Never share/clobber an empty device dataset — refuse to push when there
    // is no real user content at all.
    if (!USER_COLS.some(function (c) { return Array.isArray(d && d[c]) && d[c].length > 0; })) return Promise.resolve(false);
    lastPushAt = Date.now();
    PMS.bus.emit("cloud:inflight", { busy: true, op: "push" });
    return waitForSignedIn().then(function (ok) {
      if (!ok) return false;
      return ensureReady().then(function () {
        var idn = identity();
        if (!idn.cloudUid) return false;
        var t = now();
        return canWriteShared().then(function (sharedWrite) {
          var ops = [];
          // whole-dataset reference collections: only manager/admin (+bootstrap)
          if (sharedWrite) {
            WHOLE_COLS.forEach(function (cname) {
              if (Array.isArray(d[cname])) {
                ops.push(colRef(cname).set({ items: PMS.utils.deepClone(d[cname]), updatedAt: t }));
              }
            });
          }
          // per-record collections (projects/tasks)
          var mirrorPatches = {};
          RECORD_COLS.forEach(function (cname) {
            var built = buildRecordOps(cname, d, idn, t);
            ops = ops.concat(built.ops);
            if (built.mirror) mirrorPatches[cname] = built.mirror;
          });
          // append-only per-record collections (activity log)
          APPEND_COLS.forEach(function (cname) {
            var built = buildAppendOps(cname, d, idn, t);
            ops = ops.concat(built.ops);
            if (built.mirror) mirrorPatches[cname] = built.mirror;
          });
          // legacy round-3 wrapper cleanup (admin only)
          return legacyCleanupOps(idn).then(function (legacyOps) {
            ops = ops.concat(legacyOps);
            // state clock: managers/admins write the full state doc; members
            // only bump the clock (updatedAt) so other devices pull the change
            if (sharedWrite) {
              ops.push(stateRef().set({ updatedAt: t, schemaVersion: PMS.schema.VERSION, writer: PAGE_ID, hasData: true }));
            } else if (ops.length) {
              ops.push(stateRef().set({ updatedAt: t }, { merge: true }));
            }
            if (!ops.length) return false;
            return Promise.all(ops).then(function () {
              // persist the mirror only after the writes succeeded
              Object.keys(mirrorPatches).forEach(function (cname) {
                var next = PMS.utils.deepClone(mirrorFor(cname));
                Object.keys(mirrorPatches[cname]).forEach(function (id) {
                  var v = mirrorPatches[cname][id];
                  if (v === null) delete next[id];
                  else next[id] = v;
                });
                setMirrorFor(cname, next);
              });
              // align the in-memory clock with what we uploaded (and persist
              // it) so the next poll/reboot does not re-import our own data
              // back onto this device. flush() does not emit "store:changed",
              // so this cannot loop.
              var dd = PMS.store.data;
              if (dd && dd.meta) {
                dd.meta.updatedAt = t;
                PMS.store.flush();
              }
              lastPushed = Date.now();
              PMS.bus.emit("cloud:state", { pushed: true });
              var summarized = {};
              COLLECTIONS.forEach(function (cname) { if (Array.isArray(d[cname])) summarized[cname] = d[cname].length; });
              console.info("[cloudsync] push ok", summarized);
              return true;
            });
          });
        });
      });
    }).catch(function (e) {
      console.error("[cloudsync] push failed:", e);
      PMS.bus.emit("cloud:state", { error: e && e.message ? e.message : String(e) });
      return false;
    }).then(function (r) {
      PMS.bus.emit("cloud:inflight", { busy: false, op: "push" });
      return r;
    });
  }

  /* ---------------- pull (cloud -> local) ---------------- */
  // mode: undefined (only when remote is newer) | "replace" | "merge"
  function pull(mode) {
    if (!enabled) return Promise.resolve(false);
    PMS.bus.emit("cloud:inflight", { busy: true, op: "pull" });
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
        if (isRecordCol(cname)) {
          // per-record collection: read every doc. A legacy whole-doc
          // zms_<c>/data (round-3) is re-expanded into its items so existing
          // clouds stay readable until the admin's push migrates them.
          return recordCol(cname).get().then(function (qs) {
            var items = [];
            qs.forEach(function (ds) {
              if (!ds.exists) return;
              var dd = ds.data() || {};
              if (ds.id === "data" && Array.isArray(dd.items)) {
                dd.items.forEach(function (it) { if (it && it.id) items.push(it); });
              } else if (ds.id === "data") {
                // empty legacy wrapper: nothing to expand
              } else {
                items.push(dd);
              }
            });
            return items;
          });
        }
        return colRef(cname).get().then(function (s) {
          return (s.exists && s.data() && Array.isArray(s.data().items)) ? s.data().items : [];
        });
      })).then(function (snaps) {
        var obj = {
          schemaVersion: PMS.schema.VERSION,
          departments: [], people: [], projects: [], tasks: [],
          taskStatuses: [], projectStatuses: [], priorities: [],
          customFieldDefs: [], savedFilters: [],
          meta: { updatedAt: remoteUpdated }
        };
        snaps.forEach(function (items, i) {
          obj[COLLECTIONS[i]] = items || [];
        });
        return obj;
      });
    }).then(function (obj) {
      if (!obj) return false;
      // Capture the RAW remote rows (before merging) so the per-record mirror
      // reflects what the CLOUD holds. Local edits kept by a merge must still
      // look "ahead" on the next push; a mirror built from the merged dataset
      // would swallow them as "unchanged" and they would never upload.
      var rawRemote = PMS.utils.deepClone(obj);
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
      // per-record mirror = the RAWH remote snapshot (a fresh device adopts the
      // cloud as its baseline; a local edit made before/after still differs).
      // Projects/tasks track status fields; append-only collections (activity
      // log) just track which entry ids the cloud already holds.
      COLLECTIONS.forEach(function (cname) {
        var map = {};
        (rawRemote[cname] || []).forEach(function (rec) {
          if (rec && rec.id) map[rec.id] = RECORD_COLS.indexOf(cname) !== -1 ? statusTrack(rec) : true;
        });
        setMirrorFor(cname, map);
      });
      applying = false;
      lastPulled = Date.now();
      PMS.bus.emit("cloud:state", { pulled: true });
      return true;
    }).catch(function (e) {
      PMS.bus.emit("cloud:state", { error: e && e.message ? e.message : String(e) });
      return false;
    }).then(function (r) {
      PMS.bus.emit("cloud:inflight", { busy: false, op: "pull" });
      return r;
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
    debounce = null;
    if (onBeforeUnload) { window.removeEventListener("beforeunload", onBeforeUnload); onBeforeUnload = null; }
    if (onPageHide) { window.removeEventListener("pagehide", onPageHide); onPageHide = null; }
    if (window.firebase && window.firebase.apps) {
      var app = window.firebase.apps.find(function (a) { return a.name === APP_NAME; });
      if (app) { try { app.delete(); } catch (e) {} }
    }
    firestore = null;
  }
  function onChange() {
    if (applying || !enabled) return;
    // A lone, deliberate action (a click, a drag, a save) uploads right away
    // rather than waiting out the debounce. Only a burst of edits - typing in
    // a field, ticking several checklist boxes - waits, so those still land as
    // one write instead of one write per keystroke.
    if (!debounce && Date.now() - lastPushAt >= PUSH_SETTLE) {
      push();
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(function () { debounce = null; push(); }, PUSH_DEBOUNCE);
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
    attachUnloadFlush();
  }

  // Closing or reloading the tab inside the debounce window used to drop the
  // pending upload: the local save is debounced too, so a change made a moment
  // before the tab went away could be lost from BOTH sides. Flush both on the
  // way out. The cloud write may not complete, but it gets the chance, and the
  // next device's poll will pull whatever did land.
  function attachUnloadFlush() {
    if (onBeforeUnload) return;
    onBeforeUnload = function () {
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (PMS.store.flush) { try { PMS.store.flush(); } catch (e) {} }
      if (enabled && !applying) { try { push(); } catch (e) {} }
    };
    onPageHide = onBeforeUnload;
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
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
    PMS.bus.emit("cloud:inflight", { busy: true, op: "boot" });
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
      PMS.bus.emit("cloud:inflight", { busy: false, op: "boot" });
      return synced;
    }).catch(function (e) {
      // Diagnostics for the "Missing or insufficient permissions" case: report
      // the signed-in Firebase uid so we can verify it matches a profile doc
      // in zms_auth_users. Captured BEFORE teardown() which deletes the app.
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
            ["zms_diag/auth (request.auth != null)", function () { return docRef("zms_diag/auth"); }],
            ["zms_diag/get (literal get() role==admin)", function () { return docRef("zms_diag/get"); }],
            ["zms_diag/exists (literal exists())", function () { return docRef("zms_diag/exists"); }],
            ["zms_diag/active (literal get().data.active != false)", function () { return docRef("zms_diag/active"); }],
            ["zms_diag/activeNeg (!(get().data.active == false))", function () { return docRef("zms_diag/activeNeg"); }],
            ["zms_diag/activeIn (guard with 'active' in)", function () { return docRef("zms_diag/activeIn"); }],
            ["zms_diag/hasrole (hasRole call)", function () { return docRef("zms_diag/hasrole"); }],
            ["zms_auth/bootstrap (signupCanRead)", bootRef],
            ["zms_meta/probe (isActiveUser)", probeRef],
            ["zms_meta/state (isActiveUser)", stateRef],
            ["zms_tasks/<id> (record collection list)", function () { return recordCol("tasks").get(); }]
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
            PMS.bus.emit("cloud:inflight", { busy: false, op: "boot" });
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
      PMS.bus.emit("cloud:inflight", { busy: false, op: "boot" });
      return false;
    });
  }

  PMS.cloudsync = {
    enable: enable,
    disable: disable,
    boot: boot,
    push: push,
    dataReplaced: dataReplaced,
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
    setCloudPersonId: setCloudPersonId,
    setCloudEmail: setCloudEmail,
    createMemberAccount: createMemberAccount,
    setCloudActive: setCloudActive,
    deleteCloudAccount: deleteCloudAccount,
    // Backend (Cloud Functions) availability memo: true after any callable
    // succeeds, false after one fails as unavailable, null while unknown.
    backendAvailable: function () { return functionsReady; },
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