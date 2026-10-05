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
    - MEETINGS are also per record (zms_meetings/<id>), written by admins and
      managers (the same roles that may create/edit a meeting in the UI) and
      deleted by admins only. They are read by every active member, exactly
      like tasks and projects; PMS.auth.canViewMeeting() then narrows what a
      MEMBER sees (the meetings they attend or created) in the single read
      path, so the client-side scope rule is unchanged by syncing them.
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
  // MEETINGS live here too: they are shared team data, so they must travel
  // with everything else. They used to be absent from this list entirely,
  // which kept every meeting locked to the browser that created it.
  var RECORD_COLS = ["projects", "tasks", "meetings"];
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
  var forceWhole = false; // the next push replaces the reference collections wholesale
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
      lastSyncAt: lastPushed && lastPulled ? (lastPushed > lastPulled ? lastPushed : lastPulled) : (lastPushed || lastPulled || null),
      denied: lastDenied,
      failed: lastFailed,
      blocked: lastBlocked
    };
  }

  // Why the shared cloud is not moving, in the order a person can act on it.
  // Every one of these used to be a silent no-op, which is indistinguishable
  // from "the app is broken" to whoever is waiting for their work to appear on
  // another device.
  //   noCloudAccount - this sign-in is not linked to a cloud account, so no
  //                    upload or download can happen at all
  //   notSignedIn    - nobody is signed in to the cloud on this device
  //   denied         - the published rules refused specific documents
  //   skipped        - this role may not write those records
  var lastBlocked = [];
  function blockSync(reason, detail) {
    var entry = { reason: reason, detail: detail || null, at: now() };
    for (var i = 0; i < lastBlocked.length; i++) {
      if (lastBlocked[i].reason === reason) { lastBlocked[i] = entry; return; }
    }
    lastBlocked.push(entry);
  }
  function clearBlocked(reason) {
    lastBlocked = lastBlocked.filter(function (b) { return b.reason !== reason; });
  }

  // A write the rules refused. Kept apart from a generic error because it means
  // something only a deployment can fix: the Firestore rules in the project do
  // not cover the path being written. The usual cause is a ruleset left behind
  // by an earlier storage layout - the app writes projects/tasks/meetings as one
  // document PER RECORD, so a ruleset that only knows the old whole-document
  // paths (zms_tasks/data and friends) matches nothing at all and every task
  // write is denied by default. That looks exactly like "my task vanished" from
  // the other devices, with nothing on screen to say why.
  var lastDenied = null;
  var lastFailed = [];
  function noteDenied(err, where) {
    var code = (err && err.code) || "";
    var msg = (err && err.message) || String(err);
    var denied = /permission-denied|Missing or insufficient permissions/i.test(code + " " + msg);
    if (!denied) return false;
    lastDenied = { at: now(), path: where || null, message: msg };
    blockSync("denied", where);
    return true;
  }

  function isConfigured() { return !!config(); }
  function isEnabled() { return enabled; }

  /* ---------------- shared backups (zms_backups) ---------------------
     Admin-only, per record. The app used to keep snapshots in localStorage
     only, so every device had a private history that a cleared browser erased
     and a new device could not inherit. saveBackup/loadBackup/deleteBackup
     mirror PMS.backup, which keeps a local cache for offline restores and
     treats the cloud as the shared source of truth.
     -------------------------------------------------------------------- */
  function backupsCol() { return firestore.collection("zms_backups"); }
  function backupRef(id) { return firestore.collection("zms_backups").doc(id); }

  // The snapshot must survive on the shared side even if the generic push
  // fails, so this is intentionally independent of push().
  function saveBackup(b) {
    if (!b || !b.id || !cloudUidIsAdminish()) return Promise.resolve(false);
    return waitForSignedIn().then(function (ok) { return ok ? ensureReady() : null; })
      .then(function () {
        if (!firestore) return false;
        return backupRef(b.id).set({
          id: b.id,
          createdAt: b.createdAt || now(),
          updatedAt: now(),
          data: b.data || {}
        }).then(function () { return true; });
      })
      .catch(function (e) {
        console.warn("[cloudsync] saveBackup failed:", e);
        return false;
      });
  }

  function listBackups() {
    if (!cloudUidIsAdminish()) return Promise.resolve([]);
    return waitForSignedIn().then(function (ok) { return ok ? ensureReady() : null; })
      .then(function () {
        if (!firestore) return [];
        return backupsCol().get().then(function (qs) {
          var rows = [];
          qs.forEach(function (ds) { if (ds.exists) rows.push(ds.data() || {}); });
          return rows.sort(function (a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); });
        });
      })
      .catch(function (e) {
        console.warn("[cloudsync] listBackups failed:", e);
        return [];
      });
  }

  function loadBackup(id) {
    if (!id || !cloudUidIsAdminish()) return Promise.resolve(null);
    return waitForSignedIn().then(function (ok) { return ok ? ensureReady() : null; })
      .then(function () {
        if (!firestore) return null;
        return backupRef(id).get().then(function (s) { return s.exists ? (s.data() || null) : null; });
      })
      .catch(function (e) {
        console.warn("[cloudsync] loadBackup failed:", e);
        return null;
      });
  }

  function deleteBackup(id) {
    if (!id || !cloudUidIsAdminish()) return Promise.resolve(false);
    return waitForSignedIn().then(function (ok) { return ok ? ensureReady() : null; })
      .then(function () {
        if (!firestore) return false;
        return backupRef(id).delete().then(function () { return true; });
      })
      .catch(function (e) {
        console.warn("[cloudsync] deleteBackup failed:", e);
        return false;
      });
  }

  // Keep only the newest `max` snapshots in the shared history. Deleting the
  // rest is what makes retention a real limit instead of unbounded growth.
  function trimBackups(max) {
    if (!cloudUidIsAdminish()) return Promise.resolve(false);
    var keep = Math.max(1, Number(max) || 10);
    return listBackups().then(function (rows) {
      if (rows.length <= keep) return false;
      var drop = rows.slice(keep).map(function (r) { return r.id; }).filter(Boolean);
      return Promise.all(drop.map(function (id) { return backupRef(id).delete(); }))
        .then(function () { return true; });
    }).catch(function (e) {
      console.warn("[cloudsync] trimBackups failed:", e);
      return false;
    });
  }

  // Backups and the audit trail are admin-only by design; the Firestore rules
  // enforce it, and this keeps a member from even issuing the read.
  function cloudUidIsAdminish() {
    var u = (PMS.auth && PMS.auth.currentUser) ? PMS.auth.currentUser() : null;
    return !!(u && u.role === "admin");
  }

  /* ---------------- account audit trail: read side --------------------
     The Activity log view (admin-only) shows the local `activities` array AND
     these account events, so an admin sees one timeline covering project data
     and account/security data. They are read straight from the cloud and
     CACHED in PMS.store.data.accountEvents (never pushed back by the generic
     push, which does not know this collection) so the view has something to
     render immediately and offline.
     -------------------------------------------------------------------- */
  var accountEventsFetched = false;

  function isAdminReader() {
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return !!(u && u.role === "admin");
  }

  function cacheAccountEvents(rows) {
    if (!PMS.store || !PMS.store.data) return;
    PMS.store.data.accountEvents = rows || [];
    // flush() does NOT emit "store:changed", so this can never be mistaken
    // for a user edit and echo itself back to the cloud.
    if (PMS.store.flush) { try { PMS.store.flush(); } catch (e) {} }
  }

  // Resolves with the newest-first event list. Admin-only by design: the rules
  // deny these documents to everyone else, and a non-admin simply gets the
  // local cache rather than a failed read.
  function accountEvents() {
    if (!enabled || !isAdminReader()) {
      return Promise.resolve((PMS.store.data && PMS.store.data.accountEvents) || []);
    }
    return waitForSignedIn().then(function (ok) {
      if (!ok) return (PMS.store.data && PMS.store.data.accountEvents) || [];
      return ensureReady();
    }).then(function () {
      return accountEventsCol().get();
    }).then(function (qs) {
      var rows = [];
      qs.forEach(function (ds) { if (ds.exists) rows.push(ds.data() || {}); });
      rows.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });
      accountEventsFetched = true;
      cacheAccountEvents(rows);
      return rows;
    }).catch(function (e) {
      console.warn("[cloudsync] account events unavailable:", e);
      return (PMS.store.data && PMS.store.data.accountEvents) || [];
    });
  }

  /* ---------------- cloud account directory: read side ----------------
     Accounts live in Firebase Auth, so a fresh browser has exactly ONE local
     record: the account it signed in with. Settings -> Accounts & access used
     to render PMS.auth.users() alone, which is why an admin opening the app on
     another browser saw only their own login and concluded the team was gone.

     The rules ALREADY let an admin read every zms_auth_users/<uid> document
     ("allow read: if request.auth.uid == uid || isAdmin(...)"), so the
     directory needs no rules deployment - only a client-side read that is
     admin-gated exactly like accountEvents(). Each document carries
     {email, role, displayName, personId, active, createdAt}; nothing secret is
     in it (passwords never leave Firebase Auth).
     -------------------------------------------------------------------- */
  var cloudAccountsFetchedFor = null;

  function cacheCloudAccounts(rows) {
    if (!PMS.store || !PMS.store.data) return;
    PMS.store.data.cloudAccounts = rows || [];
    // flush() does NOT emit "store:changed", so a directory read can never be
    // mistaken for an account edit and echo itself back to the cloud.
    if (PMS.store.flush) { try { PMS.store.flush(); } catch (e) {} }
  }

  function normalizeCloudAccount(uid, d) {
    d = d || {};
    return {
      cloudUid: uid,
      email: d.email || "",
      role: d.role === "admin" || d.role === "manager" ? d.role : "member",
      displayName: d.displayName || "",
      personId: d.personId || null,
      active: d.active !== false,
      createdAt: d.createdAt || ""
    };
  }

  // Resolves with the sanitized directory. Admin-only by design: the rules deny
  // these documents to non-admins, and a non-admin simply gets the local cache
  // rather than a failed read. Never rejects.
  function cloudAccounts(force) {
    var cached = (PMS.store && PMS.store.data && PMS.store.data.cloudAccounts) || [];
    if (!enabled || !isAdminReader()) return Promise.resolve(cached);
    // keyed by uid: signing out and back in as a different admin in the same tab
    // must not serve the previous admin's cached directory
    var me = PMS.auth.currentUser() || {};
    var uid = me.cloudUid || me.id || "";
    if (cloudAccountsFetchedFor === uid && !force) return Promise.resolve(cached);
    return waitForSignedIn().then(function (ok) {
      if (!ok) return cached;
      return ensureReady();
    }).then(function () {
      return firestore.collection("zms_auth_users").get();
    }).then(function (qs) {
      var rows = [];
      qs.forEach(function (ds) { if (ds.exists) rows.push(normalizeCloudAccount(ds.id, ds.data())); });
      rows.sort(function (a, b) { return String(a.email || "").localeCompare(String(b.email || "")); });
      cloudAccountsFetchedFor = uid;
      cacheCloudAccounts(rows);
      return rows;
    }).catch(function (e) {
      console.warn("[cloudsync] cloud account directory unavailable:", e);
      return cached;
    });
  }

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

  /* ---------------- account audit trail (admin visibility) -------------
     Everything that touches an ACCOUNT (not a project record) has to be
     visible to an admin on every device. These events are not part of the
     local `activities` array: the accounts themselves live in Firebase Auth
     and never pass through PMS.store, so there is no local record to append
     to and nothing would reach the other devices. They are written straight
     to zms_account_events/<id> instead.

     Each document carries the ACTING user (who did it) and, when relevant, the
     AFFECTED user (whose account it was). That distinction matters: an admin
     demoting a member, and a member changing their own password, both have to
     be attributable.
     -------------------------------------------------------------------- */
  function accountEventsCol() { return firestore.collection("zms_account_events"); }

  // Never throws and never rejects: an audit write must not break the action
  // the user actually asked for. A failed event is logged loudly instead.
  function recordAccountEvent(kind, target, detail) {
    try {
      if (!firestore) return Promise.resolve(false);
      var idn = identity();
      var rec = {
        id: PMS.ids.uuid(),
        at: now(), updatedAt: now(), ts: Date.now(),
        kind: kind,
        actor: idn.user ? (idn.user.name || idn.user.username || idn.user.email || "") : "",
        actorId: idn.user ? idn.user.id : null,
        actorUid: idn.cloudUid || null,
        actorRole: idn.role || null,
        target: target || null,
        detail: detail || ""
      };
      return accountEventsCol().doc(rec.id).set(rec).then(function () { return true; },
        function (e) {
          console.error("[cloudsync] account event \"" + kind + "\" not recorded:", e);
          return false;
        });
    } catch (e) {
      console.error("[cloudsync] account event \"" + kind + "\" not recorded:", e);
      return Promise.resolve(false);
    }
  }

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
      }).then(function (res) {
        return recordAccountEvent("account.created", opts.email, "created " + res.role).then(function () { return res; });
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
    }).then(function (res) {
      // Identity is not adopted into PMS.auth yet at this point, so the event
      // is attributed to the account being signed into rather than to
      // "unknown". If the local session is already the same user, identity()
      // resolves the real name anyway.
      return recordAccountEvent("account.signin", res.uid, "signed in as " + res.role)
        .then(function () { return res; });
    }).catch(function (e) {
      // A FAILED sign-in is recorded too: repeated failures against one account
      // are exactly what an admin needs to see. Only the target email and the
      // reason are written — never the attempted password.
      if (!e || e.userCode !== "invalid") { e.userCode = authErrorMessage(e); throw e; }
      return recordAccountEvent("account.signin.failed", opts.email, "rejected: wrong credentials or unknown account")
        .then(function () { throw e; }, function () { throw e; });
    });
  }

  function signOut() {
    return recordAccountEvent("account.signout", (PMS.auth && PMS.auth.currentUser) ? (PMS.auth.currentUser() || {}).username : null, "signed out")
      .then(function () { return authx(); })
      .then(function (a) { return a.signOut(); })
      .catch(function () { return null; });
  }

  function resetPassword(email) {
    if (!email) return Promise.reject(new Error("bad-input"));
    return authx().then(function (a) { return a.sendPasswordResetEmail(email); })
      .then(function () {
        return recordAccountEvent("account.password", email, "password reset email sent");
      })
      .then(function () { return true; });
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
    return cloudUserRef(uid).get().then(function (s) {
      var prev = (s.exists && s.data() && s.data().role) || null;
      return setRoleViaBackend(uid, role).then(function (done) {
        if (!done) {
          // fallback: no deployed function — direct write (rules are the real gate)
          return ensureReady().then(function () {
            return cloudUserRef(uid).set({ role: role }, { merge: true });
          }).then(function () { return true; }).catch(function () { return false; });
        }
        return true;
      }).then(function (ok) {
        if (!ok) return false;
        return recordAccountEvent("account.role", uid, (prev || "none") + " → " + role)
          .then(function () { return true; });
      });
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
      return cloudUserRef(uid).get();
    }).then(function (s) {
      var prev = (s.exists && s.data() && s.data().personId) || null;
      return cloudUserRef(uid).set({ personId: personId || null }, { merge: true })
        .then(function () {
          return recordAccountEvent("account.person", uid, (prev || "none") + " → " + (personId || "none"));
        })
        .then(function () { return true; }).catch(function () { return false; });
    }).catch(function () { return false; });
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
    }).then(function () {
      functionsReady = true;
      // recorded AFTER the delete, while this session is still authenticated
      return recordAccountEvent("account.deleted", uid, "deleted");
    }).then(function () { return true; });
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
    }).then(function (out) {
      return recordAccountEvent("account.created", out.uid, "created member").then(function () { return out; });
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
    }).then(function () {
      functionsReady = true;
      return recordAccountEvent("account.active", uid, active !== false ? "enabled" : "disabled");
    }).then(function () { return true; });
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
    }).then(function () {
      functionsReady = true;
      return recordAccountEvent("account.email", uid, "email changed");
    }).then(function () { return true; });
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

  /* ---- whole-dataset reference collections: change-aware publishing ----
     departments / people / customFieldDefs / savedFilters and the status lists
     live as ONE document per collection, so a single write replaces every
     record in it. Publishing that document verbatim made each device the
     authority on the whole collection: a browser whose local copy was one edit
     behind overwrote everyone else's people and custom fields, and a delete
     "came back" the moment the next stale device saved. That is what made an
     added person vanish and a deleted field reappear.

     They are merged instead, against the baseline this device last pulled, and
     written inside a transaction so two devices editing different records cannot
     lose each other's work. The baseline is a content signature per record, so
     "changed here", "changed there" and "deleted here" are all distinguishable.
     -------------------------------------------------------------------- */
  var ADOPT_KEY = "pms-cloud-adopted";

  // Deterministic string for a record, independent of key order, so two copies
  // of the same record always produce the same signature.
  function canonical(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ":" + canonical(v[k]);
    }).join(",") + "}";
  }

  function wholeSig(rec) { return rec ? canonical(rec) : null; }

  // Has this device ever adopted the shared dataset? A brand-new browser has
  // not, and its local store is a fresh seed - never an edit worth publishing.
  // The marker records WHICH cloud was adopted, so pointing the app at another
  // Firebase project starts over instead of trusting a marker from the old one.
  function adoptedClock() {
    try {
      var raw = window.localStorage.getItem(ADOPT_KEY) || "";
      if (!raw) return null;
      var at = raw.indexOf("|");
      var proj = at === -1 ? "" : raw.slice(0, at);
      var clock = at === -1 ? "" : raw.slice(at + 1);
      var c = config() || {};
      if (proj !== (c.projectId || "")) return null; // a different cloud
      return clock || null;
    } catch (e) { return null; }
  }
  function markAdopted(v) {
    try {
      if (!v) { window.localStorage.removeItem(ADOPT_KEY); return; }
      var c = config() || {};
      window.localStorage.setItem(ADOPT_KEY, (c.projectId || "") + "|" + v);
    } catch (e) {}
  }

  /* Merge one reference collection. Pure, so it is testable without a network.
       - only remote has it      -> keep it (someone else added it)
       - only local has it, id was in the baseline -> we deleted it, drop it
       - only local has it, id was never in the baseline -> ours is new, keep it
       - both have it, only ours differs from the baseline -> our edit wins
       - both have it, only theirs differs -> their edit wins
       - both changed -> the newer updatedAt wins
       - neither changed -> the cloud's copy is kept */
  function mergeWholeCol(cname, local, remote, baseline) {
    var base = baseline || {};
    var index = function (arr) {
      var map = {}, order = [], loose = [];
      (arr || []).forEach(function (r) {
        // A record with no id cannot be matched or merged. Repositories always
        // assign one, so this is broken data in practice - but dropping it
        // silently is still data loss, so it is carried through untouched.
        if (!r || !r.id) { if (r) loose.push(r); return; }
        map[r.id] = r;
        if (order.indexOf(r.id) === -1) order.push(r.id);
      });
      return { map: map, order: order, loose: loose };
    };
    var L = index(local), R = index(remote);
    var out = [], seen = {}, seenSig = {};
    var keep = function (rec) { out.push(rec); seenSig[wholeSig(rec)] = true; };
    // Remote order first: it is the order the cloud settled on, and it keeps
    // additions at the end instead of reshuffling everyone's list.
    R.order.forEach(function (id) {
      seen[id] = true;
      var r = R.map[id], l = L.map[id];
      if (!l) {
        // Only the cloud has it. If this device published it before and it is
        // gone from the local copy, WE deleted it and that delete has to travel
        // - this is the deleted custom field. If this device never had it, the
        // record is somebody else's addition and must be kept.
        if (!base[id]) keep(r);
        return;
      }
      if (!base[id]) { keep(l); return; } // never published from here
      var lChanged = wholeSig(l) !== base[id], rChanged = wholeSig(r) !== base[id];
      if (lChanged && !rChanged) { keep(l); return; }
      if (!lChanged && rChanged) { keep(r); return; }
      if (lChanged && rChanged) { keep(isNewer(l.updatedAt, r.updatedAt) ? l : r); return; }
      keep(r);
    });
    L.order.forEach(function (id) {
      if (seen[id]) return;
      if (R.map[id]) return;
      if (base[id]) return;  // we had it, it is gone locally: we deleted it
      keep(L.map[id]);        // never published: an addition of ours
    });
    // Unmatchable records last, ours first, skipping exact duplicates.
    L.loose.concat(R.loose).forEach(function (rec) {
      var s = wholeSig(rec);
      if (seenSig[s]) return;
      seenSig[s] = true;
      out.push(rec);
    });
    return out;
  }

  // Read-modify-write the shared document inside a transaction. The transaction
  // retries if another device writes concurrently, so a merge can never be
  // computed from a copy that has already gone stale.
  // `replace` is for a deliberate wholesale replacement (load demo data, restore
  // a backup, replace import, erase all data): there the local dataset IS the
  // intended truth, so records the cloud still holds and the local copy does not
  // have to go. It is never used for an ordinary edit.
  function pushWholeCol(cname, d, t, replace) {
    var local = Array.isArray(d[cname]) ? PMS.utils.deepClone(d[cname]) : [];
    var baseline = mirrorFor(cname);
    var ref = colRef(cname);
    return firestore.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var existed = snap.exists;
        var body = existed ? (snap.data() || {}) : {};
        var remote = Array.isArray(body.items) ? body.items : [];
        var merged = replace ? local : mergeWholeCol(cname, local, remote, baseline);
        var unchanged = existed && wholeSig(remote) === wholeSig(merged);
        // Nothing of ours to publish and nothing new to adopt: leave the
        // document (and its clock) completely alone.
        if (unchanged) return { items: merged, changed: false };
        tx.set(ref, { items: merged, updatedAt: t });
        return { items: merged, changed: true };
      });
    });
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
    // The caller replaced the whole dataset on purpose, so this push is
    // authoritative for the reference collections too - it is the one case where
    // records the cloud still holds must NOT be preserved.
    forceWhole = true;
    return push().then(function (r) {
      forceWhole = false;
      return r;
    }, function (e) {
      forceWhole = false;
      throw e;
    });
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

  // Mirror entry for a per-record document. Tasks/projects track the status
  // fields (for the assignee status-only path); a MEETING has no status,
  // progress or activity, so tracking them would store meaningless nulls and
  // make the mirror misleading — its updatedAt alone decides changed/not.
  // createdByPersonId is kept in the mirror on purpose: once a record is deleted
  // locally there is no record left to read the creator from, and the mirror is
  // the only place that can still tell whether this account may delete it in
  // the cloud (auth.js canDeleteRecord).
  function recordTrack(cname, rec) {
    if (cname === "meetings") {
      return { updatedAt: (rec && rec.updatedAt) || null, createdByPersonId: (rec && rec.createdByPersonId) || null };
    }
    var t = statusTrack(rec);
    t.createdByPersonId = (rec && rec.createdByPersonId) || null;
    return t;
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

  // Tags a write with the document it targets and turns a rejection into a
  // settled result, so one refused write cannot discard the bookkeeping for
  // every other write in the same push. Before this, Promise.all rejected on
  // the first denial and the mirror was never persisted - so a ruleset that
  // denies one collection silently blocked the bookkeeping for all of them, and
  // the app carried on as if it had uploaded.
  function writeOp(label, promise, opts) {
    return promise.then(
      function () { return { ok: true, label: label }; },
      function (e) {
        // "already there" is a successful outcome for an append-only create:
        // the record IS in the cloud, which is all the mirror records.
        var code = e && e.code || "";
        if (opts && opts.alreadyExistsOk &&
            (code === "already-exists" || /already exists/i.test((e && e.message) || ""))) {
          return { ok: true, label: label, alreadyExisted: true };
        }
        return { ok: false, label: label, error: e };
      }
    );
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

    // Deletions. An admin may delete any record; a manager may delete only a
    // record they created (rules: canDeleteRecord). The creator is read from
    // the MIRROR, because the local record is already gone by the time this
    // runs — and the mirror carries createdByPersonId exactly for this reason.
    Object.keys(mirror).forEach(function (id) {
      if (have[id]) return;
      if (!idn.isAdmin) {
        if (idn.role !== "manager" || !idn.personId) return;
        var creator = (mirror[id] && mirror[id].createdByPersonId) || null;
        if (creator !== idn.personId) return;
      }
      ops.push(writeOp(cname + "/" + id + " (delete)", recordRef(cname, id).delete()));
      mirrorUpdates[id] = null;
    });

    // Records this device is not allowed to write. They stay local and will be
    // dropped by the next pull's merge heuristic, which is what made a skipped
    // task look like it "vanished". Collecting them lets push() say so out loud
    // instead of reporting success while quietly leaving data behind.
    var skipped = [];

    local.forEach(function (rec) {
      if (!rec || !rec.id) return;
      var allow = false;
      var statusOnly = false;
      if (cname === "projects") {
        // admin pushes any project; otherwise only the project whose managerId
        // matches the caller's personId
        allow = idn.isAdmin || (idn.personId && rec.managerId && rec.managerId === idn.personId);
      } else if (cname === "meetings") {
        // Meetings are created and edited by admins AND managers
        // (auth.js canCreateMeeting/canEditMeeting) and are read-only for
        // members, so a plain member never emits a write here. isAdmin alone
        // is NOT enough: a manager is a legitimate meeting editor but is not
        // an admin, and must still be able to publish their meetings.
        // Deletions stay admin-only (handled in the loop above).
        allow = idn.isAdmin || idn.role === "manager";
      } else {
        // tasks. CREATE and UPDATE have different rights, so they are decided
        // separately: `snap` below tells a brand-new record from an existing
        // one. Checking them together was what silently dropped a task.
        //  - CREATE: an admin anywhere, and a manager in ANY pillar
        //    (auth.js canCreateTask), because an unassigned task belongs to
        //    nobody and must be creatable from every pillar.
        //  - UPDATE: an admin anywhere, the manager OF THAT PILLAR in full, or
        //    an assignee for the status fields only.
        // A manager who creates a task in someone else's pillar may not
        // therefore rewrite it afterwards; that stays with the pillar manager.
        if (idn.isAdmin) allow = true;
        else if (idn.role === "manager" && !mirror[rec.id]) allow = true;
        else if (!allow && idn.personId && projectManagerOf(d, rec.projectId) === idn.personId) allow = true;
        else if (!allow && idn.personId && Array.isArray(rec.assignees) && rec.assignees.indexOf(idn.personId) !== -1) { allow = true; statusOnly = true; }
      }
      if (!allow) { skipped.push(rec.id); return; }

      var snap = mirror[rec.id];
      if (!snap) {
        // Never seen this record: full push. A brand-new task that the caller
        // can only ASSIGNEE-update cannot be created by them (rules: member
        // has no create right), so skip — it will arrive via a manager/admin.
        if (statusOnly) return;
        ops.push(writeOp(cname + "/" + rec.id + " (write)", recordRef(cname, rec.id).set(PMS.utils.deepClone(rec))));
        mirrorUpdates[rec.id] = recordTrack(cname, rec);
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
        ops.push(writeOp(cname + "/" + rec.id + " (status)", recordRef(cname, rec.id).update(payload)));
        mirrorUpdates[rec.id] = recordTrack(cname, rec);
      } else {
        if (snap.updatedAt === rec.updatedAt) return;
        ops.push(writeOp(cname + "/" + rec.id + " (write)", recordRef(cname, rec.id).set(PMS.utils.deepClone(rec))));
        mirrorUpdates[rec.id] = recordTrack(cname, rec);
      }
    });

    return { ops: ops, mirror: mirrorUpdates, skipped: skipped };
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
      ops.push(writeOp(cname + "/" + id + " (delete)", recordRef(cname, id).delete()));
      mirrorUpdates[id] = null;
    });

    local.forEach(function (rec) {
      if (!rec || !rec.id) return;
      if (mirror[rec.id]) return;
      // create(), not set(). The activity log is append-only in the rules
      // (allow update: if false), so a set() on an entry the cloud ALREADY holds
      // is an update and is refused. The mirror is only ever filled by a pull
      // that actually applied data, so a device whose mirror was lost (cleared
      // storage, fresh browser, a pull that short-circuited) holds entries that
      // are already in the cloud and would re-send every one of them - each one
      // refused, which is what turned an admin's push into a permanent
      // "Upload failed". create() makes "already there" an explicit,
      // distinguishable answer instead of a rules refusal.
      ops.push(writeOp(cname + "/" + rec.id + " (write)",
        recordRef(cname, rec.id).create(PMS.utils.deepClone(rec)), { alreadyExistsOk: true }));
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
    // The round-4 ruleset deliberately has NO rule for zms_<c>/data: those
    // wrapper docs are gone by design, so reading one is REFUSED. This runs on
    // every admin push, so treating that refusal as a failure made every push
    // report "Upload failed" - and before it was caught, it aborted the push
    // before a single task or activity was written. A wrapper doc that the
    // rules no longer mention cannot exist, so there is nothing here to clean
    // up: this is best-effort housekeeping and must never colour the result.
    if (!idn.isAdmin) return Promise.resolve([]);
    return Promise.all(RECORD_COLS.map(function (cname) {
      return colRef(cname).get().then(function (s) {
        if (!s.exists || !s.data() || !Array.isArray(s.data().items)) return [];
        var items = s.data().items || [];
        var localIds = {};
        var local = PMS.store.data && PMS.store.data[cname];
        if (Array.isArray(local)) local.forEach(function (it) { if (it && it.id) localIds[it.id] = true; });
        var mirrored = items.every(function (it) { return it && it.id && localIds[it.id]; });
        return mirrored ? [writeOp(cname + "/data (legacy cleanup)", colRef(cname).delete())] : [];
      }, function (e) {
        // Expected on the current ruleset: the wrapper doc is not readable
        // because no rule covers it. Not an error, and not the account's fault.
        console.debug("[cloudsync] legacy wrapper " + cname + "/data not present or not readable (" +
          ((e && e.code) || "error") + ") - nothing to clean up");
        return [];
      });
    })).then(function (groups) {
      var out = [];
      groups.forEach(function (g) { out = out.concat(g); });
      return out;
    }, function (e) {
      console.debug("[cloudsync] legacy cleanup skipped (" + ((e && e.code) || "error") + ")");
      return [];
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
      if (!ok) { blockSync("notSignedIn", "zms (every collection)"); return false; }
      clearBlocked("notSignedIn");
      return ensureReady().then(function () {
        var idn = identity();
        if (!idn.cloudUid) {
          // Not an error, but it does mean NOTHING can leave this device, and
          // until now it said nothing at all - a task created here simply never
          // reached anyone else, with no clue on screen. An account that has
          // never been linked to a cloud sign-in has no cloudUid, so this is the
          // normal state for a purely local account.
          blockSync("noCloudAccount", "zms (every collection)");
          return false;
        }
        var t = now();
        return canWriteShared().then(function (sharedWrite) {
          var ops = [];
          var mirrorPatches = {};
          var skippedByCol = {};
          var wroteWhole = false;

          // Whole-dataset reference collections (departments, people,
          // customFieldDefs, savedFilters, statuses, priorities): only
          // manager/admin (+bootstrap). These are merged into the cloud inside a
          // transaction instead of overwriting it. A verbatim write made each
          // device the authority on the entire collection, so a browser one
          // edit behind erased everyone else's people, and a deleted custom
          // field reappeared as soon as the next stale device saved.
          var wholeJob = sharedWrite
            ? Promise.all(WHOLE_COLS.map(function (cname) {
              if (!Array.isArray(d[cname])) return null;
              return pushWholeCol(cname, d, t, forceWhole).then(function (res) {
                if (!res || !res.changed) return;
                wroteWhole = true;
                // The baseline is now what the cloud holds, not what this
                // device started from, so the next push sees no phantom diff.
                var map = {};
                (res.items || []).forEach(function (rec) {
                  if (rec && rec.id) map[rec.id] = wholeSig(rec);
                });
                mirrorPatches[cname] = map;
              }).catch(function (e) {
                // A refused reference collection must not take the per-record
                // writes down with it. Those are separate documents with their
                // own rules, and they are the ones carrying tasks between users.
                noteDenied(e, "zms_" + cname + "/data");
                console.error("[cloudsync] reference collection not written:", cname, e);
              });
            }))
            : Promise.resolve();

          return wholeJob.then(function () {
            // per-record collections (projects/tasks/meetings)
            RECORD_COLS.forEach(function (cname) {
              var built = buildRecordOps(cname, d, idn, t);
              ops = ops.concat(built.ops);
              if (built.mirror) mirrorPatches[cname] = built.mirror;
              if (built.skipped && built.skipped.length) skippedByCol[cname] = built.skipped;
            });
            // append-only per-record collections (activity log)
            APPEND_COLS.forEach(function (cname) {
              var built = buildAppendOps(cname, d, idn, t);
              ops = ops.concat(built.ops);
              if (built.mirror) mirrorPatches[cname] = built.mirror;
            });
            // legacy round-3 wrapper cleanup (admin only). Deliberately kept OUT of
            // `ops`: a wrapper doc the rules no longer cover can never be
            // cleaned up, and its absence must not turn a fully successful
            // upload into "Upload failed".
            return legacyCleanupOps(idn).catch(function () { return []; }).then(function () {
              // state clock: managers/admins write the full state doc; members
              // only bump the clock (updatedAt) so other devices pull the change
              if (sharedWrite && (ops.length || wroteWhole)) {
                ops.push(writeOp("zms_meta/state", stateRef().set({ updatedAt: t, schemaVersion: PMS.schema.VERSION, writer: PAGE_ID, hasData: true })));
              } else if (ops.length) {
                ops.push(writeOp("zms_meta/state", stateRef().set({ updatedAt: t }, { merge: true })));
              }
              if (!ops.length && !wroteWhole) return false;
              return Promise.all(ops).then(function (results) {
                // Settled, so a refused write is reported instead of cancelling
                // the whole push. The mirror below is only patched for the
                // collections whose writes actually landed.
                var denied = [], failed = [];
                (results || []).forEach(function (r) {
                  if (!r || r.ok !== false) return;
                  if (noteDenied(r.error, r.label)) denied.push(r.label);
                  else failed.push(r.label);
                });
                // Keep WHY each one failed, not just that it did. "Upload failed"
                // names only the Firestore rules, so a quota, an expired session
                // or a value the rules cannot express all read identically.
                lastFailed = results.filter(function (r) { return r && r.ok === false; })
                  .map(function (r) {
                    return {
                      label: r.label,
                      code: (r.error && r.error.code) || "",
                      message: (r.error && r.error.message) || String(r.error)
                    };
                  });
                if (!lastFailed.length) lastFailed = [];
                if (denied.length) {
                  console.error("[cloudsync] REFUSED by the Firestore rules - these documents were not written:", denied);
                }
                if (failed.length) {
                  console.error("[cloudsync] write failed:", failed);
                }
                // persist the mirror only for the writes that landed
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
                // This device has now published (or confirmed) its copy of the
                // shared dataset, so a later boot may treat local as editable
                // rather than as an unadopted seed.
                markAdopted(t);
                lastPushed = Date.now();
                var summarized = {};
                COLLECTIONS.forEach(function (cname) { if (Array.isArray(d[cname])) summarized[cname] = d[cname].length; });
                console.info("[cloudsync] push ok", summarized);
                // Never let a refused write pass as a clean push. These records
                // are still only local, and the next pull will drop them as if a
                // remote writer had deleted them, so surface the reason now.
                if (Object.keys(skippedByCol).length) {
                  console.warn("[cloudsync] not uploaded (no write right for this account):", skippedByCol);
                  PMS.bus.emit("cloud:skipped", { collections: skippedByCol });
                  Object.keys(skippedByCol).forEach(function (c) {
                    blockSync("skipped", c + " (" + skippedByCol[c].length + ")");
                  });
                }
                // Everything landed: nothing is holding the sync up any more.
                if (!denied.length && !failed.length) {
                  lastDenied = null;
                  clearBlocked("denied");
                  clearBlocked("noCloudAccount");
                  clearBlocked("notSignedIn");
                }
                if (denied.length) PMS.bus.emit("cloud:denied", { paths: denied });
                PMS.bus.emit("cloud:state", { pushed: true, denied: denied.length ? denied : null });
                // A refused write is a failed upload even though other parts of
                // the push landed, so the caller's promise must say so.
                return denied.length === 0 && failed.length === 0;
              });
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
      // A device that has never adopted this cloud has nothing worth
      // protecting locally: its store is a fresh seed (or a leftover from before
      // it was ever connected). Judging that against the remote clock let a
      // newly opened browser decide it was "ahead" - its seed is stamped now,
      // the shared data was written days ago - so it published the seed over the
      // cloud and deleted the people everyone else had added. Adopt first, and
      // only then may this device publish.
      var unadopted = !adoptedClock();
      if (mode !== "replace" && mode !== "merge") {
        // automatic pull: apply when the remote is newer, or whenever this
        // device has no real content yet (fresh browser) so it adopts the
        // shared dataset regardless of clocks. An empty local store must never
        // be treated as "ahead" of a populated cloud.
        if (!remoteUpdated) return null;
        if (!unadopted && !localEmpty && localUpdated && remoteUpdated <= localUpdated) return null;
      }
      // One refused collection must not cancel the others. Promise.all used to
      // reject on the first denial, which threw away every OTHER collection as
      // well: the shared dataset then simply stopped updating, which reads as
      // "the other users' records disappeared" with nothing on screen to say why.
      return Promise.all(COLLECTIONS.map(function (cname) {
        var read = isRecordCol(cname) ? recordCol(cname).get().then(function (qs) {
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
        }) : colRef(cname).get().then(function (s) {
          return (s.exists && s.data() && Array.isArray(s.data().items)) ? s.data().items : [];
        });
        return read.then(
          function (items) { return { cname: cname, items: items || [] }; },
          function (e) { return { cname: cname, items: [], error: e }; }
        );
      })).then(function (snaps) {
        var unreadable = snaps.filter(function (s) { return s.error; });
        if (unreadable.length) {
          unreadable.forEach(function (s) {
            console.warn("[cloudsync] cannot read " + s.cname + ":",
              s.error && s.error.message ? s.error.message : s.error);
            noteDenied(s.error, s.cname + " (read)");
          });
          blockSync("unreadable", unreadable.map(function (s) { return s.cname; }).join(", "));
        } else {
          clearBlocked("unreadable");
        }
        var obj = {
          schemaVersion: PMS.schema.VERSION,
          departments: [], people: [], projects: [], tasks: [], meetings: [],
          taskStatuses: [], projectStatuses: [], priorities: [],
          customFieldDefs: [], savedFilters: [],
          meta: { updatedAt: remoteUpdated }
        };
        snaps.forEach(function (s) { obj[s.cname] = s.items || []; });
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
          if (!rec || !rec.id) return;
          // Reference collections are compared by content signature on push,
          // so their baseline has to be the signature and not a bare `true`.
          map[rec.id] = RECORD_COLS.indexOf(cname) !== -1 ? recordTrack(cname, rec) : wholeSig(rec);
        });
        setMirrorFor(cname, map);
      });
      // accountEvents is a CLOUD-ONLY, admin-read cache: it is not part of
      // COLLECTIONS, so it is neither pushed nor merged here. Keep whatever the
      // local cache already holds instead of letting the wholesale replacement
      // drop it (setData() replaces the store, and this key is not rebuilt
      // from a pull). It is refreshed explicitly by accountEvents().
      if (rawRemote.accountEvents) cacheAccountEvents(rawRemote.accountEvents);
      // This device now holds the shared dataset. Until this is recorded, every
      // later boot treats the local store as an unadopted seed and refuses to
      // publish it over the cloud.
      markAdopted(remoteUpdated || now());
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
  //  - a local-only id last touched at or before the remote's latest push was
  //    deleted by that push's writer -> dropped (remote deletions reach all
  //    devices). A local item edited or created AFTER that push is kept, so
  //    offline edits are never silently discarded.
  //  - MEETINGS are the one exception: a local-only meeting the mirror has
  //    never seen is always kept. That heuristic above assumes both sides sync
  //    the same collection, so "old + missing remotely" can only mean a remote
  //    delete — but meetings were never syncable at all, so an empty meeting
  //    mirror is the normal state, not evidence of a lost one. Applying the
  //    rule here would silently destroy every meeting created before this fix
  //    on the first pull; the next push then publishes them for the first time.
  //    The guard is deliberately NOT applied to projects/tasks: there a missing
  //    mirror really does mean "we lost our mirror" (cleared storage), and
  //    trusting it would stop remote deletions from ever being applied, so
  //    deleted records would come back to life on every device.
  function mergeWithLocal(remoteObj) {
    var merged = PMS.utils.deepClone(PMS.store.data);
    var remoteAt = remoteObj.meta && remoteObj.meta.updatedAt;
    COLLECTIONS.forEach(function (cname) {
      var incoming = remoteObj[cname] || [];
      var existing = merged[cname] || [];
      // Every synced collection carries a baseline of what this device has
      // actually published, so "not in the mirror" means "the cloud has never
      // seen this record". Such a record must never be judged by the
      // remote-clock heuristic below: that heuristic is meant to detect a
      // record a remote writer DELETED, and treating a never-uploaded local
      // record that way destroys work silently (a task a manager created in a
      // pillar they do not manage was lost exactly this way). This covers the
      // reference collections too now: a person added here and not yet pushed
      // must not be dropped because another device happened to save first.
      // The guard only ever KEEPS records - a remote delete still lands through
      // the `incoming.some(...)` test - and the baseline is rebuilt from the raw
      // remote snapshot on every successful pull, so a cleared mirror
      // self-heals on the next sync instead of freezing deletions forever.
      var recMirror = mirrorFor(cname);
      // Reference collections are merged by the same baseline-aware routine the
      // PUSH uses, not by the generic id+updatedAt rule below. Two reasons:
      // a custom field definition carries no usable clock of its own, and "the
      // cloud has this id and I do not" is precisely the shape of a record this
      // device deleted. The generic rule could only read that as somebody else's
      // addition and re-added it, so every custom field removed here came back
      // from the cloud on the next pull - which is what a refresh then showed,
      // long before the push that was meant to carry the delete had landed.
      if (WHOLE_COLS.indexOf(cname) !== -1) {
        merged[cname] = mergeWholeCol(cname, existing, incoming, recMirror);
        return;
      }
      incoming.forEach(function (item) {
        var idx = -1;
        for (var i = 0; i < existing.length; i++) {
          if (existing[i].id === item.id) { idx = i; break; }
        }
        if (idx === -1) { existing.push(item); return; }
        if (!isNewer(existing[idx].updatedAt, item.updatedAt)) existing[idx] = item;
      });
      merged[cname] = existing.filter(function (e) {
        if (recMirror && !recMirror[e.id]) return true;   // never published -> keep
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
        // This device has never adopted the shared dataset, so its local copy is
        // a fresh seed, not an edit. Publishing it would delete every record
        // another user has added - which is exactly what happened when the app
        // was opened in a browser it had never run in before. Adopt the cloud
        // instead; the pull marks this device adopted, and from then on ordinary
        // local edits are published normally.
        if (!adoptedClock()) {
          console.info("[cloudsync] first run on this device: adopting the shared dataset instead of publishing the local seed");
          return pull();
        }
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

  // A report a person can act on, not a console log they have to know to open.
  // Every answer here is a fact the Firestore rules decide, so this is what
  // separates "the rules do not cover this" from "this account may not" from
  // "this device is not signed in" - three problems that look identical from
  // the outside because they all end as "my work is not showing up".
  // Reads only: it never writes, so running it is always safe.
  function diagnose() {
    var report = {
      at: now(),
      configured: isConfigured(),
      enabled: !!enabled,
      signedIn: false,
      email: null,
      cloudUid: null,
      profile: null,
      checks: []
    };
    return waitForSignedIn().then(function (ok) {
      report.signedIn = !!ok;
      if (!ok) {
        report.checks.push({ name: "cloud.diag.signedIn", ok: false });
        return report;
      }
      try {
        var app = window.firebase.apps.find(function (a) { return a.name === APP_NAME; });
        var cu = app ? window.firebase.auth(app).currentUser : null;
        report.email = cu && cu.email;
        report.cloudUid = cu && cu.uid;
      } catch (e) { /* no firebase globals: the signedIn check already said no */ }
      return ensureReady().then(function () {
        var uid = report.cloudUid;
        // The single most important fact: is there a cloud profile at all? Every
        // read and write rule in the set is gated on it (isTeamMember /
        // isActiveUser), so a missing or inactive profile denies EVERYTHING
        // while the app still looks signed in.
        return cloudUserRef(uid).get().then(function (s) {
          if (!s.exists) {
            report.profile = { exists: false };
            report.checks.push({ name: "cloud.diag.profileMissing", ok: false, detail: uid });
            return null;
          }
          var p = s.data() || {};
          report.profile = {
            exists: true,
            role: p.role || null,
            active: p.active === undefined ? "(unset)" : p.active,
            personId: p.personId || null
          };
          report.checks.push({ name: "cloud.diag.profileOk", ok: true, detail: (p.role || "?") + (p.personId ? " / " + p.personId : "") });
          return null;
        }, function (e) {
          report.checks.push({ name: "cloud.diag.profileRead", ok: false, detail: errText(e) });
          return null;
        });
      }).then(function () {
        var targets = [
          ["zms_meta/state", function () { return stateRef(); }],
          ["zms_tasks", function () { return recordCol("tasks"); }],
          ["zms_projects", function () { return recordCol("projects"); }],
          ["zms_meetings", function () { return recordCol("meetings"); }],
          ["zms_activities", function () { return recordCol("activities"); }],
          ["zms_people/data", function () { return colRef("people"); }]
        ];
        return targets.reduce(function (chain, target) {
          return chain.then(function () {
            return target[1]().get().then(function (qs) {
              var n = 0;
              if (typeof qs.forEach === "function") qs.forEach(function () { n++; });
              else if (qs.exists) n = 1;
              report.checks.push({ name: target[0], ok: true, detail: n + " doc(s)" });
            }, function (e) {
              report.checks.push({ name: target[0], ok: false, detail: errText(e) });
            });
          });
        }, Promise.resolve());
      }).then(function () { return report; }, function (e) {
        report.checks.push({ name: "cloud.diag.error", ok: false, detail: errText(e) });
        return report;
      });
    }, function (e) {
      report.checks.push({ name: "cloud.diag.error", ok: false, detail: errText(e) });
      return report;
    });
  }

  function errText(e) {
    if (!e) return "unknown";
    var code = e.code || "";
    var msg = e.message || String(e);
    return (code ? code + ": " : "") + msg;
  }

  PMS.cloudsync = {
    enable: enable,
    disable: disable,
    boot: boot,
    push: push,
    diagnose: diagnose,
    dataReplaced: dataReplaced,
    pull: pull,
    accountEvents: accountEvents,
    cloudAccounts: cloudAccounts,
    saveBackup: saveBackup,
    listBackups: listBackups,
    loadBackup: loadBackup,
    deleteBackup: deleteBackup,
    trimBackups: trimBackups,
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
    PMS.cloudsync._mergeWholeForTest = mergeWholeCol;
    PMS.cloudsync._adoptedClockForTest = adoptedClock;
    PMS.cloudsync._markAdoptedForTest = markAdopted;
PMS.cloudsync._resolveSignupRoleForTest = resolveSignupRole;
    PMS.cloudsync._getMirrorForTest = mirrorFor;
    PMS.cloudsync._setMirrorForTest = setMirrorFor;
    PMS.cloudsync._writeOpForTest = writeOp;
    PMS.cloudsync._noteDeniedForTest = noteDenied;
  }
})(window.PMS);
