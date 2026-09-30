/* ==========================================================================
   PMS.auth - local accounts, sessions & role-based permissions.

   Accounts live inside the app data (users[]). Passwords are stored as a
   salted SHA-256 hash (pure-JS so it works on file:// and any static host).

   IMPORTANT (accepted design decision): this is access control at the UI
   layer, NOT real server security. Anyone with the data file or the browser
   console can bypass it. Do not store sensitive secrets in tasks here.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var SESSION_KEY = "pms-auth-session";
  var SESSION = null;

  // Absolute session lifetime: a saved session expires this long after it was
  // created, even when the browser keeps browsing. Cloud identity itself comes
  // from Firebase Auth; this only bounds the local mirror session.
  var SESSION_TTL_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days
  var SESSION_TTL_MS = SESSION_TTL_DEFAULT;

  // Set ONLY by the cloud sync layer after a real Firebase Auth result on this
  // page. adoptUser() refuses to mint a session for a uid that was not just
  // verified, so an id alone is no longer enough to adopt an account.
  var verifiedCloudUid = null;

  function markCloudVerified(uid) { verifiedCloudUid = uid || null; }

  /* ---------------- pure-JS SHA-256 (returns hex) ---------------- */
  function sha256(str) {
    function ROTR(n, x) { return (x >>> n) | (x << (32 - n)); }
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    function toBytes(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) { bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f)); }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
          var hi = code, lo = s.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            var u = ((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
            bytes.push(0xf0 | (u >> 18), 0x80 | ((u >> 12) & 0x3f), 0x80 | ((u >> 6) & 0x3f), 0x80 | (u & 0x3f));
            i++;
          } else { bytes.push(0xef, 0xbf, 0xbd); }
        } else if (code < 0xe000) { bytes.push(0xef, 0xbf, 0xbd); }
        else if (code >= 0xe000 && code < 0x10000) { bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)); }
        else { bytes.push(0xef, 0xbf, 0xbd); }
      }
      return bytes;
    }
    var msg = toBytes(String(str));
    var len = msg.length;
    var bitLen = len * 8;
    var ml = len % 64;
    var extra = ml < 56 ? 64 - ml : 128 - ml;
    var total = len + extra;
    var padded = msg.slice();
    padded.push(0x80);
    for (var p = msg.length + 1; p < total - 8; p++) padded.push(0);
    for (var b = 7; b >= 0; b--) padded.push((bitLen / Math.pow(2, 8 * b)) & 0xff);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (var i = 0; i < padded.length; i += 64) {
      var w = [];
      for (var j = 0; j < 16; j++) {
        w[j] = (padded[i + j * 4] << 24) | (padded[i + j * 4 + 1] << 16) | (padded[i + j * 4 + 2] << 8) | padded[i + j * 4 + 3];
      }
      for (j = 16; j < 64; j++) {
        var s0 = ROTR(7, w[j - 15]) ^ ROTR(18, w[j - 15]) ^ (w[j - 15] >>> 3);
        var s1 = ROTR(17, w[j - 2]) ^ ROTR(19, w[j - 2]) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = H[0], b2 = H[1], c2 = H[2], d2 = H[3], e2 = H[4], f2 = H[5], g2 = H[6], h2 = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = ROTR(6, e2) ^ ROTR(11, e2) ^ ROTR(25, e2);
        var ch = (e2 & f2) ^ (~e2 & g2);
        var t1 = (h2 + S1 + ch + K[j] + w[j]) | 0;
        var S0 = ROTR(2, a) ^ ROTR(13, a) ^ ROTR(22, a);
        var maj = (a & b2) ^ (a & c2) ^ (b2 & c2);
        var t2 = (S0 + maj) | 0;
        h2 = g2; g2 = f2; f2 = e2; e2 = (d2 + t1) | 0; d2 = c2; c2 = b2; b2 = a; a = (t1 + t2) | 0;
      }
      H[0] = (a + H[0]) | 0; H[1] = (b2 + H[1]) | 0; H[2] = (c2 + H[2]) | 0; H[3] = (d2 + H[3]) | 0;
      H[4] = (e2 + H[4]) | 0; H[5] = (f2 + H[5]) | 0; H[6] = (g2 + H[6]) | 0; H[7] = (h2 + H[7]) | 0;
    }
    var hex = "0123456789abcdef";
    var out = "";
    for (var n = 0; n < H.length; n++) {
      for (var sft = 28; sft >= 0; sft -= 4) out += hex[(H[n] >>> sft) & 0xf];
    }
    return out;
  }

  function randomSalt() {
    // ZMS-RT-10: prefer a CSPRNG when available instead of Math.random()
    var alphabet = "abcdef0123456789";
    var out = "", i;
    if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      for (i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % 16];
      return out;
    }
    for (i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }

  function hashPassword(password, salt) {
    return sha256((salt || "") + ":" + (password || ""));
  }

  /* ---------------- permissions ---------------- */
  var ROLE_PERMS = {
    admin: {
      settings: true,
      "users.manage": true,
      "data.manage": true,
      "projects.write": true,
      "people.write": true,
      "tasks.write": true,
      "tasks.writeOwn": true
    },
    manager: {
      "projects.write": true,
      "people.write": true,
      "tasks.write": true,
      "tasks.writeOwn": true
    },
    member: {
      "tasks.writeOwn": true
    }
  };

  var ROLES = ["admin", "manager", "member"];

  /* ---------------- helpers ---------------- */
  function users() { return PMS.store.data.users || []; }

  function userById(id) { return users().find(function (u) { return u.id === id; }) || null; }

  function byUsername(username) {
    var want = String(username || "").trim().toLowerCase();
    if (!want) return null;
    return users().find(function (u) { return (u.username || "").toLowerCase() === want; }) || null;
  }

  function normalizeUsername(username) {
    return String(username || "").trim().replace(/\s+/g, " ");
  }

  // mutate users through the store (undoable, auto-persisted)
  function persist(fn, desc) {
    PMS.store.commit(function (d) { fn(d.users || (d.users = [])); }, desc || "users");
  }

  /* ---------------- session ---------------- */
  function sessionExpired(s) {
    if (!s || !s.at) return true;
    var start = new Date(s.at).getTime();
    if (isNaN(start)) return true;
    return (Date.now() - start) > SESSION_TTL_MS;
  }

  function readSession() {
    if (SESSION) {
      if (sessionExpired(SESSION)) { logout(); return null; }
      return SESSION;
    }
    try {
      var raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      SESSION = JSON.parse(raw);
      if (sessionExpired(SESSION)) { logout(); return null; }
    } catch (e) { SESSION = null; }
    return SESSION;
  }

  function session() {
    var s = readSession();
    if (!s) return null;
    var u = userById(s.userId);
    if (!u || u.active === false) { logout(); return null; }
    return s;
  }

  function currentUser() {
    var s = readSession();
    if (!s) return null;
    var u = userById(s.userId);
    if (!u || u.active === false) { logout(); return null; }
    return u;
  }

  function configured() { return users().length > 0; }

  function login(username, password) {
    var u = byUsername(username);
    if (!u) return { error: "invalid" };
    if (u.active === false) return { error: "inactive" };
    if (hashPassword(password, u.salt) !== u.passwordHash) return { error: "password" };
    SESSION = {
      userId: u.id,
      username: u.username,
      role: u.role,
      personId: u.personId || null,
      at: new Date().toISOString()
    };
    try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION)); } catch (e) {}
    persist(function (us) {
      var x = us.find(function (y) { return y.id === u.id; });
      if (x) x.lastLoginAt = new Date().toISOString();
    }, "login");
    PMS.bus.emit("auth:login", currentUser());
    return { user: currentUser() };
  }

  function logout() {
    SESSION = null;
    try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
    PMS.bus.emit("auth:logout");
  }

  /* ---------------- account management (admin) ---------------- */
  // Authorizes a management operation. The UI already hides these screens from
  // non-admins; these guards add defense-in-depth so a direct call from the
  // console cannot mutate accounts, change roles or reset passwords. The only
  // non-admin exemption is the bootstrap: while NO admin exists at all, the
  // first account may be created (it becomes the admin).
  function adminSession() {
    var u = currentUser();
    return !!(u && u.role === "admin");
  }

  function manageAllowed() {
    if (adminSession()) return true;
    return !users().some(function (u) { return u.role === "admin" && u.active !== false; });
  }

  // Cloud bridge exception: right after a verified Firebase sign-in the local
  // mirror must be able to adopt the verified role and the linked person via
  // updateUser({role, personId}). No id alone is trusted; the cloudUid must
  // match the just-verified sign-in and the patch may touch ONLY role and
  // personId (the fields Firebase carries per account).
  function cloudBridgeAllowed(u, patch) {
    if (!verifiedCloudUid || !u || !u.cloudUid) return false;
    if (u.cloudUid !== verifiedCloudUid) return false;
    var keys = patch ? Object.keys(patch) : [];
    return keys.length <= 2 && keys.every(function (k) { return k === "role" || k === "personId"; });
  }

  function createUser(opts) {
    opts = opts || {};
    if (!manageAllowed()) return { error: "forbidden" };
    var username = normalizeUsername(opts.username);
    // ZMS-R02: the caller can no longer request a role. Later accounts are
    // ALWAYS "member"; only the very first account (bootstrap, when no account
    // exists at all) becomes the admin. Changing a role is an admin-only
    // operation via updateUser() (or the trusted backend functions).
    var role = configured() ? "member" : "admin";
    if (!username) return { error: "username" };
    if (!opts.password || String(opts.password).length < 4) return { error: "password" };
    if (byUsername(username)) return { error: "duplicate" };

    var salt = randomSalt();
    var record = {
      id: PMS.ids.uuid(),
      username: username,
      personId: opts.personId || null,
      name: opts.name || username,
      role: role,
      active: opts.active !== false,
      salt: salt,
      passwordHash: hashPassword(opts.password, salt),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null
    };
    persist(function (us) { us.push(record); }, "add-user");
    return { user: record };
  }

  function updateUser(id, patch) {
    var u = userById(id);
    if (!u) return { error: "notfound" };
    if (!adminSession() && !cloudBridgeAllowed(u, patch)) return { error: "forbidden" };
    patch = patch || {};
    var changes = {};
    if (patch.username !== undefined) {
      var username = normalizeUsername(patch.username);
      if (!username) return { error: "username" };
      var dup = byUsername(username);
      if (dup && dup.id !== id) return { error: "duplicate" };
      changes.username = username;
      if (SESSION && SESSION.userId === id) SESSION.username = username;
    }
    if (patch.personId !== undefined) changes.personId = patch.personId || null;
    if (patch.name !== undefined) changes.name = patch.name || "";
    if (patch.role !== undefined && ROLES.indexOf(patch.role) !== -1) {
      // never allow removing the last active admin
      var admins = users().filter(function (x) { return x.role === "admin" && x.active !== false && x.id !== id; });
      if (patch.role !== "admin" && admins.length === 0) return { error: "lastAdmin" };
      changes.role = patch.role;
      if (SESSION && SESSION.userId === id) SESSION.role = patch.role;
    }
    if (patch.active !== undefined) {
      // cannot deactivate the last active admin (including self)
      var willDeactivate = patch.active === false && u.role === "admin" && u.active !== false;
      var otherAdmins = users().filter(function (x) { return x.role === "admin" && x.active !== false && x.id !== id; });
      if (willDeactivate && otherAdmins.length === 0) return { error: "lastAdmin" };
      changes.active = patch.active === true;
      if (SESSION && SESSION.userId === id && changes.active === false) logout();
    }
    if (!Object.keys(changes).length) return { ok: true, user: u };
    persist(function (us) {
      var target = us.find(function (x) { return x.id === id; });
      if (target) Object.keys(changes).forEach(function (k) { target[k] = changes[k]; });
      if (target) target.updatedAt = new Date().toISOString();
    }, "update-user");
    return { ok: true, user: userById(id) };
  }

  function resetPassword(id, newPassword) {
    var u = userById(id);
    if (!u) return { error: "notfound" };
    if (!adminSession()) return { error: "forbidden" };
    if (!newPassword || String(newPassword).length < 4) return { error: "password" };
    var salt = randomSalt();
    persist(function (us) {
      var target = us.find(function (x) { return x.id === id; });
      if (target) {
        target.salt = salt;
        target.passwordHash = hashPassword(newPassword, salt);
        target.updatedAt = new Date().toISOString();
      }
    }, "reset-password");
    return { ok: true };
  }

  function removeUser(id) {
    var u = userById(id);
    if (!u) return { error: "notfound" };
    if (!adminSession()) return { error: "forbidden" };
    if (SESSION && SESSION.userId === id) return { error: "self" };
    if (u.role === "admin" && u.active !== false) {
      var otherAdmins = users().filter(function (x) { return x.role === "admin" && x.active !== false && x.id !== id; });
      if (otherAdmins.length === 0) return { error: "lastAdmin" };
    }
    persist(function (us) {
      var i = us.indexOf(us.find(function (x) { return x.id === id; }));
      if (i !== -1) us.splice(i, 1);
    }, "remove-user");
    return { ok: true };
  }

  /* ---------------- permission checks ---------------- */
  function role() {
    var u = currentUser();
    return u ? u.role : null;
  }

  function can(perm) {
    var u = currentUser();
    if (!u) return false;
    return !!(ROLE_PERMS[u.role] && ROLE_PERMS[u.role][perm]);
  }

  function isAdmin() { return role() === "admin"; }

  function currentPersonId() {
    var u = currentUser();
    return u ? (u.personId || null) : null;
  }

  function isAssignee(task) {
    if (!task) return false;
    var pid = currentPersonId();
    if (!pid) return false;          // an account with no linked person owns nothing
    return (task.assignees || []).indexOf(pid) !== -1;
  }

  // Is the signed-in user the manager of this project (via their linked person)?
  function managesProject(project) {
    return !!(project && project.managerId && currentPersonId() && project.managerId === currentPersonId());
  }

  // Which tasks is a member allowed to SEE? Admins and managers: all of them.
  // A member: the ones assigned to them, plus the ones they created (their own
  // work must not disappear from under them). This is the visibility rule;
  // canEditTask below decides who may change them.
  function canViewTask(task) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin" || u.role === "manager") return true;
    if (!task) return false;
    if (isAssignee(task)) return true;
    if (task.createdBy && u.id && task.createdBy === u.id) return true;
    if (task.createdByPersonId && currentPersonId() && task.createdByPersonId === currentPersonId()) return true;
    return false;
  }

  // Which meetings is a member allowed to SEE? The ones they attended, plus
  // the ones they created. Managers and admins see every meeting.
  function canViewMeeting(meeting) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin" || u.role === "manager") return true;
    if (!meeting) return false;
    if ((meeting.attendees || []).indexOf(currentPersonId()) !== -1) return true;
    if (meeting.createdBy && u.id && meeting.createdBy === u.id) return true;
    if (meeting.createdByPersonId && currentPersonId() && meeting.createdByPersonId === currentPersonId()) return true;
    return false;
  }

  // Full task CRUD (every field). Admins and managers: EVERY task. Members:
  // only the tasks assigned to them.
  //
  // A manager may edit any task, in a pillar they do not manage, for the same
  // reason they may create one anywhere (canCreateTask): a task is shared team
  // work, and a manager who cannot correct someone else's task can only report
  // the problem. Deletion stays deliberately narrower — a manager may remove
  // only what they created (canDeleteRecord) — so this widens editing without
  // handing anyone the power to destroy another manager's data.
  function canEditTask(task) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin" || u.role === "manager") return true;
    if (isAssignee(task)) return true;
    return false;
  }

  // May the current user change the STATUS of this task/subtask?
  // Admins and managers: any task (managers own every pillar — including an
  // UNASSIGNED task, which nobody else can act on). Members: their own tasks.
  function canChangeStatus(task) {
    var u = currentUser();
    if (!u || !task) return false;
    if (u.role === "admin") return true;
    if (isAssignee(task)) return true;
    if (u.role === "manager") return true;
    return false;
  }

  // May the current user create a task? Admins: any pillar. Managers: any
  // pillar too (an unassigned task belongs to nobody, so it must be
  // assignable/reachable from every pillar). Members: never.
  function canCreateTask(projectId) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin" || u.role === "manager") return true;
    return false;
  }

  // Meetings are created/edited by admins and managers; members read them and
  // may create the tasks that come out of them (if they may create tasks).
  function canCreateMeeting() {
    var u = currentUser();
    if (!u) return false;
    return u.role === "admin" || u.role === "manager";
  }

  function canEditMeeting(meeting) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin" || u.role === "manager") return true;
    return false;
  }

  // May the current user open the FULL project editor? Admins: any project.
  // Managers: only projects where they are the manager. Creating a new project
  // is always allowed for a manager (they become its default manager).
  function canEditProject(project) {
    var u = currentUser();
    if (!u) return false;
    if (u.role === "admin") return true;
    if (u.role === "manager") {
      if (!project) return true;
      return managesProject(project);
    }
    return false;
  }

  // Confirms the current admin session by re-entering the local password
  // (used before destructive operations like restore/import-replace).
  // Returns:
  //   true  - the password is correct (or the session is not locally verifiable)
  //   false - the password is wrong
  // Sessions backed by a cloud account cannot be re-verified locally (their
  // true password lives in Firebase Auth), so they pass identity through the
  // already-established Firebase session.
  function reauthenticateAdmin(password) {
    var u = currentUser();
    if (!u || u.role !== "admin") return false;
    if (u.passwordHash && String(u.passwordHash).indexOf("cloud::") === 0) return true;
    return !!u.salt && u.passwordHash === hashPassword(password || "", u.salt);
  }

  // Deleting data (projects, tasks, people, departments, definitions, ...) is
  // reserved for the admin alone, no matter what per-view edit permission the
  // signed-in user has.
  function canDelete() { return role() === "admin"; }

  // Who made this record? Compared by account id first, then by linked person
  // so the check still holds on another device, where the local account id is
  // not the one that stamped the record.
  function createdByCurrentUser(rec) {
    if (!rec) return false;
    var u = currentUser();
    if (!u) return false;
    if (rec.createdBy && u.id && rec.createdBy === u.id) return true;
    if (rec.createdByPersonId && currentPersonId() && rec.createdByPersonId === currentPersonId()) return true;
    return false;
  }

  // May this user delete THIS record? Admins may delete anything. A manager may
  // delete only what they created themselves — a task, pillar or meeting they
  // authored, not one inherited from another manager or the admin. A member
  // may never delete. Callers must pass the record: the old argument-less
  // canDelete() stays the broad "admin only" answer for the global destructive
  // actions (erase all data, restore, definitions) that have no single owner.
  function canDeleteRecord(rec) {
    var r = role();
    if (r === "admin") return true;
    if (r === "manager") return createdByCurrentUser(rec);
    return false;
  }

  // Gate used by delete entry points: returns true for the admin, otherwise
  // explains via a toast and returns false. When a record is passed, a manager
  // is allowed through for a record they created (canDeleteRecord).
  function requireDelete(rec) {
    if (canDeleteRecord(rec)) return true;
    if (PMS.toast && PMS.toast.show) {
      var msg = (PMS.i18n && PMS.i18n.t) ? PMS.i18n.t("auth.deleteForbidden") : "Only the admin can delete data.";
      PMS.toast.show(msg, "error");
    }
    return false;
  }
  function isLoggedIn() { return !!currentUser(); }

  /* ---------------- strict re-authentication for sensitive actions ----------------
     Sensitive bulk operations ("load demo data", "erase all data", whole-data
     "Upload now"/"Download now", backup restore) must always be re-confirmed
     with the admin password — even for cloud admins, whose password is verified
     against Firebase (reauthenticateWithCredential). A successful re-auth mints
     a ONE-SHOT token that the underlying command consumes, so the command cannot
     be invoked from the console without a freshly verified admin password. Test
     runs bypass the token via window.__ZMS_TEST__ (set only by tests/). */
  var sensitiveFresh = false;

  function markFreshAdmin() { sensitiveFresh = true; }
  function consumeFreshAdmin() {
    if (typeof window !== "undefined" && window.__ZMS_TEST__) return true;
    var ok = sensitiveFresh;
    sensitiveFresh = false;
    return ok;
  }

  // Re-verifies a cloud admin's session by asking Firebase to reauthenticate
  // the signed-in user with the supplied password. Resolves true only on a
  // genuine Firebase-verified success; also refreshes the recent-login stamp.
  function reauthCloudSession(raw) {
    if (!(PMS.cloudsync && PMS.cloudsync.auth)) return Promise.resolve(false);
    return PMS.cloudsync.auth().then(function (auth) {
      var cu = auth ? auth.currentUser : null;
      if (!cu || !cu.email) return false;
      var provider = window.firebase && window.firebase.auth && window.firebase.auth.EmailAuthProvider;
      if (!provider) return false;
      return cu.reauthenticateWithCredential(provider.credential(cu.email, raw))
        .then(function () { return true; })
        .catch(function () { return false; });
    }).catch(function () { return false; });
  }

  // Always asks the admin for their password before calling onOk, regardless of
  // whether the session is local (hash) or cloud-backed (Firebase). Nothing runs
  // on a wrong/cancelled password. The fresh token is cleared right after onOk
  // so every action requires its own confirmation.
  function confirmSensitive(onOk) {
    var u = currentUser();
    if (!u || u.role !== "admin") {
      if (PMS.toast && PMS.toast.show) PMS.toast.show(PMS.i18n.t("confirm.sensitiveForbidden"), "error");
      return;
    }
    var isCloud = !!(u.passwordHash && String(u.passwordHash).indexOf("cloud::") === 0);
    if (!(PMS.i18n && PMS.modal && PMS.dom)) {
      // UI layer not present (edge/remote call): never auto-grant, refuse loudly.
      if (PMS.toast && PMS.toast.show) PMS.toast.show(PMS.i18n.t("confirm.sensitiveRequired"), "error");
      return;
    }
    var h = PMS.dom.h;
    var pw = h("input", { type: "password", name: "pw", placeholder: "••••••••", required: true, attrs: { autocomplete: "current-password" } });
    pw.classList.add("input");
    pw.classList.add("input-block");
    var wrap = h("div.field");
    wrap.appendChild(h("label.form-label", { text: PMS.i18n.t("confirm.adminReauth") }));
    wrap.appendChild(pw);
    PMS.modal.open({
      title: PMS.i18n.t("confirm.title"),
      content: wrap,
      footer: [
        { label: PMS.i18n.t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: PMS.i18n.t("confirm.continue"), class: "btn-primary",
          onClick: function () {
            var done = function (ok) {
              if (!ok) { PMS.toast.show(PMS.i18n.t("auth.invalidCredentials"), "error"); return; }
              PMS.modal.close();
              markFreshAdmin();
              try { onOk(); } finally { sensitiveFresh = false; }
            };
            if (isCloud) reauthCloudSession(pw.value).then(done);
            else done(!!reauthenticateAdmin(pw.value));
          }
        }
      ]
    });
  }

  /* ---------------- cloud-account bridge ---------------- */
  // Firebase Auth sign-ins are shared across devices; here we keep a slim
  // local record (identity + role only) so existing role gates and person
  // linking keep working. The authoritative password lives in Firebase only.
  // These helpers are fully local (no network), safe for browser + tests.
  //
  // ZMS-RT-03: these helpers are NOT exposed on PMS.auth. They live on a
  // separate PMS.cloudBridge namespace and are only ever called by the cloud
  // login flow (js/views/auth.js, js/services/sync-firestore.js) which passes
  // them values that already came from a real Firebase Auth result.
  function registerCloudUser(opts) {
    var now = new Date().toISOString();
    var rec = {
      id: opts.id || PMS.ids.uuid(),
      username: String(opts.username || "").trim().toLowerCase(),
      name: opts.name || String(opts.username || "").trim(),
      role: ROLES.indexOf(opts.role) !== -1 ? opts.role : "member",
      cloudUid: opts.cloudUid || null,
      passwordHash: "cloud::" + (opts.cloudUid || rec.id),
      salt: "",
      linkedToCloud: !!opts.cloudUid,
      personId: opts.personId || null,
      active: opts.active !== false,
      createdAt: now
    };
    persist(function (us) { us.push(rec); }, "register-cloud");
    return rec;
  }

  function userByCloudUid(uid) {
    if (!uid) return null;
    return users().find(function (u) { return u.cloudUid === uid; }) || null;
  }

  // A person has at most one login account (created from the person editor).
  // Returns the linked account for a person id, or null.
  function userByPersonId(personId) {
    if (!personId) return null;
    return users().find(function (u) { return u.personId === personId; }) || null;
  }

  function adoptUser(opts) {
    // SECURITY: creating a session from an id alone was a bypass (reported as
    // ZMS-01). Adopting now requires { id, cloudUid } where the cloudUid has to
    // match BOTH the target record AND a uid that a real Firebase Auth result
    // on this page just verified (markCloudVerified).
    if (!opts || !opts.id || !opts.cloudUid) return null;
    var u = userById(opts.id);
    if (!u || u.active === false || !u.cloudUid) return null;
    if (u.cloudUid !== opts.cloudUid) return null;
    if (!verifiedCloudUid || verifiedCloudUid !== opts.cloudUid) return null;
    SESSION = {
      userId: u.id,
      username: u.username,
      role: u.role,
      personId: u.personId || null,
      at: new Date().toISOString()
    };
    try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION)); } catch (e) {}
    persist(function (us) {
      var x = us.find(function (y) { return y.id === u.id; });
      if (x) x.lastLoginAt = new Date().toISOString();
    }, "login");
    PMS.bus.emit("auth:login", currentUser());
    return currentUser();
  }

