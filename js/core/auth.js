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
    var out = "";
    var alphabet = "abcdef0123456789";
    for (var i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
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
  function readSession() {
    if (SESSION) return SESSION;
    try {
      var raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      SESSION = JSON.parse(raw);
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
  function createUser(opts) {
    opts = opts || {};
    var username = normalizeUsername(opts.username);
    var role = ROLES.indexOf(opts.role) !== -1 ? opts.role : "member";
    if (!configured()) role = "admin"; // first account is always the admin
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
  function isLoggedIn() { return !!currentUser(); }

  /* ---------------- cloud-account bridge ---------------- */
  // Firebase Auth sign-ins are shared across devices; here we keep a slim
  // local record (identity + role only) so existing role gates and person
  // linking keep working. The authoritative password lives in Firebase only.
  // These helpers are fully local (no network), safe for browser + tests.
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

  function adoptUser(id) {
    var u = userById(id);
    if (!u || u.active === false) return null;
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
    hashPassword: hashPassword,
    normalizeUsername: normalizeUsername,
    role: role,
    can: can,
    isAdmin: isAdmin,
    registerCloudUser: registerCloudUser,
    userByCloudUid: userByCloudUid,
    adoptUser: adoptUser,
    _resetSessionForTest: function () { SESSION = null; try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {} }
  };
})(window.PMS);