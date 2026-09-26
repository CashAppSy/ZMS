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

  function registerFieldType(type, descriptor) {
    fieldTypes[type] = descriptor;
  }
  function getFieldType(type) { return fieldTypes[type]; }
  function allFieldTypes() { return Object.keys(fieldTypes).map(function (k) { return Object.assign({ key: k }, fieldTypes[k]); }); }

  PMS.registry = {
    registerView: registerView,
    getView: getView,
    allViews: allViews,
    registerFieldType: registerFieldType,
    getFieldType: getFieldType,
    allFieldTypes: allFieldTypes
  };
})(window.PMS);