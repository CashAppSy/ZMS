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

  // v2 -> v3: dependencies gain a type and a lag.
  //
  // The field used to be a bare list of predecessor ids, which could only ever
  // mean finish-to-start. It is now a list of { id, type, lag }. Written in
  // place rather than as a new field so there is still one source of truth for
  // "what does this task wait on", and the old shape is read as FS elsewhere
  // (PMS.dependencies.norm) so a half-migrated file still draws.
  register(2, 3, function (data) {
    (data.tasks || []).forEach(function (t) {
      if (!Array.isArray(t.dependencies)) {
        t.dependencies = t.dependencies ? [t.dependencies] : [];
        return;
      }
      var seen = {};
      t.dependencies = t.dependencies.map(function (dep) {
        var id = typeof dep === "string" ? dep : (dep && (dep.id || dep.taskId));
        if (!id || seen[id]) return null;
        seen[id] = true;
        return { id: id, type: "FS", lag: 0 };
      }).filter(Boolean);
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