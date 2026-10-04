/* ==========================================================================
   PMS.reports - Report engine. Each report is registered with an id, a
   generator function returning {columns, rows}, and optional chart data.
   registry pattern: PMS.reports.register({...}).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var defs = [];

  function register(def) {
    defs.push(def);
    return def;
  }

  function all() { return defs; }

  function get(id) { return defs.find(function (d) { return d.id === id; }); }

  function generate(id, data, options) {
    var d = get(id);
    if (!d) return null;
    return d.generate(data, options || {});
  }

  /* ------------ built-in reports ------------ */

  function row(name, values) { return Object.assign({ name: name }, values); }

  /* Every report counts the same thing, so the numbers on two cards can never
     disagree: MAIN tasks only, and "finished" asked of the progress engine
     rather than read off the status label.

     A breakdown task belongs to its parent - its progress is already inside the
     parent's - so counting it again would report one piece of work twice and
     make the total move every time somebody split a task in two. Asking the
     engine also means work parked at 99.9% is not reported as complete, which
     is the same line the status rules draw everywhere else. */
  function mainTasks(data, projectId) {
    return (data.tasks || []).filter(function (t) {
      if (!t || t.parentTaskId) return false;
      return projectId === undefined || t.projectId === projectId;
    });
  }

  function isDone(data, task) {
    if (PMS.programProgress && PMS.programProgress.taskProgress) {
      return PMS.programProgress.taskProgress(data, task) >= 100;
    }
    return task.status === "done";
  }

  // The pillar's owner. Projects carry a manager, which is the person answerable
  // for the pillar; a pillar with nobody assigned says so rather than a dash that
  // reads like a missing value.
  function ownerName(project, data) {
    var person = (data.people || []).find(function (p) { return p.id === project.managerId; });
    if (!person || !person.name) return "-";
    // A name is stored either as a plain string or as {en, ar}. Returning the raw
    // value put "[object Object]" in the cell for anyone who had typed their name
    // in both languages; handing that object straight to trilingual() is the other
    // half of the same trap, because trilingual only reads .en/.ar and answers ""
    // for a plain string - which blanks the owner for everyone who typed one name.
    var who = person.name;
    return typeof who === "string" ? who : PMS.i18n.trilingual(who)(who);
  }

  register({
    id: "projectStatus",
    titleKey: "reports.report_projectStatus",
    generate: function (data) {
      var prog = PMS.programProgress.allPillarProgress(data);
      var rows = (data.projects || []).filter(function (p) { return !p.parentId; }).map(function (p) {
        var mine = mainTasks(data, p.id);
        var doneCount = mine.filter(function (t) { return isDone(data, t); }).length;
        return row(p.name, {
          owner: ownerName(p, data),
          status: p.status, priority: p.priority,
          progress: prog[p.id],
          tasks: mine.length,
          completed: doneCount,
          start: p.startDate, end: p.endDate
        });
      });
      return {
        columns: ["name", "owner", "status", "priority", "progress", "tasks", "completed", "start", "end"],
        rows: rows,
        cellTypes: { progress: "progress" }
      };
    }
  });

  register({
    id: "taskStatus",
    titleKey: "reports.report_taskStatus",
    generate: function (data) {
      var counts = {};
      var statusesMap = {}, statusColors = {};
      (data.taskStatuses || []).forEach(function (s) {
        statusesMap[s.key] = s.name;
        if (s.color) statusColors[s.key] = s.color;
      });
      var main = mainTasks(data);
      main.forEach(function (t) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      });
      var rows = Object.keys(counts).map(function (k) {
        var r = row((statusesMap[k] && statusesMap[k].en) || k, { count: counts[k] });
        r.key = k; // keep the status key so charts can pick the true status color
        return r;
      });
      return {
        columns: ["name", "count"],
        rows: rows,
        chart: { type: "donut", values: rows, label: "name", value: "count", colorMap: statusColors }
      };
    }
  });

  register({
    id: "taskPriority",
    titleKey: "reports.report_taskPriority",
    generate: function (data) {
      var counts = {}, priorityMap = {};
      (data.priorities || []).forEach(function (p) { priorityMap[p.key] = p.name; });
      mainTasks(data).forEach(function (t) { counts[t.priority] = (counts[t.priority] || 0) + 1; });
      var rows = Object.keys(counts).map(function (k) {
        return row((priorityMap[k] && priorityMap[k].en) || k, { count: counts[k] });
      });
      return {
        columns: ["name", "count"], rows: rows,
        chart: { type: "donut", values: rows, label: "name", value: "count" }
      };
    }
  });

  register({
    id: "taskDepartment",
    titleKey: "reports.report_taskDepartment",
    generate: function (data) {
      var deptName = {}, counts = {};
      (data.departments || []).forEach(function (d) { deptName[d.id] = d.name; });
      mainTasks(data).forEach(function (t) {
        var seen = {};
        (t.assignees || []).forEach(function (pid) {
          var person = (data.people || []).find(function (p) { return p.id === pid; });
          if (!person) return;
          var d = person.departmentId || "none";
          if (seen[d]) return; seen[d] = true;
          counts[d] = (counts[d] || 0) + 1;
        });
      });
      var rows = Object.keys(counts).map(function (k) {
        return row(k === "none" ? "-" : (deptName[k] && deptName[k].en) || k, { count: counts[k] });
      });
      return { columns: ["name", "count"], rows: rows };
    }
  });

  register({
    id: "taskPerson",
    titleKey: "reports.report_taskPerson",
    generate: function (data) {
      var counts = {};
      mainTasks(data).forEach(function (t) {
        (t.assignees || []).forEach(function (pid) {
          counts[pid] = (counts[pid] || 0) + 1;
        });
      });
      var rows = Object.keys(counts).map(function (pid) {
        var person = (data.people || []).find(function (p) { return p.id === pid; });
        return row(person ? person.name : "?", { count: counts[pid], personId: pid });
      });
      return { columns: ["name", "count"], rows: rows };
    }
  });

  register({
    id: "lateTasks",
    titleKey: "reports.report_lateTasks",
    generate: function (data) {
      var today = PMS.utils.todayISO();
      var rows = mainTasks(data)
        .filter(function (t) {
          return t.dueDate && t.dueDate < today && !isDone(data, t);
        })
        .map(function (t) {
          var proj = (data.projects || []).find(function (p) { return p.id === t.projectId; });
          return row(t.title, {
            project: proj ? proj.name : "-", due: t.dueDate, status: t.status, priority: t.priority, person: assigneeNames(t, data)
          });
        });
      return { columns: ["title", "project", "due", "status", "priority", "person"], rows: rows };
    }
  });

  register({
    id: "workload",
    titleKey: "reports.report_workload",
    generate: function (data) {
      var map = {};
      (data.people || []).forEach(function (p) {
        map[p.id] = { name: p.name, open: 0, done: 0, late: 0, estimate: 0, actual: 0, total: 0 };
      });
      var today = PMS.utils.todayISO();
      var main = mainTasks(data);
      main.forEach(function (t) {
        (t.assignees || []).forEach(function (pid) {
          var m = map[pid];
          if (!m) return;
          m.total++;
          m.estimate += Number(t.estimatedHours) || 0;
          m.actual += Number(t.actualHours) || 0;
          if (isDone(data, t)) m.done++; else m.open++;
          if (t.dueDate && t.dueDate < today && !isDone(data, t)) m.late++;
        });
      });
      var rows = Object.keys(map).map(function (pid) {
        var m = map[pid];
        return row(m.name, { open: m.open, done: m.done, late: m.late, estimate: m.estimate, actual: m.actual, total: m.total, personId: pid });
      });
      return {
        columns: ["name", "open", "done", "late", "estimate", "actual", "total"],
        rows: rows
      };
    }
  });

  register({
    id: "hours",
    titleKey: "reports.report_hours",
    generate: function (data) {
      var rows = (data.projects || []).filter(function (p) { return !p.parentId; }).map(function (p) {
        var tasks = mainTasks(data, p.id);
        var est = 0, act = 0;
        tasks.forEach(function (t) {
          est += Number(t.estimatedHours) || 0;
          act += Number(t.actualHours) || 0;
        });
        return row(p.name, { estimate: est, actual: act, variance: act - est, projectId: p.id });
      });
      return { columns: ["name", "estimate", "actual", "variance"], rows: rows };
    }
  });

  // There is deliberately no budget report here, and no budget column on the
  // pillar report above. Budgeting is not part of this tool, and the pillar
  // report was the only remaining place a money figure reached the screen - the
  // projects keep the field in the model, but it is not reported.

  function assigneeNames(task, data) {
    return (task.assignees || []).map(function (pid) {
      var p = (data.people || []).find(function (x) { return x.id === pid; });
      return p ? p.name : "?";
    }).join(", ");
  }

  PMS.reports = {
    register: register, all: all, get: get, generate: generate,
    mainTasks: mainTasks, isDone: isDone
  };
})(window.PMS);