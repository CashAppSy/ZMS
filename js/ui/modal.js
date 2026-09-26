/* ==========================================================================
   PMS.modal - accessible modal dialog with title, body, footer actions.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var current = null;
  var lastFocused = null;

  function open(opts) {
    close();

    lastFocused = document.activeElement;
    var overlay = h("div.modal-overlay", { on: { mousedown: function (e) { if (e.target === overlay) opts.onClose && opts.onClose(); } } });
    var modal = h("div.modal" + (opts.size ? ".modal-" + opts.size : ""), { attrs: { role: "dialog", "aria-modal": "true" } });
    var header = h("div.modal-header");
    header.appendChild(h("div.modal-title", { text: opts.title }));
    var closeBtn = h("button.modal-close", { text: "✕", attrs: { "aria-label": "close" }, on: { click: function () { close(); } } });
    header.appendChild(closeBtn);

    var body = h("div.modal-body");
    if (typeof opts.content === "function") body.appendChild(opts.content());
    else if (opts.content instanceof Node) body.appendChild(opts.content);
    else body.innerHTML = opts.content || "";

    modal.appendChild(header);
    modal.appendChild(body);

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
    current = { overlay: overlay, modal: modal, body: body, onClose: opts.onClose };

    // focus first input
    var firstInput = modal.querySelector("input,select,textarea,button.btn-primary");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 30);
    else modal.focus && modal.focus();

    document.addEventListener("keydown", onKey);
    return current;
  }

  function close() {
    if (!current) return;
    document.removeEventListener("keydown", onKey);
    current.overlay.remove();
    current = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  PMS.modal = { open: open, close: close, get isOpen() { return !!current; }, get body() { return current && current.body; } };
})(window.PMS);