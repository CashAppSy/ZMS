/* ==========================================================================
   PMS.repositories - typed CRUD accessors over the store.
   All writes go through PMS.store.commit so every view auto-refreshes and
   every mutation is undoable.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;

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
    }, "add-" + collection);
    return record;
  }

  function update(collection, id, patch) {
    var record = find(collection, id);
    if (!record) return null;
    PMS.store.commit(function (d) {
      var target = d[collection].find(function (x) { return x.id === id; });
      if (target) U.deepClone(patch) && Object.keys(patch || {}).forEach(function (k) {
        target[k] = U.deepClone(patch[k]);
      });
      if (target) target.updatedAt = new Date().toISOString();
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
          d.departments = d.departments.filter(function (x) { return x.id !== id; });
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
          d.projects = d.projects.filter(function (p) { return toDelete.indexOf(p.id) === -1; });
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.projectId) === -1; });
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
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.id) === -1; });
          d.tasks.forEach(function (t) {
            t.dependencies = (t.dependencies || []).filter(function (dep) {
              return toDelete.indexOf(dep) === -1;
            });
          });
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
})(window.PMS);