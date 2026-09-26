/* ==========================================================================
   PMS.validation - input validation for all entities.
   expose repository-aware checks used by form builders.
   ========================================================================== */
(function (PMS) {
  "use strict";

  function required(v) { return v !== undefined && v !== null && String(v).trim() !== ""; }

  function validators() {
    return {
      department: function (o) {
        var err = [];
        if (!required(o.name)) err.push("name");
        if (!required(o.nameEn)) err.push("nameEn");
        return { valid: err.length === 0, errors: err };
      },
      person: function (o) {
        var err = [];
        if (!required(o.name)) err.push("name");
        if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) err.push("email");
        return { valid: err.length === 0, errors: err };
      },
      project: function (o) {
        var err = [];
        if (!required(o.name)) err.push("name");
        if (o.startDate && o.endDate && String(o.endDate) < String(o.startDate)) err.push("dates");
        return { valid: err.length === 0, errors: err };
      },
      task: function (o) {
        var err = [];
        if (!required(o.title)) err.push("title");
        if (o.startDate && o.dueDate && String(o.dueDate) < String(o.startDate)) err.push("dates");
        return { valid: err.length === 0, errors: err };
      }
    };
  }

  PMS.validation = {
    validators: validators,
    check: function (entity, payload) {
      var fn = validators()[entity];
      if (!fn) return { valid: true, errors: [] };
      return fn(payload);
    }
  };
})(window.PMS);