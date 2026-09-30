/* ==========================================================================
   PMS.app - bootstrap + shell (sidebar nav, topbar, save status, shortcuts,
   theme & locale application). Called by main.js once DOM is ready.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var searchInput = null;
  var saveLabel = null;
  var started = false;
  var profileBuilt = false;

  function buildProfile() {
    var sidebar = document.getElementById("sidebar");
    var existing = sidebar.querySelector(".sidebar-profile");
    if (existing) existing.remove();
    profileBuilt = false;
    var u = PMS.auth ? PMS.auth.currentUser() : null;
    if (!u) return;
    var profile = h("div.sidebar-profile");
    var avatar = PMS.vformat.avatar({ id: u.id, name: PMS.authUI.displayName(u) }, "md");
    var info = h("div.sp-info");
    info.appendChild(h("div.sp-name", { text: PMS.authUI.displayName(u) }));
    info.appendChild(h("div.sp-role", { text: PMS.i18n.t("auth.role." + u.role) }));
    profile.appendChild(avatar);
    profile.appendChild(info);
    var logoutBtn = h("button.btn.btn-sm.btn-icon", { text: "⏻", attrs: { title: t("auth.logout") }, on: { click: function () {
      PMS.auth.logout();
      PMS.router.navigate("/");
      hideShell();
      PMS.authUI.show(showShell);
    } } });
    profile.appendChild(logoutBtn);
    sidebar.appendChild(profile);
    profileBuilt = true;
  }

  function buildSidebar() {
    var sidebar = document.getElementById("sidebar");
    sidebar.innerHTML = "";
    // brand
    sidebar.appendChild(h("div.sidebar-brand", [
      h("span.brand-logo", { text: "PM" }),
      h("span", { text: t("app.name") })
    ]));
    var nav = h("nav.sidebar-nav", { attrs: { "aria-label": "Main" } });
    PMS.registry.allViews().filter(function (v) { return v.nav; }).forEach(function (v) {
      if (v.adminOnly && (!PMS.auth || !PMS.auth.can("settings"))) return;
      var item = h("button.nav-item", {
        dataset: { route: v.path },
        html: (v.icon ? "<span class='nav-icon'>" + PMS.utils.escapeHtml(v.icon) + "</span>" : "") + "<span>" + PMS.utils.escapeHtml(t(v.titleKey)) + "</span>"
      });
      item.addEventListener("click", function () { PMS.router.navigate(item.dataset.route); });
      nav.appendChild(item);
    });
    sidebar.appendChild(nav);
    PMS.bus.on("route:changed", function (info) {
      sidebar.querySelectorAll(".nav-item").forEach(function (el) {
        el.classList.toggle("active", el.dataset.route === info.path || (info.path === "/" && el.dataset.route === "/"));
      });
    });
    buildProfile();
  }

  function buildTopbar() {
    var topbar = document.getElementById("topbar");
    topbar.innerHTML = "";

    // mobile menu toggle
    var menuBtn = h("button.btn.btn-icon", { text: "☰", on: { click: toggleSidebar } });
    topbar.appendChild(menuBtn);

    var title = h("div.topbar-title");
    PMS.bus.on("route:changed", function (info) {
      var v = PMS.registry.getView(info.viewId);
      title.textContent = v ? t(v.titleKey) : t("app.name");
    });
    topbar.appendChild(title);

    // search box (global, routes to tasks with query)
    var searchWrap = h("div.search-box");
    searchInput = h("input", { type: "text", placeholder: t("search.placeholder"), id: "app-search" });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var q = searchInput.value;
        PMS.router.navigate("/tasks?q=" + encodeURIComponent(q));
      }
    });
    searchWrap.appendChild(h("span", { text: "🔍" }));
    searchWrap.appendChild(searchInput);
    topbar.appendChild(searchWrap);

    // save indicator
    var saveInd = h("div.save-indicator", { attrs: { id: "save-indicator", title: t("settings.saveIndicator") } });
    saveInd.appendChild(h("span.dot"));
    saveLabel = h("span", { text: t("save.saved") });
    saveInd.appendChild(saveLabel);
    topbar.appendChild(saveInd);

    // undo / redo
    var undoBtn = h("button.btn.btn-sm.btn-ghost", { text: "↩", attrs: { title: t("common.undo") + " (Ctrl+Z)", id: "btn-undo" }, on: { click: function () { PMS.store.undo(); } } });
    var redoBtn = h("button.btn.btn-sm.btn-ghost", { text: "↪", attrs: { title: t("common.redo") + " (Ctrl+Y)", id: "btn-redo" }, on: { click: function () { PMS.store.redo(); } } });
    var actions = h("div.topbar-actions");
    actions.appendChild(undoBtn);
    actions.appendChild(redoBtn);
    // language toggle
    var langBtn = h("button.btn.btn-sm.btn-ghost", { text: PMS.i18n.getLang() === "ar" ? "EN" : "ع", attrs: { title: t("common.language") }, on: { click: function () { toggleLanguage(); } } });
    actions.appendChild(langBtn);
    // theme toggle
    var themeBtn = h("button.btn.btn-sm.btn-ghost", { text: "🌓", attrs: { title: t("settings.theme") }, on: { click: function () { toggleTheme(); } } });
    actions.appendChild(themeBtn);

    topbar.appendChild(actions);

    // save status events
    PMS.bus.on("save:starting", function () { saveInd.className = "save-indicator"; saveLabel.textContent = t("save.saving"); });
    PMS.bus.on("save:done", function () { saveInd.classList.add("ok"); saveLabel.textContent = t("save.saved"); });
    PMS.bus.on("save:error", function (e) {
      var msg = (e && e.message) || "";
      saveInd.classList.add("err");
      saveLabel.textContent = t("save.error");
      console.error("[save] persistence failed:", msg);
      PMS.toast.show(t("save.error") + (msg ? " (" + msg + ")" : ""), "error");
    });
    PMS.bus.on("save:file-error", function () {
      // local IndexedDB save succeeded; only the file mirror failed
      saveInd.classList.add("ok");
      saveLabel.textContent = t("save.local");
      PMS.toast.show(PMS.i18n.t("save.fileFail"), "warning");
    });

    PMS.bus.on("store:changed", function () {
      undoBtn.disabled = !PMS.store.canUndo();
      redoBtn.disabled = !PMS.store.canRedo();
    });
  }

  function toggleLanguage() {
    var next = PMS.i18n.getLang() === "ar" ? "en" : "ar";
    PMS.i18n.setLang(next);
    PMS.repos.settings.update({ lang: next });
    applyLocale();
  }

  function toggleTheme() {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    PMS.repos.settings.update({ theme: next });
    applyTheme(next);
  }

  function toggleSidebar() {
    var sb = document.getElementById("sidebar");
    if (sb.classList.contains("collapsed")) sb.classList.remove("collapsed");
    else sb.classList.add("collapsed");
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "light");
  }

  function applyLocale() {
    // re-render current view
    PMS.router.handle();
    // rebuild shell text
    buildSidebar();
    buildTopbar();
  }

  function setupKeyboard() {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target && e.target.isContentEditable;

      // Ctrl+Z / Ctrl+Y
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") { if (!typing) { e.preventDefault(); PMS.store.undo(); } return; }
      if ((e.ctrlKey && e.key.toLowerCase() === "y")) { e.preventDefault(); PMS.store.redo(); return; }
      if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); PMS.store.redo(); return; }

      if (typing) return;

      if (e.key === "/") {
        e.preventDefault();
        var si = document.getElementById("app-search");
        if (si) { si.focus(); si.select(); }
      }
      if (e.key.toLowerCase() === "n" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (PMS.auth && !PMS.auth.can("tasks.write")) { PMS.toast.show(t("auth.forbidden"), "error"); return; }
        PMS.editors.openTaskEditor(null, {});
      }
      if (e.key.toLowerCase() === "n" && e.shiftKey) {
        e.preventDefault();
        if (PMS.auth && !PMS.auth.can("projects.write")) { PMS.toast.show(t("auth.forbidden"), "error"); return; }
        PMS.editors.openProjectEditor(null, {});
      }
    });
  }

  function setupFileBinding() {
    // file storage permission re-request on load (needs user gesture)
    var hint = null;
    function bindOnce() {
      PMS.fileStorage.init().then(function (bound) {
        if (bound) PMS.toast.show(PMS.i18n.t("settings.fileBound"), "info");
      }).catch(function () {
        /* noop: user declined */
      });
    }
    // try on first pointer/keydown
    window.addEventListener("pointerdown", bindOnce, { once: true });
    if (!PMS.fileStorage.supported) return;
  }

  function hideShell() {
    var shell = document.getElementById("app-shell");
    if (shell) shell.style.display = "none";
  }

  // Signing in used to be able to leave an empty app on screen that only a
  // manual refresh cleared. If the first paint produced nothing, rebuild the
  // shell once instead of leaving the user in front of a blank page.
  function ensurePainted() {
    setTimeout(function () {
      var view = document.getElementById("view-root");
      if (!view || view.children.length) return;
      console.warn("[app] first paint produced nothing - rebuilding the shell");
      step("repaint", function () {
        buildSidebar();
        buildTopbar();
        if (PMS.router) PMS.router.handle();
      });
    }, 500);
  }

  function showShell() {
    if (!started) { init(); return; }
    var shell = document.getElementById("app-shell");
    if (shell) shell.style.display = "";
    step("lang", function () { PMS.i18n.setLang(PMS.store.data.settings.lang || "en"); });
    step("sidebar", buildSidebar);
    step("topbar", buildTopbar);
    step("route", function () { if (PMS.router) { PMS.router.navigate("/"); PMS.router.handle(); } });
    ensurePainted();
  }

  // Runs one start-up step; a failure is reported but never stops the shell
  // from coming up (a broken optional service must not leave a blank app).
  function step(name, fn) {
    try { return fn(); }
    catch (e) {
      console.error("[app] start step " + name + " failed:", e);
      PMS.bus.emit("app:step-error", { step: name, error: e });
      return null;
    }
  }

  function init() {
    if (started) { showShell(); return; }
    started = true;
    step("theme", function () {
      document.documentElement.setAttribute("data-theme", PMS.store.data.settings.theme || "light");
    });
    step("lang", function () { PMS.i18n.setLang(PMS.store.data.settings.lang || "en"); });
    step("sidebar", buildSidebar);
    step("topbar", buildTopbar);
    step("keyboard", setupKeyboard);
    // the view is drawn first: the shell is usable even if a later service fails
    step("router", function () { PMS.router.start(); });
    step("backup-load", function () { PMS.backup.load(); });
    step("backup-auto", function () { PMS.backup.startAuto(); });
    step("file-binding", setupFileBinding);
    step("sync", function () { if (PMS.sync) PMS.sync.start(); });
    PMS.bus.emit("app:ready");
    ensurePainted();
    // whenever the session ends (logout), return to the login screen
    PMS.bus.on("auth:logout", function () {
      hideShell();
      PMS.authUI.show(showShell);
    });
  }

  PMS.app = { init: init, showShell: showShell, hideShell: hideShell, applyTheme: applyTheme, applyLocale: applyLocale };
})(window.PMS);