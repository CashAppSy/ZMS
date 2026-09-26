/* ==========================================================================
   main.js - bootstrap. Waits for store init, then either shows the login /
   first-run admin setup, or starts the app shell when a session is valid.
   ========================================================================== */
(function (PMS) {
  "use strict";

  function startApp() {
    PMS.authUI.hide();
    PMS.app.init();
    // resurrect the cloud connection (if previously configured) without
    // blocking the shell; pulls any newer shared data.
    if (PMS.cloudsync && PMS.cloudsync.boot) {
      PMS.cloudsync.boot();
    }
  }

  function boot() {
    PMS.store.init().then(function () {
      if (!PMS.auth.configured()) {
        // first run ever: create the admin account first
        PMS.authUI.show(startApp);
      } else if (!PMS.auth.currentUser()) {
        // accounts exist but no valid session -> login
        PMS.authUI.show(startApp);
      } else {
        startApp();
      }
    }).catch(function (err) {
      console.error("Store init failed", err);
      document.getElementById("view-root").innerHTML =
        "<div style='padding:40px;text-align:center;font-family:sans-serif;'>" +
        PMS.utils.escapeHtml(String(err && err.message || err)) + "</div>";
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window.PMS);