PMS.auth = {
    roles: ROLES,
    rolePermissions: ROLE_PERMS,
    configured: configured,
    session: session,
    currentUser: currentUser,
    isLoggedIn: isLoggedIn,
    login: login,
    logout: logout,
    createUser: createUser,
    updateUser: updateUser,
    resetPassword: resetPassword,
    removeUser: removeUser,
    users: users,
    userById: userById,
    byUsername: byUsername,
    userByPersonId: userByPersonId,
    hashPassword: hashPassword,
    normalizeUsername: normalizeUsername,
    role: role,
    can: can,
    isAdmin: isAdmin,
    currentPersonId: currentPersonId,
    managesProject: managesProject,
    canEditTask: canEditTask,
    canViewTask: canViewTask,
    canViewMeeting: canViewMeeting,
    canChangeStatus: canChangeStatus,
    canCreateTask: canCreateTask,
    canCreateMeeting: canCreateMeeting,
    canEditMeeting: canEditMeeting,
    canEditProject: canEditProject,
    canDelete: canDelete,
    requireDelete: requireDelete,
    canDeleteRecord: canDeleteRecord,
    createdByCurrentUser: createdByCurrentUser,
    reauthenticateAdmin: reauthenticateAdmin,
    // ZMS-R16: sensitive-action gate (local + cloud admin password).
    confirmSensitive: confirmSensitive,
    markFreshAdmin: markFreshAdmin,
    consumeFreshAdmin: consumeFreshAdmin
  };
  // ZMS-RT-03: no auth-bridge helpers here. The cloud bridge lives on
  // PMS.cloudBridge (below) and only the cloud login flow calls it.

  // Bridge surface for the cloud login flow ONLY. Kept separate from PMS.auth
  // so nothing security-sensitive is discoverable on the main API object.
  PMS.cloudBridge = {
    markVerified: markCloudVerified,
    register: registerCloudUser,
    userByCloudUid: userByCloudUid,
    adopt: adoptUser
  };
  // ZMS-RT-03 / test-only: session-twiddling hooks are reachable only under
  // the test harness (window.__ZMS_TEST__ is set by tests/, never by a real
  // browser), so PMS.auth carries no session-bypass surface in the app.
  if (typeof window !== "undefined" && window.__ZMS_TEST__) {
    PMS.auth._setSessionTTLForTest = function (ms) { SESSION_TTL_MS = (ms === undefined || ms === null) ? SESSION_TTL_DEFAULT : ms; };
    PMS.auth._resetSessionForTest = function () { SESSION = null; try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {} };
  }
})(window.PMS);