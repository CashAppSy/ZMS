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

  register({
    id: "projectStatus",
    titleKey: "reports.report_projectStatus",
    generate: function (data) {
      var prog = PMS.progress.allProjectProgress(data);
      var rows = (data.projects || []).filter(function (p) { return !p.parentId; }).map(function (p) {
        return row(p.name, {
          status: p.status, priority: p.priority,
          progress: prog[p.id], budget: p.budget || 0, start: p.startDate, end: p.endDate
        });
      });
      return {
        columns: ["name", "status", "priority", "progress", "budget", "start", "end"],
        rows: rows,
        cellTypes: { budget: "money", progress: "progress" }
      };
    }
  });

  register({
    id: "taskStatus",
    titleKey: "reports.report_taskStatus",
    generate: function (data) {
      var counts = {};
      var statusesMap = {};
      (data.taskStatuses || []).forEach(function (s) { statusesMap[s.key] = s.name; });
      (data.tasks || []).forEach(function (t) {
        counts[t.status] = (counts[t.status] || 0) + 1;
      });
      var rows = Object.keys(counts).map(function (k) {
        return row((statusesMap[k] && statusesMap[k].en) || k, { count: counts[k] });
      });
      return {
        columns: ["name", "count"],
        rows: rows,
        chart: { type: "donut", values: rows, label: "name", value: "count", colorMap: hueMap(Object.keys(counts)) }
      };
    }
  });

  register({
    id: "taskPriority",
    titleKey: "reports.report_taskPriority",
    generate: function (data) {
      var counts = {}, priorityMap = {};
      (data.priorities || []).forEach(function (p) { priorityMap[p.key] = p.name; });
      (data.tasks || []).forEach(function (t) { counts[t.priority] = (counts[t.priority] || 0) + 1; });
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
      (data.tasks || []).forEach(function (t) {
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
      (data.tasks || []).forEach(function (t) {
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
      var rows = (data.tasks || [])
        .filter(function (t) {
          return t.dueDate && t.dueDate < today && t.status !== "done";
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
      (data.tasks || []).forEach(function (t) {
        (t.assignees || []).forEach(function (pid) {
          var m = map[pid];
          if (!m) return;
          m.total++;
          m.estimate += Number(t.estimatedHours) || 0;
          m.actual += Number(t.actualHours) || 0;
          if (t.status === "done") m.done++; else m.open++;
          if (t.dueDate && t.dueDate < today && t.status !== "done") m.late++;
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
        var tasks = (data.tasks || []).filter(function (t) { return t.projectId === p.id; });
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

  register({
    id: "budget",
    titleKey: "reports.report_budget",
    generate: function (data) {
      var rows = (data.projects || []).filter(function (p) { return !p.parentId; }).map(function (p) {
        var tasks = (data.tasks || []).filter(function (t) { return t.projectId === p.id; });
        var budget = Number(p.budget) || 0;
        var used = 0;
        tasks.forEach(function (t) { used += Number(t.actualHours) || 0; }); // approximation: hours as cost proxy
        return row(p.name, { budget: budget, used: used, remaining: budget - used, projectId: p.id });
      });
      return { columns: ["name", "budget", "used", "remaining"], rows: rows, cellTypes: { budget: "money", used: "money", remaining: "money" } };
    }
  });

  function assigneeNames(task, data) {
    return (task.assignees || []).map(function (pid) {
      var p = (data.people || []).find(function (x) { return x.id === pid; });
      return p ? p.name : "?";
    }).join(", ");
  }

  function hueMap(keys) {
    var m = {};
    var palette = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#ca8a04", "#9333ea"];
    keys.forEach(function (k, i) { m[k] = palette[i % palette.length]; });
    return m;
  }

  PMS.reports = { register: register, all: all, get: get, generate: generate };
})(window.PMS);