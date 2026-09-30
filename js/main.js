/* ==========================================================================
   main.js - bootstrap. Waits for store init, then either shows the login /
   first-run admin setup, or starts the app shell when a session is valid.
   ========================================================================== */
(function (PMS) {
  "use strict";

  // Any failure between signing in and the first paint used to leave the page
  // blank until a manual refresh. Report it in place instead, and try again
  // once, so the app always ends up usable.
  function fatal(where, err) {
    console.error("[boot] " + where + " failed:", err);
    var host = document.getElementById("view-root") || document.getElementById("auth-root");
    if (!host) return;
    var msg = String((err && err.message) || err);
    var existing = host.querySelector(".boot-error");
    if (existing) existing.querySelector("p").textContent = msg;
    else {
      var box = document.createElement("div");
      box.className = "empty-state boot-error";
      box.innerHTML =
        "<div class='empty-icon'>⚠️</div>" +
        "<h3>" + PMS.utils.escapeHtml(PMS.i18n.t("errors.startFailed")) + "</h3>" +
        "<p></p>";
      box.querySelector("p").textContent = msg;
      var btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.textContent = PMS.i18n.t("common.retry");
      btn.addEventListener("click", function () { window.location.reload(); });
      box.appendChild(btn);
      host.appendChild(box);
    }
  }

  function startApp() {
    try {
      PMS.authUI.hide();
      PMS.app.init();
    } catch (e) {
      fatal("opening the app", e);
      return;
    }
    // resurrect the cloud connection (if previously configured) without
    // blocking the shell; pulls any newer shared data.
    if (PMS.cloudsync && PMS.cloudsync.boot) {
      try {
        var p = PMS.cloudsync.boot();
        if (p && p.catch) p.catch(function (e) { console.error("[boot] cloud boot rejected:", e); });
      } catch (e) { console.error("[boot] cloud boot threw:", e); }
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
      fatal("reading the saved data", err);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window.PMS);