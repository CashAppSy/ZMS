/* ==========================================================================
   PMS.exportService - CSV / JSON export-import + print.
   Import validates schema (schemaVersion) then either merges or replaces.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;

  function csvEscape(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows, columns, labels) {
    var head = columns.map(function (c) { return csvEscape((labels && labels[c]) || c); });
    var body = rows.map(function (r) {
      return columns.map(function (c) { return csvEscape(r[c]); }).join(",");
    });
    return [head.join(",")].concat(body).join("\n");
  }

  function downloadCSV(filename, rows, columns, labels) {
    var csv = toCSV(rows, columns, labels);
    U.download(filename, "\uFEFF" + csv, "text/csv;charset=utf-8");
    PMS.toast.show(PMS.i18n.t("export.csvExported"), "success");
  }

  function downloadJSON(filename, obj) {
    U.download(filename, JSON.stringify(obj, null, 2), "application/json");
    PMS.toast.show(PMS.i18n.t("export.jsonExported"), "success");
  }

  // SECURITY (ZMS-09): authentication material must never ride along in
  // business exports/imports. Strip passwordHash + salt from any user records
  // wherever the dataset leaves the app.
  function sanitizeUserForExport(u) {
    var c = U.deepClone(u || {});
    if (c && typeof c === "object") {
      delete c.passwordHash;
      delete c.salt;
    }
    return c;
  }

  function sanitizeDataForExport(data) {
    var d = U.deepClone(data || {});
    if (Array.isArray(d.users)) d.users = d.users.map(sanitizeUserForExport);
    return d;
  }

  function exportAllJSON() {
    downloadJSON("pms-data-" + U.todayISO() + ".json", sanitizeDataForExport(PMS.store.data));
  }

  function validateImport(obj) {
    if (!obj || typeof obj !== "object") return { valid: false, reason: "not-an-object" };
    var v = obj.schemaVersion;
    if (typeof v !== "number" || v < 1 || v > PMS.schema.VERSION) {
      return { valid: false, reason: "schema-version" };
    }
    var required = ["departments", "people", "projects", "tasks"];
    for (var i = 0; i < required.length; i++) {
      if (!Array.isArray(obj[required[i]])) return { valid: false, reason: "missing-" + required[i] };
    }
    return { valid: true };
  }

  function importJSON(obj, mode) {
    // mode: "merge" | "replace"
    var check = validateImport(obj);
    if (!check.valid) return { ok: false, error: check.reason };

    if (mode === "replace") {
      var migrated = PMS.migrations.migrate(obj);
      // Never wipe accounts with a file that lacks users.
      if (!migrated.users || !migrated.users.length) migrated.users = U.deepClone(PMS.store.data.users || []);
      // A file may carry a stolen password hash — never import authentication
      // material for records; accounts that already exist locally keep their
      // current password, brand-new imported accounts need a password reset.
      if (Array.isArray(migrated.users)) {
        var liveUsers = (PMS.store.data && PMS.store.data.users) || [];
        migrated.users = migrated.users.map(function (u) {
          var clean = sanitizeUserForExport(u);
          var live = liveUsers.find(function (x) { return x && x.id === u.id; });
          if (live && live.passwordHash) { clean.passwordHash = live.passwordHash; clean.salt = live.salt; }
          return clean;
        });
      }
      PMS.store.setData(migrated);
      PMS.toast.show(PMS.i18n.t("export.importOk", { n: migrated.tasks.length }), "success");
      return { ok: true, records: migrated.tasks.length };
    }

    // merge: append entities ensuring unique ids (redefine via repos)
    PMS.store.commit(function (d) {
      mergeArray(d, "departments", obj, function (x) { return PMS.dataMerge.departmentDB(x); });
      mergeArray(d, "people", obj, function (x) { return PMS.dataMerge.personDB(x); });
      mergeArray(d, "projects", obj, function (x) {
        var p = PMS.dataMerge.projectDB(x);
        return p;
      });
      mergeArray(d, "tasks", obj, function (x) { return PMS.dataMerge.taskDB(x); });
    }, "import-merge");
    PMS.toast.show(PMS.i18n.t("export.importOk_merge"), "success");
    return { ok: true, records: obj.tasks.length };
  }

  function mergeArray(destination, key, sourceObj, factory) {
    var source = sourceObj[key] || [];
    var existing = destination[key];
    source.forEach(function (item) {
      var dup = existing.some(function (e) { return e.id === item.id; });
      if (dup) return; // don't duplicate same id
      var built = factory ? factory(item) : item;
      existing.push(built);
    });
  }

  function print() { window.print(); }

  PMS.exportService = {
    toCSV: toCSV,
    downloadCSV: downloadCSV,
    downloadJSON: downloadJSON,
    exportAllJSON: exportAllJSON,
    validateImport: validateImport,
    importJSON: importJSON,
    sanitize: sanitizeDataForExport,
    print: print
  };

  // Data-Merge normalizers: turn seed/sample records into full entities
  PMS.dataMerge = {
    departmentDB: function (d) {
      return {
        id: d.id, name: d.name || { en: d.nameEn, ar: d.nameAr },
        description: d.description || { en: "", ar: "" },
        color: d.color || U.colorForSeed(d.name && d.name.en),
        createdAt: d.createdAt || U.nowISO(), updatedAt: d.updatedAt || U.nowISO()
      };
    },
    personDB: function (p) {
      return {
        id: p.id, name: p.name || p.nameEn, jobTitle: p.jobTitle || "",
        departmentId: p.departmentId || null, email: p.email || "", phone: p.phone || "",
        status: p.status || "active", notes: p.notes || "",
        createdAt: p.createdAt || U.nowISO(), updatedAt: p.updatedAt || U.nowISO()
      };
    },
    projectDB: function (p) {
      return {
        id: p.id, parentId: p.parentId || null, name: p.name || p.nameEn,
        description: p.description || "", status: p.status || "planned",
        priority: p.priority || "medium", managerId: p.managerId || null,
        memberIds: p.memberIds || [], startDate: p.startDate || null,
        endDate: p.endDate || null, budget: p.budget != null ? p.budget : null,
        tags: p.tags || [], links: p.links || [], notes: p.notes || "",
        customFields: p.customFields || {},
        createdAt: p.createdAt || U.nowISO(), updatedAt: p.updatedAt || U.nowISO()
      };
    },
    taskDB: function (t) {
      return {
        id: t.id, projectId: t.projectId, parentTaskId: t.parentTaskId || null,
        title: t.title || t.name, description: t.description || "",
        status: t.status || "todo", priority: t.priority || "medium",
        assignees: t.assignees || [], startDate: t.startDate || null,
        dueDate: t.dueDate || null, estimatedHours: t.estimatedHours || 0,
        actualHours: t.actualHours || 0, progress: t.progress != null ? t.progress : 0,
        tags: t.tags || [], checklist: t.checklist || [], comments: t.comments || [],
        activity: t.activity || [], dependencies: t.dependencies || [],
        customFields: t.customFields || {},
        createdAt: t.createdAt || U.nowISO(), updatedAt: t.updatedAt || U.nowISO()
      };
    }
  };
})(window.PMS);