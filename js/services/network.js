/* ==========================================================================
   PMS.network - tiny connectivity monitor.
   Tracks navigator.onLine and the browser's online/offline events so the
   loading box (and anything else) can react to a dead/slow connection.
   Emits "network:status" { online } on every change and on start().
   ========================================================================== */
(function (PMS) {
  "use strict";

  var online = (typeof navigator !== "undefined" && navigator.onLine === false) ? false : true;

  function isOnline() {
    return online;
  }

  function emit() {
    PMS.bus.emit("network:status", { online: online });
  }

  function start() {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      emit();
      return;
    }
    window.addEventListener("online", function () { online = true; emit(); });
    window.addEventListener("offline", function () { online = false; emit(); });
    emit();
  }

  PMS.network = {
    isOnline: isOnline,
    start: start
  };

  // test-only: flip connectivity from the test harness (never in a browser)
  if (typeof window !== "undefined" && window.__ZMS_TEST__) {
    PMS.network._setOnline = function (on) {
      online = !!on;
      emit();
    };
  }
})(window.PMS);