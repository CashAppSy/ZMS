/* ==========================================================================
   PMS.repositories - typed CRUD accessors over the store.
   All writes go through PMS.store.commit so every view auto-refreshes and
   every mutation is undoable.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;

  // ------- global activity log (ZMS-R06) -------
  // Every create/edit/status/progress/delete is appended to `activities`
  // (newest first, capped). The admin-only "Activity log" view lists them and
  // the cloud sync ships them as an append-only per-record collection
  // (zms_activities) so every device records the same history.
  var LOG_LIMIT = 500;
  var LOGGED_COLLECTIONS = ["tasks", "projects", "people", "departments"];
  var LOG_NOISE = ["id", "createdAt", "updatedAt", "activity", "checklist", "comments"];
  // Per-collection key stored on an entry = singular entity name (matches the
  // activity.entities i18n keys and the entity colors in the view).
  var ENTITY_KEY = { tasks: "task", projects: "project", people: "person", departments: "department" };

  function actorName() {
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return u ? (u.name || u.username || u.email || "") : "";
  }

  function entityLabel(collection, rec) {
    if (!rec) return "";
    if (collection === "tasks") return rec.title || "";
    if (rec.name != null) {
      if (typeof rec.name === "string") return rec.name;
      return rec.name.en || rec.name.ar || "";
    }
    return "";
  }

  function statusLabel(collection, key) {
    if (!key) return "—";
    var list = collection === "project"
      ? PMS.store.data.projectStatuses : PMS.store.data.taskStatuses;
    var s = (list || []).find(function (x) { return x.key === key; });
    return s && s.name ? (s.name.en || s.name.ar || key) : key;
  }

  function makeEntry(collection, rec, action, detail) {
    var now = new Date().toISOString();
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return {
      id: PMS.ids.uuid(),
      at: now,
      updatedAt: now,
      ts: Date.now(),
      actor: actorName(),
      actorId: u ? u.id : null,
      entity: ENTITY_KEY[collection] || collection,
      entityId: rec ? rec.id : null,
      entityName: entityLabel(collection, rec),
      action: action,
      detail: detail || ""
    };
  }

  function pushLog(d, entry) {
    if (!Array.isArray(d.activities)) d.activities = [];
    d.activities.unshift(entry);
    if (d.activities.length > LOG_LIMIT) d.activities.length = LOG_LIMIT;
  }

  function fieldChanged(prev, cur, key) {
    return JSON.stringify(prev ? prev[key] : undefined) !== JSON.stringify(cur ? cur[key] : undefined);
  }

  // Build (and append) an entry describing what a generic update() changed.
  // Fields the status UI manages itself (activity, comments, clocks) never
  // count as changes, so a plain status/progress touch logs exactly that.
  function logUpdate(d, collection, prev, target, patch) {
    if (LOGGED_COLLECTIONS.indexOf(collection) === -1) return;
    var changed = Object.keys(patch || {}).filter(function (k) {
      return LOG_NOISE.indexOf(k) === -1 && fieldChanged(prev, target, k);
    });
    if (!changed.length) return;
    var entry;
    if (changed.indexOf("status") !== -1) {
      entry = makeEntry(collection, target, "status",
        statusLabel(collection, prev.status) + " → " + statusLabel(collection, target.status));
    } else if (changed.indexOf("progress") !== -1) {
      entry = makeEntry(collection, target, "progress",
        (prev.progress === undefined ? 0 : prev.progress) + "% → " + (target.progress === undefined ? 0 : target.progress) + "%");
    } else {
      entry = makeEntry(collection, target, "updated", changed.join(", "));
    }
    pushLog(d, entry);
  }

  function list(collection) {
    return PMS.store.data[collection] || [];
  }

  function find(collection, id) {
    if (!id) return null;
    return list(collection).find(function (x) { return x.id === id; }) || null;
  }

  function add(collection, obj) {
    var now = new Date().toISOString();
    var record = U.deepClone(obj);
    record.id = record.id || PMS.ids.uuid();
    record.createdAt = record.createdAt || now;
    record.updatedAt = now;
    PMS.store.commit(function (d) {
      d[collection].push(record);
      if (LOGGED_COLLECTIONS.indexOf(collection) !== -1) pushLog(d, makeEntry(collection, record, "created"));
    }, "add-" + collection);
    return record;
  }

  function update(collection, id, patch) {
    var record = find(collection, id);
    if (!record) return null;
    var prev = U.deepClone(record);
    PMS.store.commit(function (d) {
      var target = d[collection].find(function (x) { return x.id === id; });
      if (target) U.deepClone(patch) && Object.keys(patch || {}).forEach(function (k) {
        target[k] = U.deepClone(patch[k]);
      });
      if (target) target.updatedAt = new Date().toISOString();
      if (target) logUpdate(d, collection, prev, target, patch);
    }, "update-" + collection);
    return record;
  }

  function set(collection, id, patch) { return update(collection, id, patch); }

  /* ---------- Entity-specific repositories ---------- */

  PMS.repos = {
    departments: {
      all: function () { return list("departments"); },
      get: function (id) { return find("departments", id); },
      add: function (obj) { return add("departments", obj); },
      update: function (id, patch) { return update("departments", id, patch); },
      remove: function (id) {
        PMS.store.commit(function (d) {
          var rec = d.departments.find(function (x) { return x.id === id; });
          d.departments = d.departments.filter(function (x) { return x.id !== id; });
          if (rec) pushLog(d, makeEntry("departments", rec, "deleted"));
        }, "remove-department");
        return true;
      }
    },

    people: {
      all: function () { return list("people"); },
      active: function () { return list("people").filter(function (p) { return p.status !== "inactive"; }); },
      get: function (id) { return find("people", id); },
      add: function (obj) { return add("people", obj); },
      update: function (id, patch) { return update("people", id, patch); },
      // Deleting a person is forbidden; archive them instead.
      archive: function (id) {
        PMS.store.commit(function (d) {
          var p = d.people.find(function (x) { return x.id === id; });
          if (p) { p.status = "inactive"; p.updatedAt = new Date().toISOString(); }
          if (p) pushLog(d, makeEntry("people", p, "archived"));
        }, "archive-person");
        return true;
      }
    },

    projects: {
      all: function () { return list("projects"); },
      get: function (id) { return find("projects", id); },
      add: function (obj) {
        obj.parentId = obj.parentId || null;
        return add("projects", obj);
      },
      update: function (id, patch) { return update("projects", id, patch); },
      // cascade delete: sub-projects and their tasks
      remove: function (id) {
        var toDelete = [];
        var all = list("projects");
        function collect(pid) {
          toDelete.push(pid);
          all.forEach(function (p) {
            if (p.parentId === pid) collect(p.id);
          });
        }
        collect(id);
        PMS.store.commit(function (d) {
          var root = d.projects.find(function (p) { return p.id === id; });
          d.projects = d.projects.filter(function (p) { return toDelete.indexOf(p.id) === -1; });
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.projectId) === -1; });
          if (root) pushLog(d, makeEntry("projects", root, "deleted"));
        }, "remove-project");
        return true;
      },
      children: function (parentId) {
        return list("projects").filter(function (p) { return p.parentId === parentId; });
      }
    },

    tasks: {
      all: function () { return list("tasks"); },
      get: function (id) { return find("tasks", id); },
      add: function (obj) {
        obj.parentTaskId = obj.parentTaskId || null;
        return add("tasks", obj);
      },
      update: function (id, patch) { return update("tasks", id, patch); },
      // cascade delete: sub-tasks (dependency references removed too)
      remove: function (id) {
        var toDelete = [];
        var all = list("tasks");
        function collect(tid) { toDelete.push(tid); }
        function walk(t) {
          if (t.parentTaskId && toDelete.indexOf(t.parentTaskId) !== -1) return;
          toDelete.push(t.id);
          all.forEach(function (c) { if (c.parentTaskId === t.id) toDelete.push(c.id); });
        }
        collect(id);
        all.forEach(function (t) { if (t.parentTaskId === id) toDelete.push(t.id); });
        // remove deeper nesting transitively
        var grew = true;
        while (grew) {
          grew = false;
          all.forEach(function (t) {
            if (toDelete.indexOf(t.parentTaskId) !== -1 && toDelete.indexOf(t.id) === -1) {
              toDelete.push(t.id); grew = true;
            }
          });
        }
        PMS.store.commit(function (d) {
          var root = d.tasks.find(function (t) { return t.id === id; });
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.id) === -1; });
          d.tasks.forEach(function (t) {
            t.dependencies = (t.dependencies || []).filter(function (dep) {
              return toDelete.indexOf(dep) === -1;
            });
          });
          if (root) pushLog(d, makeEntry("tasks", root, "deleted"));
        }, "remove-task");
        return true;
      },
      forProject: function (projectId) {
        return list("tasks").filter(function (t) { return t.projectId === projectId; });
      },
      children: function (parentTaskId) {
        return list("tasks").filter(function (t) { return t.parentTaskId === parentTaskId; });
      }
    },

    fields: {
      all: function () { return list("customFieldDefs"); },
      forEntity: function (entity) {
        return list("customFieldDefs").filter(function (f) { return f.entity === entity; });
      },
      get: function (id) { return find("customFieldDefs", id); },
      add: function (obj) { return add("customFieldDefs", obj); },
      update: function (id, patch) { return update("customFieldDefs", id, patch); },
      remove: function (id) {
        PMS.store.commit(function (d) {
          d.customFieldDefs = d.customFieldDefs.filter(function (x) { return x.id !== id; });
          // remove stored values from tasks/projects
          d.tasks.forEach(function (t) { if (t.customFields) delete t.customFields[id]; });
          d.projects.forEach(function (p) { if (p.customFields) delete p.customFields[id]; });
        }, "remove-field");
        return true;
      }
    },

    statuses: {
      task: function () { return list("taskStatuses"); },
      project: function () { return list("projectStatuses"); },
      setTask: function (listx) {
        PMS.store.commit(function (d) { d.taskStatuses = listx; }, "set-task-statuses");
      },
      setProject: function (listx) {
        PMS.store.commit(function (d) { d.projectStatuses = listx; }, "set-project-statuses");
      }
    },

    priorities: {
      all: function () { return list("priorities"); },
      get: function (key) { return list("priorities").find(function (p) { return p.key === key; }) || null; },
      set: function (listx) {
        PMS.store.commit(function (d) { d.priorities = listx; }, "set-priorities");
      }
    },

    settings: {
      get: function () { return PMS.store.data.settings; },
      update: function (patch) {
        PMS.store.commit(function (d) {
          Object.keys(patch || {}).forEach(function (k) { d.settings[k] = patch[k]; });
        }, "update-settings");
        return PMS.store.data.settings;
      }
    },

    savedFilters: {
      all: function () { return list("savedFilters"); },
      add: function (obj) {
        obj.id = obj.id || PMS.ids.uuid();
        obj.createdAt = new Date().toISOString();
        PMS.store.commit(function (d) { d.savedFilters.push(obj); }, "add-filter");
        return obj;
      },
      remove: function (id) {
        PMS.store.commit(function (d) {
          d.savedFilters = d.savedFilters.filter(function (f) { return f.id !== id; });
        }, "remove-filter");
      }
    }
  };

  PMS.activity = {
    entries: function () {
      return (PMS.store.data && PMS.store.data.activities) || [];
    },
    clear: function () {
      PMS.store.commit(function (d) { d.activities = []; }, "clear-activities");
      return true;
    },
    limit: LOG_LIMIT
  };
})(window.PMS);