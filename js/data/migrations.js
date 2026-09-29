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

  // v1 -> v2: meetings collection + task meeting / task-link fields.
  register(1, 2, function (data) {
    if (!Array.isArray(data.meetings)) data.meetings = [];
    (data.tasks || []).forEach(function (t) {
      if (!Array.isArray(t.linkedTaskIds)) t.linkedTaskIds = [];
      if (t.meetingId === undefined) t.meetingId = null;
    });
    return data;
  });

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