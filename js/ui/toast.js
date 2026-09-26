/* ==========================================================================
   PMS.toast - lightweight notification toasts.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;

  function show(message, type, ms) {
    type = type || "info";
    var root = document.getElementById("toast-root");
    var toast = h("div.toast.toast-" + type, { text: message });
    root.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      setTimeout(function () { toast.remove(); }, 180);
    }, ms || 2600);
  }

  PMS.toast = { show: show };
})(window.PMS);