/* ==========================================================================
   PMS.dropdown - reusable dropdown menu (positioned under trigger).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var openMenu = null;
  var cleanup = null;

  function attach(trigger, items, opts) {
    opts = opts || {};
    close();
    var menu = h("div.dropdown-menu" + (opts.alignEnd ? ".align-end" : ""));
    items.forEach(function (item) {
      if (item.separator) {
        menu.appendChild(h("div.dropdown-header", { text: item.header || "" }));
        return;
      }
      var btn = h("button.dropdown-item" + (item.danger ? ".danger" : ""), {
        html: item.html !== undefined ? item.html : (PMS.dom.esc ? item.label : escText(item.label)),
        on: { click: function () { close(); item.onClick && item.onClick(); } }
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);

    var rect = trigger.getBoundingClientRect();
    var mRect = menu.getBoundingClientRect();
    var top = rect.bottom + 4;
    var left = opts.alignEnd ? rect.right - mRect.width : rect.left;
    if (left + mRect.width > window.innerWidth - 8) left = window.innerWidth - mRect.width - 8;
    if (left < 8) left = 8;
    menu.style.top = top + "px";
    menu.style.left = left + "px";
    menu.classList.add("open");
    openMenu = menu;

    function closeSoon(e) {
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
      close();
    }
    var timer = setTimeout(function () {
      document.addEventListener("mousedown", closeSoon);
      document.addEventListener("keydown", escHandler);
    }, 0);
    cleanup = function () {
      clearTimeout(timer);
      document.removeEventListener("mousedown", closeSoon);
      document.removeEventListener("keydown", escHandler);
    };
    return menu;
  }

  function escHandler(e) { if (e.key === "Escape") close(); }

  function escText(s) { return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function close() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }

  PMS.dropdown = { attach: attach, close: close };
})(window.PMS);
