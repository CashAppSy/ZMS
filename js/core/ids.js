/* ==========================================================================
   PMS.ids - unique id generation (UUID v4 with fallback)
   ========================================================================== */
(function (PMS) {
  "use strict";

  var nextRandom = 1;

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    // Fallback: RFC4122 v4-ish
    var b = window.crypto && window.crypto.getRandomValues
      ? window.crypto.getRandomValues(new Uint8Array(16))
      : randomBytes();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(b, function (x) {
      return ("0" + x.toString(16)).slice(-2);
    }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function randomBytes() {
    var b = new Uint8Array(16);
    for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }

  // Short readable id for display (e.g. task numbers)
  function shortId() {
    nextRandom = (nextRandom + 1) % 4294967295;
    return String(nextRandom);
  }

  PMS.ids = { uuid: uuid, short: shortId };
})(window.PMS);