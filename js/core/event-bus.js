/* ==========================================================================
   PMS.bus - Event Bus (publish / subscribe). Views and services subscribe to
   "store:changed" to auto-refresh.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var listeners = Object.create(null);

  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return function () { off(evt, fn); };
  }

  function off(evt, fn) {
    var arr = listeners[evt];
    if (!arr) return;
    if (!fn) { delete listeners[evt]; return; }
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function emit(evt, payload) {
    var arr = listeners[evt];
    if (!arr) return;
    // copy so handlers can safely unsubscribe during emit
    arr.slice().forEach(function (fn) {
      try { fn(payload); }
      catch (e) { if (window.console) console.error("[bus] handler error for " + evt, e); }
    });
  }

  function clear() { for (var k in listeners) delete listeners[k]; }

  PMS.bus = { on: on, off: off, emit: emit, clear: clear };
})(window.PMS);