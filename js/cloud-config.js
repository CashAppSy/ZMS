/* ==========================================================================
   PMS.cloudConfig - embedded Firestore connection settings.

   Paste your Firebase Web-app config below (Firebase console -> Project
   settings -> Your apps -> Web app -> "firebaseConfig"). Commit this file to
   the repository and every device that opens the deployed site will connect
   to the same cloud automatically — no per-device setup is ever needed.

   Leave projectId empty to disable cloud sync for this build.

   NOTE: these values are public in every Firebase Web app. Security is
   enforced by Firestore Security Rules, not by hiding this file.
   ========================================================================== */
(function (PMS) {
  "use strict";
  PMS.cloudConfig = {
    projectId: "test-d371d",
    apiKey: "AIzaSyDeQqbytuAjm7qQpHwSfeXIUmYuXobeQgg",
    authDomain: "test-d371d.firebaseapp.com",
    storageBucket: "test-d371d.firebasestorage.app",
    messagingSenderId: "549208423494",
    appId: "1:549208423494:web:32cfaa0026f8c7e1ef1e47",
    measurementId: "G-DRYQ6ST8VH"
  };

  /* Guard against the one mistake that silently breaks cloud sync.
     A web config is only valid as a whole. Swapping the apiKey or the
     projectId between two Firebase projects while leaving the other fields
     alone still parses, still boots, and still shows the data that happens to
     be in this browser's localStorage - but every Firestore request is
     rejected, so nothing is ever saved or shared. The symptom is "my records
     only exist on my own account".

     messagingSenderId is the Firebase project number, so a key and a projectId
     that disagree with it cannot belong to the same project. */
  (function validateConfig(c) {
    if (!c || !c.projectId || !c.apiKey) return; // cloud sync simply disabled
    var problems = [];
    var num = (c.messagingSenderId || "").match(/^(\d+)$/);
    if (num && c.appId && c.appId.indexOf("1:" + num[1] + ":web:") !== 0) {
      problems.push("appId does not belong to messagingSenderId " + num[1]);
    }
    if (num && c.authDomain && c.authDomain !== c.projectId + ".firebaseapp.com") {
      problems.push("authDomain " + c.authDomain + " does not match projectId " + c.projectId);
    }
    if (num && c.storageBucket && c.storageBucket.indexOf(c.projectId + ".") !== 0) {
      problems.push("storageBucket " + c.storageBucket + " does not match projectId " + c.projectId);
    }
    if (problems.length) {
      console.error(
        "[PMS] cloud-config.js is inconsistent - cloud sync will fail:\n  - " +
        problems.join("\n  - ") +
        "\nEvery value in this file must come from the SAME Firebase project " +
        "(Project settings -> Your apps -> Web app)."
      );
    }
  })(PMS.cloudConfig);
})(window.PMS);