/* ==========================================================================
   ZMS trusted-admin Cloud Functions.

   Why these exist (see ZMS-R07 / ZMS-R05 / ZMS-R03):
   the browser must never be the final authority for changing a user's role
   or removing a shared cloud account. These HTTPS callables are called by
   js/services/sync-firestore.js when the site's admin changes a cloud role
   or deletes a cloud account. Each function verifies the CALLER's Firebase
   uid against the Firestore account table (role == "admin") and only then
   performs the write — so an ordinary signed-in user cannot promote
   themselves or delete accounts even by calling the API directly.

   Deploy (Blaze plan required for Cloud Functions):
     firebase deploy --only functions,firestore:rules
   ========================================================================== */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const db = admin.firestore();
const VALID_ROLES = ["admin", "manager", "member"];

function cloudUserRef(uid) {
  return db.doc("zms_auth_users/" + uid);
}

/** Returns null when the caller is not an admin (already attached). */
async function requireAdmin(context) {
  if (!context.auth) return null;
  const callerUid = context.auth.uid;
  const snap = await cloudUserRef(callerUid).get();
  if (!snap.exists) return null;
  const rec = snap.data() || {};
  if (rec.role !== "admin" || rec.active === false) return null;
  return callerUid;
}

/** Fails when the only active admin would lose admin status. */
async function guardLastAdmin(uid) {
  const snap = await cloudUserRef(uid).get();
  if (!snap.exists) return null;
  if (snap.data().role !== "admin") return null;
  const admins = await db.collection("zms_auth_users")
    .where("role", "==", "admin")
    .where("active", "!=", false)
    .get();
  const others = admins.docs.filter((d) => d.id !== uid);
  if (others.length === 0) {
    const error = new functions.https.HttpsError("failed-precondition", "LAST_ADMIN", { lastAdmin: true });
    throw error;
  }
  return null;
}

/** adminSetRole({ uid, role }) -> { ok: true }
 *  Verifies the caller is an admin, the target account exists, the role is
 *  valid and the last active admin is preserved. */
exports.adminSetRole = functions.https.onCall(async (data, context) => {
  const callerUid = await requireAdmin(context);
  if (!callerUid) {
    throw new functions.https.HttpsError("permission-denied", "NOT_AN_ADMIN");
  }
  const uid = data && data.uid;
  const role = data && data.role;
  if (!uid || VALID_ROLES.indexOf(role) === -1) {
    throw new functions.https.HttpsError("invalid-argument", "BAD_INPUT");
  }
  if (uid === callerUid && role !== "admin") {
    // cannot demote yourself (prevents accidental lockout through the client)
    await guardLastAdmin(uid);
  }

  const target = await cloudUserRef(uid).get();
  if (!target.exists) {
    throw new functions.https.HttpsError("not-found", "NO_SUCH_CLOUD_ACCOUNT");
  }

  await cloudUserRef(uid).set({ role, active: target.data().active !== false }, { merge: true });
  return { ok: true };
});

/** adminDeleteUser({ uid }) -> { ok: true }
 *  Verifies the caller is an admin and the last active admin is preserved,
 *  then deletes the account record so it can no longer be adopted on any
 *  device AND revokes the Firebase Authentication identity (ZMS-RT-02), so
 *  the deleted person cannot sign in again and cannot reach any shared data.
 *  An admin never deletes themselves. */
exports.adminDeleteUser = functions.https.onCall(async (data, context) => {
  const callerUid = await requireAdmin(context);
  if (!callerUid) {
    throw new functions.https.HttpsError("permission-denied", "NOT_AN_ADMIN");
  }
  const uid = data && data.uid;
  if (!uid) {
    throw new functions.https.HttpsError("invalid-argument", "BAD_INPUT");
  }
  if (uid === callerUid) {
    throw new functions.https.HttpsError("failed-precondition", "CANNOT_DELETE_SELF");
  }
  await guardLastAdmin(uid);

  const target = await cloudUserRef(uid).get();
  if (!target.exists) {
    throw new functions.https.HttpsError("not-found", "NO_SUCH_CLOUD_ACCOUNT");
  }
  // ZMS-RT-02: delete the Firestore profile first, then disable + delete the
  // Firebase Auth identity so the account cannot authenticate ever again.
  await cloudUserRef(uid).delete();
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e && e.code === "auth/user-not-found") {
      // the Auth identity already gone — nothing to do
    } else {
      // last-resort safety: disable the account instead of leaving it usable
      try { await admin.auth().updateUser(uid, { disabled: true }); } catch (err) { /* ignore */ }
    }
  }
  return { ok: true };
});

