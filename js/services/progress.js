/* ==========================================================================
   PMS.progress - Progress computation service (pure & testable).
   - task progress is DERIVED from the task status: a leaf task contributes
     the pct of its status (todo=0, inprogress=45, review=75, done=100 — an
     admin can tune the pct per status in Settings). There is no manually-set
     per-task progress value anymore.
   - parent tasks aggregate their sub-tasks (weighted by estimated hours when
     weightByTime is true, otherwise simple mean).
   - project progress: aggregates all tasks in the tree rooted at the project
     plus sub-project progress, again weighted by estimated hours if enabled.
   Exposes only pure helpers that take (data, id) - no DOM access.
   ========================================================================== */
(function (PMS) {
  "use strict";

  // Fallback pct for well-known status keys when a status record has no pct
  // (covers older data imported without the field).
  var FALLBACK_PCT = {
    todo: 0, inprogress: 45, review: 75, done: 100,
    planned: 0, active: 45, completed: 100, cancelled: 0, onhold: 10
  };

  // Priority weight (when not weighting by estimated hours)
  var PRIORITY_WEIGHT = {
    low: 0.5,
    medium: 1.0,
    high: 1.5,
    urgent: 2.0
  };
  var DEFAULT_PLANNED_WEIGHT = PRIORITY_WEIGHT.medium;

  function taskChildren(data, id) {
    return (data.tasks || []).filter(function (t) { return t.parentTaskId === id; });
  }

  function projectDirectTasks(data, projectId) {
    return (data.tasks || []).filter(function (t) { return t.projectId === projectId && !t.parentTaskId; });
  }

  function allTaskTree(data, rootId) {
    var out = [];
    function walk(id) {
      taskChildren(data, id).forEach(function (c) {
        out.push(c);
        walk(c.id);
      });
    }
    walk(rootId);
    return out;
  }

  function isInProjectTree(data, task, projectId) {
    if (!task || !projectId) return false;
    if (task.projectId === projectId) return true;
    // check if task's project is descendant of projectId
    function isDesc(pid, target) {
      if (!pid) return false;
      if (pid === target) return true;
      var p = (data.projects || []).find(function (x) { return x.id === pid; });
      return p && p.parentId ? isDesc(p.parentId, target) : false;
    }
    return isDesc(task.projectId, projectId);
  }

  // percentage a single status maps to (0-100); falls back by key name
  function statusPct(data, statusKey) {
    var s = (data.taskStatuses || []).find(function (x) { return x.key === statusKey; });
    if (s && typeof s.pct === "number" && !isNaN(s.pct)) return clampProgress(s.pct);
    if (FALLBACK_PCT[statusKey] !== undefined) return FALLBACK_PCT[statusKey];
    return 0;
  }

  function taskProgress(data, taskId, weightByTime) {
    var task = (data.tasks || []).find(function (t) { return t.id === taskId; });
    if (!task) return 0;
    var children = taskChildren(data, taskId);
    if (!children.length) {
      return statusPct(data, task.status);
    }
    return aggregate(data, children, weightByTime);
  }

  // The weight a task claims inside its pillar (progress weighting):
  // a leaf task claims its own unit (estimated hours when weightByTime is on,
  // otherwise 1). A parent task DOES NOT claim extra weight on top of its
  // children — its allocated weight is SPLIT between its sub-tasks (and, in
  // turn, between their sub-tasks), so a task with N children distributes its
  // quota among them. A fully-done task therefore delivers the full share that
  // was allocated to it.
  function taskWeightAttr(data, task, weightByTime) {
    var children = taskChildren(data, task.id);
    if (!children.length) {
      if (weightByTime && task.estimatedHours) {
        return Number(task.estimatedHours) || priorityWeight(task);
      }
      return priorityWeight(task);
    }
    var sum = 0;
    children.forEach(function (c) { sum += taskWeightAttr(data, c, weightByTime); });
    return sum;
  }

  function priorityWeight(task) {
    var p = task && task.priority;
    if (PRIORITY_WEIGHT[p] !== undefined) return PRIORITY_WEIGHT[p];
    return PRIORITY_WEIGHT.medium;
  }

  // aggregate progress for a flat list of tasks at the same nesting level
  function aggregate(data, tasks, weightByTime) {
    if (!tasks.length) return 0;
    var total = 0, weight = 0;
    tasks.forEach(function (t) {
      var w = taskWeightAttr(data, t, weightByTime);
      total += w * taskProgress(data, t.id, weightByTime);
      weight += w;
    });
    return clampProgress(weight ? total / weight : 0);
  }

  function clampProgress(n) {
    n = Number(n) || 0;
    return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
  }

  // A pillar's influence on the Overall progress: its explicit weight field.
  // Defaults to 1 for older data (or the estimated budget when the
  // "weight by time" setting is on), so existing projects behave unchanged.
  function pillarWeight(data, p) {
    var w = Number(p && p.weight);
    if (isFinite(w) && w >= 0) return w;
    if (data && data.settings && data.settings.weightByTime && p && Number(p.estimatedBudget) > 0) {
      return Number(p.estimatedBudget);
    }
    return 1;
  }

  // total progress for a project = aggregate of its root tasks and sub-projects
  function projectProgress(data, projectId, projectProgressOverride) {
    var weightByTime = !!(data.settings && data.settings.weightByTime);
    var proj = (data.projects || []).find(function (p) { return p.id === projectId; });
    if (proj && proj.status === "completed") return 100;
    var items = collectTreeLeaves(data, projectId, weightByTime);
    if (!items.length) return projectProgressOverride || 0;
    // planned/actual: if a plan exists, measure toward it from done tasks
    var planned = proj && typeof proj.plannedTaskCount === "number" ? proj.plannedTaskCount : 0;
    if (planned > 0) {
      var total = 0, weight = 0;
      (data.tasks || []).forEach(function (t) {
        if (isInProjectTree(data, t, projectId)) {
          var w = taskWeightAttr(data, t, weightByTime);
          total += w * taskProgress(data, t.id, weightByTime);
          weight += w;
        }
      });
      var plannedWeight = planned * DEFAULT_PLANNED_WEIGHT;
      if (plannedWeight <= 0) {
        var total2 = 0, weight2 = 0;
        (data.tasks || []).forEach(function (t) {
          if (isInProjectTree(data, t, projectId)) {
            var w2 = taskWeightAttr(data, t, weightByTime);
            total2 += w2 * taskProgress(data, t.id, weightByTime);
            weight2 += w2;
          }
        });
        return clampProgress(weight2 ? total2 / weight2 : 0);
      }
      return clampProgress(Math.min(100, Math.round((total * 100) / plannedWeight)));
    }
    var total = 0, weight = 0;
    items.forEach(function (it) {
      total += it.weight * it.value;
      weight += it.weight;
    });
    return clampProgress(weight ? total / weight : 0);
  }

  // Flatten to a list of {weight, value} contributions from tasks + sub-projects.
  function collectTreeLeaves(data, projectId, weightByTime) {
    var out = [];
    var proj = (data.projects || []).find(function (p) { return p.id === projectId; });
    if (!proj) return out;
    var rootTasks = projectDirectTasks(data, projectId);
    var childrenProjects = (data.projects || []).filter(function (p) { return p.parentId === projectId; });

    rootTasks.forEach(function (t) {
      var p2 = taskProgress(data, t.id, weightByTime);
      out.push({ weight: taskWeightAttr(data, t, weightByTime), value: p2 });
    });
    childrenProjects.forEach(function (child) {
      var cp = projectProgress(data, child.id, 0);
      out.push({ weight: pillarWeight(data, child), value: cp });
    });
    return out;
  }

  // Convenience: progress of every project (map by id)
  function allProjectProgress(data) {
    var map = {};
    (data.projects || []).forEach(function (p) {
      map[p.id] = projectProgress(data, p.id, 0);
    });
    return map;
  }

  // OVERALL progress across ALL pillars at every level, weighted by each
  // pillar's own weight — the heavier a pillar, the bigger its share of the
  // total. Every pillar contributes its own DIRECT task progress × its weight,
  // so sub-pillars participate next to top-level ones. A parent pillar's
  // weight is only counted for its own direct tasks: a pure "folder" pillar
  // (all work lives in its sub-pillars) contributes no separate weight, so its
  // sub-pillars carry it — no double counting and no dilution. Zero-weight and
  // empty pillars are ignored. When no pillar has direct work, falls back to
  // the average of leaf task progress.
  function overallProgress(data) {
    var projects = data.projects || [];
    var tasks = data.tasks || [];
    var weightByTime = !!(data.settings && data.settings.weightByTime);
    var total = 0, wsum = 0, count = 0;
    projects.forEach(function (p) {
      var w = pillarWeight(data, p);
      if (!(w > 0)) return;
      var own = projectDirectTasks(data, p.id);
      if (!own.length) return; // weight delegates to this pillar's sub-pillars
      total += w * aggregate(data, own, weightByTime);
      wsum += w;
      count++;
    });
    if (count && wsum > 0) return clampProgress(total / wsum);
    var sum = 0, n = 0;
    tasks.forEach(function (tsk) {
      if (!taskChildren(data, tsk.id).length) { sum += statusPct(data, tsk.status); n++; }
    });
    return n ? clampProgress(sum / n) : 0;
  }

  PMS.progress = {
    taskProgress: taskProgress,
    projectProgress: projectProgress,
    allProjectProgress: allProjectProgress,
    statusPct: statusPct,
    taskChildren: taskChildren,
    projectDirectTasks: projectDirectTasks,
    allTaskTree: allTaskTree,
    taskWeightAttr: taskWeightAttr,
    pillarWeight: pillarWeight,
    overallProgress: overallProgress
  };
})(window.PMS);