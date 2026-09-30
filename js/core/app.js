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

  // The brand logo ships in two files: one to read on a light background and
  // one for dark mode. Both are rendered and CSS shows the right one, so
  // switching the theme never needs a reload.
  function logoImage(cls) {
    var wrap = h("span" + (cls ? "." + cls : ""));
    wrap.appendChild(h("img", {
      attrs: { src: "assets/logo-light.png", alt: t("app.name"), loading: "lazy", decoding: "async" },
      style: { display: "block", maxWidth: "100%" }
    }));
    wrap.appendChild(h("img", {
      attrs: { src: "assets/logo-dark.png", alt: "", "aria-hidden": "true", loading: "lazy", decoding: "async" },
      style: { display: "none", maxWidth: "100%" }
    }));
    return wrap;
  }

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
    // brand: the PM logo, swapped by theme (the light file is for light mode)
    var brand = h("div.sidebar-brand", { attrs: { title: t("app.name") } });
    brand.appendChild(logoImage("brand-logo-img"));
    // the logo is a wordmark that already spells the app name, so the name is
    // kept for assistive tech and the hover tooltip rather than printed twice
    brand.appendChild(h("span.u-sr-only", { text: t("app.name") }));
    sidebar.appendChild(brand);
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
  // manual refresh cleared. Nothing threw in that case, so the failure is
  // checked in the layers that decide what the user actually sees: the app
  // shell, the sign-in overlay, and the view container. What can be repaired
  // is repaired, and if it is still hidden the reason is written on the page
  // instead of leaving a blank screen.
  //
  // Showing the sign-in screen is a healthy state even though the view
  // container is empty, so it is checked for first and reported as fine.
  function diagnose() {
    var shell = document.getElementById("app-shell");
    var overlay = document.getElementById("auth-root");
    var root = document.getElementById("view-root");
    var overlayLive = !!(overlay && overlay.style.display !== "none" && overlay.children.length);
    if (overlayLive) return [];                    // signed out, sign-in form is up
    var issues = [];
    if (!root) issues.push({ text: "no #view-root element", fix: "none" });
    else if (!root.children.length) issues.push({ text: "#view-root has no content", fix: "repaint" });
    if (shell && shell.style.display === "none") issues.push({ text: "#app-shell is hidden", fix: "shell" });
    if (overlay && overlay.style.display !== "none" && !overlay.children.length)
      issues.push({ text: "the sign-in overlay is still covering the app", fix: "overlay" });
    return issues;
  }

  function repair(issues) {
    issues.forEach(function (issue) {
      if (issue.fix === "shell") {
        var shell = document.getElementById("app-shell");
        if (shell) shell.style.display = "";
      }
      if (issue.fix === "overlay") {
        var overlay = document.getElementById("auth-root");
        if (overlay) overlay.style.display = "none";
      }
      if (issue.fix === "repaint") {
        step("repaint", function () {
          buildSidebar();
          buildTopbar();
          if (PMS.router) PMS.router.handle();
        });
      }
    });
  }

  function checkNow(where) {
    var issues = diagnose();
    if (!issues.length) return false;
    console.warn("[app] interface is hidden (" + where + "):", issues.map(function (i) { return i.text; }));
    PMS.bus.emit("app:blank-screen", { where: where, issues: issues });
    repair(issues);
    // after the repairs, report anything that is still not right
    setTimeout(function () {
      var left = diagnose();
      if (!left.length) {
        console.info("[app] interface recovered automatically (" + where + ")");
        return;
      }
      paintDiagnostics(left);
    }, 400);
    return true;
  }

  function ensurePainted() {
    setTimeout(function () { checkNow("first paint"); }, 500);
  }

  // Watches the interface afterwards too: a session that expires (or is
  // dropped while the cloud data lands) hides the shell after sign-in, and
  // nothing on that path re-shows it.
  var watchTimer = null;
  function watch() {
    if (watchTimer) return;
    watchTimer = setInterval(function () {
      if (document.hidden) return;
      checkNow("watchdog");
    }, 4000);
  }

  // Last resort: a readable explanation with a retry button, so the problem
  // is never an unexplained blank page.
  function paintDiagnostics(issues) {
    var shell = document.getElementById("app-shell");
    if (shell) shell.style.display = "";            // a report nobody can see is useless
    var host = document.getElementById("view-root") || document.body;
    if (!host || host.querySelector(".blank-report")) return;
    var box = document.createElement("div");
    box.className = "empty-state blank-report";
    var h = PMS.dom.h;
    box.appendChild(h("div.empty-icon", { text: "⚠️" }));
    box.appendChild(h("h3", { text: PMS.i18n.t("errors.blankScreen") }));
    var ul = h("ul.u-muted");
    (issues || []).forEach(function (issue) { ul.appendChild(h("li", { text: issue.text })); });
    if (recentErrors.length) {
      ul.appendChild(h("li", { text: PMS.i18n.t("errors.blankScreenLast") + ": " + recentErrors[recentErrors.length - 1] }));
    }
    box.appendChild(ul);
    var btn = h("button.btn.btn-primary", {
      text: PMS.i18n.t("common.retry"),
      on: {
        click: function () { try { window.location.reload(); } catch (e) { window.location.hash = "#/"; } }
      }
    });
    box.appendChild(btn);
    host.appendChild(box);
  }

  // Nothing may fail silently: keep the last few uncaught errors so a blank
  // page can always explain itself, and show them in a corner note.
  var recentErrors = [];
  function noteError(where, err) {
    var text = where + ": " + String((err && err.message) || err);
    recentErrors.push(text);
    if (recentErrors.length > 5) recentErrors.shift();
    if (document.readyState === "loading") return;
    var box = document.getElementById("error-note");
    if (!box) {
      box = document.createElement("div");
      box.id = "error-note";
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.classList.add("is-on");
    PMS.bus.emit("app:error-note", { text: text });
  }
  window.addEventListener("error", function (ev) {
    noteError("error", ev.error || ev.message);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    noteError("promise", ev.reason);
  });

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
    watch();
    // whenever the session ends (logout), return to the login screen
    PMS.bus.on("auth:logout", function () {
      hideShell();
      PMS.authUI.show(showShell);
    });
  }

  PMS.app = { init: init, showShell: showShell, hideShell: hideShell, applyTheme: applyTheme, applyLocale: applyLocale };
})(window.PMS);