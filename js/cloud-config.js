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
    apiKey: "AIzaSyCSHOLGz3uqlWB4kVUWJ1-HKvNcFickwKI",
    authDomain: "zain-management-tool.firebaseapp.com",
    storageBucket: "zain-management-tool.firebasestorage.app",
    messagingSenderId: "1052847513214",
    appId: "1:1052847513214:web:4b790a6a07579e9590c22f",
    measurementId: "G-4QY26NZXF8"
  };
})(window.PMS);