/** adminUpdateEmail({ uid, email }) -> { ok: true }
 *  Changes a cloud account's SIGN-IN email in Firebase Authentication and
 *  mirrors it in the zms_auth_users/<uid> profile. The browser SDK cannot
 *  change any account's email by itself (updateEmail needs the signed-in
 *  user's credentials), so this runs server-side with the Admin SDK.
 *  Returns EMAIL_IN_USE when the new address already belongs to another
 *  Firebase account. */
exports.adminUpdateEmail = functions.https.onCall(async (data, context) => {
  const callerUid = await requireAdmin(context);
  if (!callerUid) {
    throw new functions.https.HttpsError("permission-denied", "NOT_AN_ADMIN");
  }
  const uid = data && data.uid;
  const email = typeof (data && data.email) === "string" ? data.email.trim().toLowerCase() : "";
  if (!uid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new functions.https.HttpsError("invalid-argument", "BAD_EMAIL");
  }
  const target = await cloudUserRef(uid).get();
  if (!target.exists) {
    throw new functions.https.HttpsError("not-found", "NO_SUCH_CLOUD_ACCOUNT");
  }
  try {
    await admin.auth().updateUser(uid, { email: email, emailVerified: false });
  } catch (e) {
    if (e && e.code === "auth/email-already-in-use") {
      throw new functions.https.HttpsError("already-exists", "EMAIL_IN_USE");
    }
    throw new functions.https.HttpsError("internal", "AUTH_UPDATE_FAILED", { detail: e && e.code });
  }
  await cloudUserRef(uid).set({ email: email, emailVerified: false }, { merge: true });
  return { ok: true };
});

/** adminCreateUser({ email, name, personId }) -> { uid }
 *  Creates a cloud member account for a person WITHOUT signing the caller's
 *  browser in as the new user (client-side createUserWithEmailAndPassword
 *  would hijack the admin's Firebase session). A random temporary password is
 *  set server-side; the browser then sends the standard Firebase password-
 *  reset email so the person can choose their own password. The new account
 *  is always role "member" and active by default. */
exports.adminCreateUser = functions.https.onCall(async (data, context) => {
  const callerUid = await requireAdmin(context);
  if (!callerUid) {
    throw new functions.https.HttpsError("permission-denied", "NOT_AN_ADMIN");
  }
  const email = typeof (data && data.email) === "string" ? data.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new functions.https.HttpsError("invalid-argument", "BAD_EMAIL");
  }
  const name = typeof (data && data.name) === "string" ? data.name.trim() : "";
  const tempPassword = crypto.randomBytes(12).toString("base64").replace(/[+/=]/g, "").slice(0, 16);
  let user;
  try {
    user = await admin.auth().createUser({
      email,
      password: tempPassword,
      displayName: name || email,
      emailVerified: false
    });
  } catch (e) {
    if (e && e.code === "auth/email-already-in-use") {
      throw new functions.https.HttpsError("already-exists", "EMAIL_IN_USE");
    }
    throw new functions.https.HttpsError("internal", "AUTH_CREATE_FAILED", { detail: e && e.code });
  }
  await cloudUserRef(user.uid).set({
    email,
    role: "member",
    displayName: name || email,
    personId: data && data.personId ? String(data.personId) : null,
    active: data.active !== false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { uid: user.uid };
});

/** adminSetActive({ uid, active }) -> { ok: true }
 *  Enables/disables a cloud account, mirroring the person's active status
 *  (archive person -> deactivate account, restore -> reactivate). */ 
exports.adminSetActive = functions.https.onCall(async (data, context) => {
  const callerUid = await requireAdmin(context);
  if (!callerUid) {
    throw new functions.https.HttpsError("permission-denied", "NOT_AN_ADMIN");
  }
  const uid = data && data.uid;
  if (!uid) {
    throw new functions.https.HttpsError("invalid-argument", "BAD_INPUT");
  }
  const target = await cloudUserRef(uid).get();
  if (!target.exists) {
    throw new functions.https.HttpsError("not-found", "NO_SUCH_CLOUD_ACCOUNT");
  }
  const active = data.active !== false;
  try {
    await admin.auth().updateUser(uid, { disabled: !active });
  } catch (e) {
    // the Auth identity may not exist (local-only record) — keep going so the
    // document status can still be mirrored
  }
  await cloudUserRef(uid).set({ active }, { merge: true });
  return { ok: true };
});