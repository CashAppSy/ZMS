/* ==========================================================================
   PMS.modal - accessible modal dialog with title, body, footer actions.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var current = null;
  var lastFocused = null;
  var nextId = 0;

  function open(opts) {
    close();

    lastFocused = document.activeElement;
    var titleId = "modal-title-" + (++nextId);
    var overlay = h("div.modal-overlay", { on: { mousedown: function (e) { if (e.target === overlay) close(); } } });
    var modal = h("div.modal" + (opts.size ? ".modal-" + opts.size : ""), { attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" } });
    var header = h("div.modal-header");
    header.appendChild(h("div.modal-title", { id: titleId, text: opts.title }));
    var closeBtn = h("button.modal-close", { type: "button", text: "✕", attrs: { "aria-label": PMS.i18n.t("common.close") }, on: { click: function () { close(); } } });
    header.appendChild(closeBtn);

    var body = h("div.modal-body");
    if (typeof opts.content === "function") body.appendChild(opts.content());
    else if (opts.content instanceof Node) body.appendChild(opts.content);
    else body.innerHTML = opts.content || "";

    modal.appendChild(header);
    modal.appendChild(body);

    // An optional line between the body and the actions, for explaining an
    // option that is deliberately NOT offered (e.g. "you may delete only what
    // you created"). Absent actions with no explanation read as a broken app.
    if (opts.note) modal.appendChild(h("div.modal-note", { text: opts.note }));

    var footer = h("div.modal-footer");
    if (opts.footer) {
      opts.footer.forEach(function (btn) {
        footer.appendChild(h("button.btn" + (btn.class ? "." + btn.class.replace(/\s+/g, ".") : ""), {
          text: btn.label,
          on: { click: function () { btn.onClick && btn.onClick(modal, body); } },
          disabled: btn.disabled
        }));
      });
    }
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.getElementById("modal-root").appendChild(overlay);
    var background = Array.from(document.body.children).filter(function (el) { return !el.contains(overlay); }).map(function (el) {
      var previous = el.inert;
      el.inert = true;
      return { el: el, previous: previous };
    });
    current = { overlay: overlay, modal: modal, body: body, onClose: opts.onClose, background: background };

    // focus first input
    var firstInput = modal.querySelector("input,select,textarea,button.btn-primary");
    (firstInput || closeBtn || modal).focus();

    document.addEventListener("keydown", onKey);
    return current;
  }

  function close() {
    if (!current) return;
    var closing = current;
    current = null;
    document.removeEventListener("keydown", onKey);
    closing.overlay.remove();
    closing.background.forEach(function (item) { item.el.inert = item.previous; });
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    if (closing.onClose) closing.onClose();
  }

  function onKey(e) {
    if (!current) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    var items = Array.from(current.modal.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")).filter(function (el) {
      return !el.disabled && el.tabIndex >= 0 && !el.hidden && !el.closest('[hidden], [inert]') && window.getComputedStyle(el).display !== "none";
    });
    var first = items[0], last = items[items.length - 1];
    if (!first) { e.preventDefault(); current.modal.focus(); }
    else if (e.shiftKey && (document.activeElement === first || !current.modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !current.modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  PMS.modal = { open: open, close: close, get isOpen() { return !!current; }, get body() { return current && current.body; } };
})(window.PMS);
