/* ==========================================================================
   PMS.registry - Registration point for views, reports, field types & icons.
   Adding a view/report/field type = one register() call from one file.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var views = {};      // id -> view
  var viewOrder = [];
  var fieldTypes = {}; // type key -> descriptor

  function registerView(view) {
    views[view.id] = view;
    viewOrder.push(view.id);
    PMS.bus.emit("registry:view", view);
  }

  function getView(id) { return views[id]; }
  function allViews() { return viewOrder.map(function (id) { return views[id]; }); }

  // Which paths each role may open. A member works inside the tasks and
  // meetings tabs only; the overview screens (dashboard, projects, people,
  // reports) are for managers and admins. The task sub-views (kanban, gantt,
  // calendar) are part of the tasks tab, so they come along with it.
  var ROLE_ROUTES = {
    member: ["/tasks", "/meetings"]
  };

  function currentRole() {
    return PMS.auth && PMS.auth.role ? PMS.auth.role() : null;
  }

  // The single place that decides whether a path may be opened. The sidebar and
  // the router both go through here, so a hidden tab cannot be reached by
  // typing its URL.
  function pathAllowed(path) {
    var allowed = ROLE_ROUTES[currentRole()];
    if (!allowed) return true;               // admin/manager: everything
    var p = String(path || "").split("?")[0];
    return allowed.some(function (base) {
      return p === base || p.indexOf(base + "/") === 0;
    });
  }

  // Same decision for a registered view (the nav builds from views).
  function viewAllowed(view) {
    if (!view) return false;
    if (view.adminOnly && !(PMS.auth && PMS.auth.can && PMS.auth.can("settings"))) return false;
    // A view with no path is a sub-view of another tab (the kanban/gantt/
    // calendar switchers inside Tasks). Its real path is checked by the router.
    if (!view.path) return true;
    return pathAllowed(view.path);
  }

  // Where a role lands after signing in: a member has no dashboard, so they go
  // straight to their first tab instead of being bounced off the root.
  function homeRoute() {
    var allowed = ROLE_ROUTES[currentRole()];
    return allowed ? allowed[0] : "/";
  }

  function navViews() {
    return allViews().filter(function (v) { return v.nav && viewAllowed(v); });
  }

  function registerFieldType(type, descriptor) {
    fieldTypes[type] = descriptor;
  }
  function getFieldType(type) { return fieldTypes[type]; }
  function allFieldTypes() { return Object.keys(fieldTypes).map(function (k) { return Object.assign({ key: k }, fieldTypes[k]); }); }

  PMS.registry = {
    registerView: registerView,
    getView: getView,
    allViews: allViews,
    navViews: navViews,
    viewAllowed: viewAllowed,
    pathAllowed: pathAllowed,
    homeRoute: homeRoute,
    registerFieldType: registerFieldType,
    getFieldType: getFieldType,
    allFieldTypes: allFieldTypes
  };
})(window.PMS);