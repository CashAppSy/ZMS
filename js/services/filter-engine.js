/* ==========================================================================
   PMS.filterEngine - multi-criteria filtering + search + sort + group.
   Built from a query object:
     { search, projectId, personId, departmentId, status:[...], priority:[...],
       tags:[...], from, to, lateOnly, blockedOnly, criticalOnly, mainOnly,
       customFields:{id:value} }

   The status and priority keys are accepted in BOTH shapes: the array form
   (`status: ["done","review"]`) and the singular form the filter bar and older
   saved filters use (`statusKey: "done"`). Reading only the arrays left the
   toolbar's Status and Priority selects wired to nothing at all - the query was
   built, stored and counted in the "N filters" badge, and never matched a row.
   ========================================================================== */
(function (PMS) {
  "use strict";

  function normalize(t) { return String(t || "").trim().toLowerCase(); }

  // A list of allowed keys from either shape, so one comparison covers both.
  function keysOf(value, single) {
    var out = [];
    if (Array.isArray(value)) out = value.filter(Boolean);
    else if (value) out = [value];
    if (single) out.push(single);
    return out.filter(Boolean);
  }

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
    var wantedStatus = keysOf(query.status, query.statusKey);
    if (wantedStatus.length && wantedStatus.indexOf(task.status) === -1) return false;
    var wantedPriority = keysOf(query.priority, query.priorityKey);
    if (wantedPriority.length && wantedPriority.indexOf(task.priority) === -1) return false;
    if (query.tags && query.tags.length) {
      var tt = task.tags || [];
      var ok = query.tags.every(function (tag) { return tt.indexOf(tag) !== -1; });
      if (!ok) return false;
    }
    // `from`/`to` bracket the task's due date, falling back to its start date for
    // a task that has no deadline yet - otherwise every open-ended task would
    // vanish from a date-filtered list, which reads as "the filter is broken".
    if (query.from || query.to) {
      var due = task.dueDate || task.startDate;
      if (!due) return false;
      if (query.from && due < query.from) return false;
      if (query.to && due > query.to) return false;
    }
    if (query.startFrom || query.startTo) {
      var sd = task.startDate;
      if (!sd) return false;
      if (query.startFrom && sd < query.startFrom) return false;
      if (query.startTo && sd > query.startTo) return false;
    }
    if (query.lateOnly) {
      var due2 = task.dueDate;
      if (!due2 || due2 >= PMS.utils.todayISO()) return false;
      if (task.status === "done") return false;
    }
    // The three questions a plan gets asked about its work: what is stuck behind
    // something else, what has no slack left, and what is the plan actually made
    // of as opposed to what has been broken out into pieces.
    if (query.mainOnly && task.parentTaskId) return false;
    if (query.blockedOnly && !(PMS.dependencies && PMS.dependencies.isBlocked(data, task))) return false;
    if (query.criticalOnly) {
      if (!PMS.dependencies) return false;
      if (!PMS.dependencies.isCritical(PMS.dependencies.analyzeCached(data), task.id)) return false;
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
      // Same engine every other screen sorts and displays with, so sorting by
      // progress orders the numbers the user actually sees.
      var pa = PMS.programProgress.taskProgress(d, a), pb = PMS.programProgress.taskProgress(d, b);
      return pa - pb;
    },
    created: function (a, b) { return (a.createdAt || "").localeCompare(b.createdAt || ""); },
    number: function (a, b) {
      // A task's number IS its rank by creation order, so sorting on that same
      // key sorts by the number the user sees - with no id->number map rebuilt
      // on every comparison, which would make a sort quadratic.
      var ca = String(a.createdAt || ""), cb = String(b.createdAt || "");
      if (ca !== cb) return ca < cb ? -1 : 1;
      return String(a.id || "") < String(b.id || "") ? -1 : 1;
    },
    createdBy: function (a, b) {
      return PMS.vformat.creatorOf(a).localeCompare(PMS.vformat.creatorOf(b));
    }
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