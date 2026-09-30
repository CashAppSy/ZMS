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
  apiKey: "AIzaSyDeQqbytuAjm7qQpHwSfeXIUmYuXobeQgg",
  authDomain: "test-d371d.firebaseapp.com",
  projectId: "test-d371d",
  storageBucket: "test-d371d.firebasestorage.app",
  messagingSenderId: "549208423494",
  appId: "1:549208423494:web:32cfaa0026f8c7e1ef1e47",
  measurementId: "G-DRYQ6ST8VH"
  };
})(window.PMS);
