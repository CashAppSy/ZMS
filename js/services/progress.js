/* ==========================================================================
   PMS.progress - Progress computation service (pure & testable).
   - task progress: leaf tasks use their own `progress` field (0-100).
     Parent tasks aggregate their sub-tasks (weighted by estimated hours
     when weightByTime is true, otherwise simple mean).
   - project progress: aggregates all tasks in the tree rooted at the project
     plus sub-project progress, again weighted by estimated hours if enabled.
   Exposes only pure helpers that take (data, id) - no DOM access.
   ========================================================================== */
(function (PMS) {
  "use strict";

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

  function taskProgress(data, taskId, weightByTime) {
    var task = (data.tasks || []).find(function (t) { return t.id === taskId; });
    if (!task) return 0;
    var children = taskChildren(data, taskId);
    if (!children.length) {
      return clampProgress(task.progress);
    }
    return aggregate(children, weightByTime);
  }

  // aggregate progress for a flat list of tasks at the same nesting level
  function aggregate(tasks, weightByTime) {
    if (!tasks.length) return 0;
    var total = 0, weight = 0;
    tasks.forEach(function (t) {
      var w = weightByTime && t.estimatedHours ? Number(t.estimatedHours) || 1 : 1;
      total += w * t.progress;
      weight += w;
    });
    return clampProgress(weight ? total / weight : 0);
  }

  function clampProgress(n) {
    n = Number(n) || 0;
    return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
  }

  // total progress for a project = aggregate of its root tasks and sub-projects
  function projectProgress(data, projectId, projectProgressOverride) {
    var weightByTime = !!(data.settings && data.settings.weightByTime);
    var items = collectTreeLeaves(data, projectId, weightByTime);
    if (!items.length) return projectProgressOverride || 0;
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
      var p = taskProgress(data, t.id, weightByTime);
      var w = weightByTime && t.estimatedHours ? Number(t.estimatedHours) || 1 : 1;
      out.push({ weight: w, value: p });
    });
    childrenProjects.forEach(function (child) {
      var cp = projectProgress(data, child.id, 0);
      var w = weightByTime && child.estimatedBudget ? Number(child.estimatedBudget) || 1 : 1;
      out.push({ weight: w, value: cp });
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

  PMS.progress = {
    taskProgress: taskProgress,
    projectProgress: projectProgress,
    allProjectProgress: allProjectProgress,
    taskChildren: taskChildren,
    allTaskTree: allTaskTree
  };
})(window.PMS);