/* ==========================================================================
   PMS.router - hash-based router (#/projects/42). Works on file://.
   Routes: list of {pattern, viewId}. Params parsed from :segments.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var routes = [];
  var currentPath = "";
  var container = null;
  var currentView = null;
  var currentParams = null;
  // A view that throws leaves #view-root empty, which used to mean a blank app
  // that only a page refresh could clear (the usual cause is data that had not
  // arrived yet, e.g. the first cloud pull finishing right after login). Track
  // the failures per view+path so a render can be retried a couple of times and
  // then reported in place instead of silently.
  var renderFailures = {};
  var MAX_RENDER_RETRIES = 2;

  function paintRenderError(container, view, err) {
    var h = PMS.dom.h;
    var wrap = h("div.empty-state");
    wrap.appendChild(h("div.empty-icon", { text: "⚠️" }));
    wrap.appendChild(h("h3", { text: PMS.i18n.t("errors.viewFailed") }));
    wrap.appendChild(h("p.u-muted", { text: String((err && err.message) || err) }));
    wrap.appendChild(h("button.btn.btn-primary", {
      text: PMS.i18n.t("common.retry"),
      on: { click: function () { renderFailures = {}; handle(); } }
    }));
    container.appendChild(wrap);
  }

  function renderCurrent() {
    var viewId = currentView.id;
    var path = currentPath;
    var key = viewId + "@" + path;
    try {
      var cleanup = currentView.render(container, currentParams);
      if (typeof cleanup === "function") currentView.destroy = cleanup;
      delete renderFailures[key];
      if (!container.children.length) {
        // a view that draws nothing is as good as a crash for the user: say so
        // in the console so the cause is findable, but leave the DOM alone.
        console.warn("[router] view " + viewId + " rendered nothing for " + path);
      }
      return true;
    } catch (e) {
      var tries = (renderFailures[key] || 0) + 1;
      renderFailures[key] = tries;
      console.error("[router] view " + viewId + " failed to render " + path + ":", e);
      PMS.bus.emit("view:error", { viewId: viewId, path: path, error: e, tries: tries });
      paintRenderError(container, currentView, e);
      if (tries <= MAX_RENDER_RETRIES) {
        // most first-time failures are data still arriving: retry shortly
        setTimeout(function () {
          if (currentPath === path && currentView && currentView.id === viewId) handle();
        }, 150 * tries);
      }
      return false;
    }
  }

  function register(pattern, viewId, opts) {
    // idempotent: replace existing registration for the same pattern
    routes = routes.filter(function (r) { return r.pattern !== pattern; });
    routes.push(Object.assign({ pattern: pattern, viewId: viewId, requireAuth: false }, opts || {}));
    routes.sort(function (a, b) { return (b.pattern.match(/:/g) || []).length - (a.pattern.match(/:/g) || []).length; });
  }

  function parse(path) {
    var query = {};
    var pathOnly = path;
    var qIdx = path.indexOf("?");
    if (qIdx !== -1) {
      pathOnly = path.slice(0, qIdx);
      path.slice(qIdx + 1).split("&").forEach(function (kv) {
        var p = kv.split("=");
        if (p[0]) query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
      });
    }
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      var parts = r.pattern.split("/").filter(Boolean);
      var pathParts = pathOnly.split("/").filter(Boolean);
      if (parts.length !== pathParts.length) continue;
      var params = {};
      var ok = true;
      for (var j = 0; j < parts.length; j++) {
        if (parts[j][0] === ":") params[parts[j].slice(1)] = decodeURIComponent(pathParts[j]);
        else if (parts[j] !== pathParts[j]) { ok = false; break; }
      }
      if (ok) return { viewId: r.viewId, params: params, query: query, view: PMS.registry.getView(r.viewId) };
    }
    return { viewId: "dashboard", params: {}, query: query, view: PMS.registry.getView("dashboard") };
  }

  function navigate(path) {
    if (path.charAt(0) !== "#") path = "#" + path;
    if (window.location.hash === path) {
      // still re-render (state may have changed)
    }
    window.location.hash = path;
  }

  function handle() {
    var hash = window.location.hash || "#/";
    var clean = hash.replace(/^#/, "") || "/";
    if (clean.charAt(0) !== "/") clean = "/" + clean;
    var resolved = parse(clean);
    currentPath = clean;

    if (currentView && currentView.destroy) {
      try { currentView.destroy(); } catch (e) { console.error(e); }
    }
    if (!container) container = document.getElementById("view-root");

    if (resolved.view.requireAuth) {
      // placeholder for future auth
    }

    currentView = resolved.view;
    currentParams = Object.assign({}, resolved.params, resolved.query || {});

    // admin-only routes: non-admins are bounced to the dashboard
    if (resolved.view.adminOnly) {
      var allowed = PMS.auth && PMS.auth.can("settings");
      if (!allowed) {
        if (PMS.auth && PMS.auth.currentUser() && PMS.toast) {
          PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error");
        }
        resolved = { viewId: "dashboard", params: {}, query: {}, view: PMS.registry.getView("dashboard") };
        currentView = resolved.view;
        currentParams = Object.assign({}, resolved.params, resolved.query || {});
        currentPath = "/";
      }
    }

    document.title = PMS.i18n.t(currentView.titleKey || "app.name") + " — " + PMS.i18n.t("app.name");
    if (document.activeElement && document.activeElement.blur) {
      try { if (document.activeElement.id !== "app-search") document.activeElement.blur(); } catch (e) {}
    }
    container.innerHTML = "";
    container.scrollTop = 0;
    renderCurrent();
    PMS.bus.emit("route:changed", { path: clean, viewId: currentView.id });
  }

  function start() {
    window.addEventListener("hashchange", handle);
    handle();
  }

  PMS.router = { register: register, navigate: navigate, handle: handle, start: start, get current() { return currentPath; }, get params() { return currentParams; }, get view() { return currentView; } };
})(window.PMS);