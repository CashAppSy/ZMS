/* ==========================================================================
   PMS.migrations - versioned data migrations.
   To add a migration: push { from, to, fn(data) }. from/to are schema versions.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var migrations = [];
  var CURRENT = PMS.schema.VERSION;

  function register(from, to, fn) {
    migrations.push({ from: from, to: to, fn: fn });
  }

  // Example future migration (kept as reference — do not run yet):
  // register(1, 2, function (data) {
  //   // e.g. data.settings.someNewFlag = false;
  //   return data;
  // });

  function migrate(data) {
    if (!data || typeof data !== "object") return null;
    var version = data.schemaVersion || 1;
    var guard = 0;
    while (version < CURRENT && guard < 100) {
      var step = migrations.find(function (m) { return m.from === version; });
      if (!step) {
        // no migration path -> treat as un-migratable
        version = CURRENT;
        break;
      }
      data = step.fn(data) || data;
      data.schemaVersion = step.to;
      version = step.to;
      guard++;
    }
    return data;
  }

  PMS.migrations = { migrate: migrate, register: register, CURRENT: CURRENT };
})(window.PMS);