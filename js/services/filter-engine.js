/* ==========================================================================
   PMS.filterEngine - multi-criteria filtering + search + sort + group.
   Built from a query object:
     { search, projectId, personId, departmentId, status:[...], priority:[...],
       tags:[...], from, to, lateOnly, customFields:{id:value} }
   ========================================================================== */
(function (PMS) {
  "use strict";

  function normalize(t) { return String(t || "").trim().toLowerCase(); }

  // Does a task match the given query?
  function matchTask(task, query, ctx) {
    var data = ctx.data;
    var s = normalize(query.search);
    if (s) {
      var hay = normalize(task.title + " " + (task.description || "") + " " + (task.tags || []).join(" "));
      if (hay.indexOf(s) === -1) return false;
    }
    if (query.projectId && task.projectId !== query.projectId) return false;
    if (query.personId) {
      var assigns = task.assignees || [];
      if (assigns.indexOf(query.personId) === -1) return false;
    }
    if (query.departmentId) {
      var hit = false;
      (task.assignees || []).forEach(function (pid) {
        var person = (data.people || []).find(function (p) { return p.id === pid; });
        if (person && person.departmentId === query.departmentId) hit = true;
      });
      if (!hit) return false;
    }
    if (query.status && query.status.length && query.status.indexOf(task.status) === -1) return false;
    if (query.priority && query.priority.length && query.priority.indexOf(task.priority) === -1) return false;
    if (query.tags && query.tags.length) {
      var tt = task.tags || [];
      var ok = query.tags.every(function (tag) { return tt.indexOf(tag) !== -1; });
      if (!ok) return false;
    }
    if (query.from || query.to) {
      var due = task.dueDate || task.startDate;
      if (!due) return false;
      if (query.from && due < query.from) return false;
      if (query.to && due > query.to) return false;
    }
    if (query.lateOnly) {
      var due2 = task.dueDate;
      if (!due2 || due2 >= PMS.utils.todayISO()) return false;
      if (task.status === "done") return false;
    }
    if (query.customFields) {
      var cfs = task.customFields || {};
      for (var k in query.customFields) {
        var want = query.customFields[k];
        if (want === undefined || want === null || want === "") continue;
        if (String(cfs[k] !== undefined ? cfs[k] : "") !== String(want)) return false;
      }
    }
    return true;
  }

  // Filter a task list
  function filterTasks(tasks, query, data) {
    query = query || {};
    return tasks.filter(function (t) { return matchTask(t, query, { data: data }); });
  }

  // Filter a project list (by name/desc/status/priority/manager/member/tags)
  function filterProjects(projects, query, data) {
    query = query || {};
    var s = normalize(query.search);
    return projects.filter(function (p) {
      if (s) {
        var hay = normalize(p.name + " " + (p.description || "") + " " + (p.tags || []).join(" "));
        if (hay.indexOf(s) === -1) return false;
      }
      if (query.status && query.status.length && query.status.indexOf(p.status) === -1) return false;
      if (query.priority && query.priority.length && query.priority.indexOf(p.priority) === -1) return false;
      if (query.personId && p.managerId !== query.personId && (p.members || []).indexOf(query.personId) === -1) return false;
      if (query.departmentId) {
        var mgr = (data.people || []).find(function (x) { return x.id === p.managerId; });
        if (!mgr || mgr.departmentId !== query.departmentId) return false;
      }
      return true;
    });
  }

  /* ------- sorting ------- */
  var sorters = {
    title: function (a, b) { return String(a.title || "").localeCompare(String(b.title || "")); },
    project: function (a, b, data) {
      var an = nameOfProject(a.projectId, data), bn = nameOfProject(b.projectId, data);
      return an.localeCompare(bn);
    },
    status: function (a, b) { return (a.status || "").localeCompare(b.status || ""); },
    priority: function (a, b) {
      return (orderOfPriority(b, "p") - orderOfPriority(a, "p"));
    },
    start: function (a, b) { return (a.startDate || "").localeCompare(b.startDate || ""); },
    due: function (a, b) { return (a.dueDate || "").localeCompare(b.dueDate || ""); },
    estimated: function (a, b) { return (a.estimatedHours || 0) - (b.estimatedHours || 0); },
    actual: function (a, b) { return (a.actualHours || 0) - (b.actualHours || 0); },
    progress: function (a, b, data) {
      var d = data || PMS.store.data;
      var wb = d.settings && d.settings.weightByTime;
      var pa = PMS.progress.taskProgress(d, a.id, wb), pb = PMS.progress.taskProgress(d, b.id, wb);
      return pa - pb;
    },
    created: function (a, b) { return (a.createdAt || "").localeCompare(b.createdAt || ""); }
  };

  function orderOfPriority(task, kind) {
    var key = task.priority;
    var prios = PMS.store.data.priorities;
    var p = prios.find(function (x) { return x.key === key; });
    return p ? p.order : 0;
  }

  function nameOfProject(projectId, data) {
    if (!projectId) return "";
    var p = (data.projects || []).find(function (x) { return x.id === projectId; });
    return p ? p.name : "";
  }

  function sortTasks(tasks, key, dir, data) {
    var fn = sorters[key] || sorters.title;
    return tasks.slice().sort(function (a, b) {
      var r = fn(a, b, data || PMS.store.data);
      return dir === "desc" ? -r : r;
    });
  }

  /* ------- grouping ------- */
  function groupBy(tasks, key, data) {
    var groups = {};
    tasks.forEach(function (t) {
      var g;
      if (key === "project") g = t.projectId || "none";
      else if (key === "status") g = t.status || "none";
      else if (key === "priority") g = t.priority || "none";
      else g = "none";
      (groups[g] = groups[g] || []).push(t);
    });
    return groups;
  }

  PMS.filterEngine = {
    matchTask: matchTask,
    filterTasks: filterTasks,
    filterProjects: filterProjects,
    sortTasks: sortTasks,
    groupBy: groupBy,
    sorters: sorters
  };
})(window.PMS);