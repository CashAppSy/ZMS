/* ==========================================================================
   PMS.programProgress - the hierarchical Progress & Weight calculation model.

     Program (the whole tool / workspace)
        └─ Pillar   (raw weight -> normalized program share)
             └─ Task  (importance -> task weight; status -> progress ceiling)
                  └─ Subtask (distributes the task weight, never adds any)

   Everything below is pure and takes the store snapshot as `data`, so it is
   deterministic and testable without touching the DOM.

   Key rules implemented (per spec):
     - Pillar raw weight is a RELATIVE number, never a percentage. It is
       normalized against the sum of all pillar weights: raw / total.
     - Program progress = Σ (normalized weight × pillar progress).
     - Planned tasks are expected scope; actual tasks REPLACE planned slots.
       Un-created planned slots stay in the denominator carrying the pillar's
       default-importance weight, so finishing every actual task never fakes
       100% while planned scope is still open.
     - Task status is a CEILING (todo 44.9 / inprogress 74.9 / review 99.9 /
       done 100). Subtask completion earns part of that ceiling. A task with no
       subtask scope reports its plain status progress (0/45/75/100).
     - Pillar closure is EXPLICIT: closing sets status=completed, progress=100
       and freezes the unused planned scope into an audit record instead of
       deleting the original plan.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var IMPORTANCE_LEVELS = ["low", "medium", "high", "urgent"];

  var DEFAULT_IMPORTANCE_WEIGHTS = { low: 1, medium: 2, high: 3, urgent: 4 };

  var DEFAULT_STATUS_CEILINGS = { todo: 44.9, inprogress: 74.9, review: 99.9, done: 100 };

  // A task without subtask scope reports its status progress directly (spec 8).
  var DIRECT_STATUS_PCT = { todo: 0, inprogress: 45, review: 75, done: 100 };

  var DEFAULT_PLANNED_SUBTASKS = 10;

  function clamp(n) {
    var v = Number(n);
    if (isNaN(v) || v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  function round2(n) {
    var v = Number(n);
    if (isNaN(v)) return 0;
    return Math.round(v * 100) / 100;
  }

  function settings(data) {
    return (data && data.settings) || {};
  }

  function importanceWeights(data) {
    var w = settings(data).importanceWeights || {};
    var out = {};
    IMPORTANCE_LEVELS.forEach(function (k) {
      var v = Number(w[k]);
      out[k] = isNaN(v) ? DEFAULT_IMPORTANCE_WEIGHTS[k] : v;
    });
    return out;
  }

  function statusCeilings(data) {
    var c = settings(data).statusCeilings || {};
    var out = {};
    Object.keys(DEFAULT_STATUS_CEILINGS).forEach(function (k) {
      var v = Number(c[k]);
      out[k] = isNaN(v) ? DEFAULT_STATUS_CEILINGS[k] : v;
    });
    return out;
  }

  function defaultPlannedSubtasks(data) {
    var v = Number(settings(data).defaultPlannedSubtasks);
    if (isNaN(v) || v < 0) return DEFAULT_PLANNED_SUBTASKS;
    return Math.floor(v);
  }

  // ---------- Task level ----------

  function taskWeight(data, task) {
    if (!task) return 0;
    var map = importanceWeights(data);
    var key = IMPORTANCE_LEVELS.indexOf(task.importance) !== -1 ? task.importance : "medium";
    // Derived from `importance` every time on purpose: the weights are a
    // configurable setting, so a stored copy would go stale the moment an admin
    // re-tunes them (spec 9).
    return map[key];
  }

  function subtasksOf(data, taskId) {
    return (data.subtasks || []).filter(function (s) { return s && s.taskId === taskId; });
  }

  function isSubtaskDone(sub) {
    if (!sub) return false;
    if (sub.status === "done") return true;
    var p = Number(sub.progress);
    return !isNaN(p) && p >= 100;
  }

  function plannedSubtasksOf(data, task) {
    var n = Number(task && task.plannedSubtasks);
    if (isNaN(n) || n < 0) return defaultPlannedSubtasks(data);
    return Math.floor(n);
  }

  // How much of the task's own weight is done, in percent.
  function taskProgress(data, task) {
    if (!task) return 0;
    var status = task.status || "todo";
    if (status === "done") return 100;

    var planned = plannedSubtasksOf(data, task);
    var actual = subtasksOf(data, task.id).length;
    // A task with no subtasks carries no subtask scope, so its own status is the
    // whole story (spec 8). `plannedSubtasks` only becomes the denominator once
    // there is real subtask work to divide the task's weight across.
    if (!actual) {
      return clamp(DIRECT_STATUS_PCT[status] !== undefined ? DIRECT_STATUS_PCT[status] : 0);
    }

    var completed = subtasksOf(data, task.id).filter(isSubtaskDone).length;
    var ratio = planned > 0 ? completed / planned : 0;
    if (ratio > 1) ratio = 1;

    var ceilings = statusCeilings(data);
    var ceiling = ceilings[status] !== undefined ? ceilings[status] : ceilings.todo;
    return clamp(ratio * ceiling);
  }

  // ---------- Pillar level ----------

  function pillars(data) {
    return (data && data.projects) || [];
  }

  function pillarRawWeight(p) {
    var w = Number(p && p.rawWeight);
    if (isNaN(w) || w <= 0) return 1;
    return w;
  }

  function totalRawWeight(data) {
    return pillars(data).reduce(function (sum, p) { return sum + pillarRawWeight(p); }, 0);
  }

  function normalizedWeight(data, projectId) {
    var total = totalRawWeight(data);
    if (total <= 0) return 0;
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    if (!p) return 0;
    return (pillarRawWeight(p) / total) * 100;
  }

  function plannedTasksOf(p) {
    var n = Number(p && p.plannedTasks);
    if (isNaN(n) || n < 0) {
      n = Number(p && p.plannedTaskCount);
      if (isNaN(n) || n < 0) return 0;
    }
    return Math.floor(n);
  }

  function actualTasksOf(data, projectId) {
    return (data.tasks || []).filter(function (t) { return t && t.projectId === projectId; });
  }

  function completedTasksOf(data, projectId) {
    return actualTasksOf(data, projectId).filter(function (t) { return t.status === "done"; });
  }

  // Everything the pillar UI and the audit record need, in one pass.
  function pillarScope(data, projectId) {
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    var planned = plannedTasksOf(p);
    var actual = p ? actualTasksOf(data, projectId).length : 0;
    var completed = p ? completedTasksOf(data, projectId).length : 0;
    var remaining = Math.max(0, planned - actual);
    var defaultImp = (p && p.defaultTaskImportance) || "medium";
    var defWeight = importanceWeights(data)[IMPORTANCE_LEVELS.indexOf(defaultImp) !== -1 ? defaultImp : "medium"];
    return {
      pillar: p,
      plannedTasks: planned,
      actualTasks: actual,
      completedTasks: completed,
      remainingTasks: remaining,
      defaultTaskImportance: defaultImp,
      defaultTaskWeight: defWeight,
      plannedCapacity: planned * defWeight,
      unusedPlannedCapacity: remaining * defWeight
    };
  }

  function pillarProgress(data, projectId) {
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    if (!p) return 0;
    // Explicit closure wins: a closed pillar is done, whatever is left open.
    if (p.status === "completed") return 100;

    var tasks = actualTasksOf(data, projectId);
    var scope = pillarScope(data, projectId);

    var earned = 0;
    var actualCapacity = 0;
    tasks.forEach(function (t) {
      var w = taskWeight(data, t);
      actualCapacity += w;
      earned += w * (taskProgress(data, t) / 100);
    });

    var capacity = actualCapacity + scope.unusedPlannedCapacity;
    if (capacity <= 0) {
      // Nothing planned and nothing built yet: no contribution to the program.
      if (!tasks.length) return 0;
      var sum = 0;
      tasks.forEach(function (t) { sum += taskProgress(data, t); });
      return clamp(sum / tasks.length);
    }

    return clamp((earned / capacity) * 100);
  }

  // ---------- Program level ----------

// Program progress = Σ (normalized weight × pillar progress).
  // `progressById` lets a caller feed in its own per-pillar numbers (a report may
  // want the stored value, the dashboard the freshly calculated one). Without it
  // the pillars are recalculated here rather than read off the record, because a
  // stored `progress` is a cached snapshot that can lag a task edit.
  function programProgress(data, progressById) {
    var list = pillars(data);
    if (!list.length) return 0;
    var total = totalRawWeight(data);
    if (total <= 0) return 0;
    var sum = 0;
    list.forEach(function (p) {
      var value;
      if (progressById && typeof progressById[p.id] === "number") value = progressById[p.id];
      else value = pillarProgress(data, p.id);
      sum += (pillarRawWeight(p) / total) * value;
    });
    return clamp(sum);
  }

  // ---------- Closure ----------

  var MIN_CLOSURE_NOTE = 50;

  function canClosePillar(data, projectId) {
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    if (!p) return { ok: false, reason: "notFound" };
    if (p.status === "completed") return { ok: false, reason: "alreadyClosed" };
    return { ok: true };
  }

  function validateClosureNote(note) {
    var n = String(note === undefined || note === null ? "" : note).trim();
    if (!n) return { ok: false, reason: "required", min: MIN_CLOSURE_NOTE };
    if (n.length < MIN_CLOSURE_NOTE) return { ok: false, reason: "tooShort", min: MIN_CLOSURE_NOTE, length: n.length };
    return { ok: true, note: n };
  }

  // Freeze the pillar as complete while keeping the original plan intact for
  // reporting: unused planned scope becomes "closed", never deleted.
  function closePillar(data, projectId, note, actor) {
    var check = canClosePillar(data, projectId);
    if (!check.ok) return check;
    var noteCheck = validateClosureNote(note);
    if (!noteCheck.ok) return noteCheck;

    var p = pillars(data).find(function (x) { return x.id === projectId; });
    var scope = pillarScope(data, projectId);
    p.status = "completed";
    p.progress = 100;
    p.closedAt = new Date().toISOString();
    p.closedBy = (actor && (actor.name || actor.displayName)) || (actor && actor.id) || "";
    p.closureNote = noteCheck.note;
    p.closureSnapshot = {
      plannedTasks: scope.plannedTasks,
      actualTasks: scope.actualTasks,
      completedTasks: scope.completedTasks,
      remainingTasks: scope.remainingTasks,
      unusedPlannedCapacity: scope.unusedPlannedCapacity,
      finalProgress: 100
    };
    return { ok: true, pillar: p, snapshot: p.closureSnapshot };
  }

  // ---------- Validation helpers (spec 23) ----------

  function isValidRawWeight(v) {
    var n = Number(v);
    // Whole positive numbers only: a fractional raw weight would make the
    // normalization total unpredictable for the person doing the arithmetic.
    return !isNaN(n) && n > 0 && Math.floor(n) === n;
  }

  function isNonNegativeInt(v) {
    var n = Number(v);
    return !isNaN(n) && n >= 0 && Math.floor(n) === n;
  }

  function isValidImportance(v) {
    return IMPORTANCE_LEVELS.indexOf(v) !== -1;
  }

  function isValidStatus(data, key) {
    var list = (data && data.taskStatuses) || [];
    return list.some(function (s) { return s.key === key; });
  }

  PMS.programProgress = {
    IMPORTANCE_LEVELS: IMPORTANCE_LEVELS,
    DEFAULT_IMPORTANCE_WEIGHTS: DEFAULT_IMPORTANCE_WEIGHTS,
    DEFAULT_STATUS_CEILINGS: DEFAULT_STATUS_CEILINGS,
    DIRECT_STATUS_PCT: DIRECT_STATUS_PCT,
    DEFAULT_PLANNED_SUBTASKS: DEFAULT_PLANNED_SUBTASKS,
    MIN_CLOSURE_NOTE: MIN_CLOSURE_NOTE,
    clamp: clamp,
    round2: round2,
    importanceWeights: importanceWeights,
    statusCeilings: statusCeilings,
    defaultPlannedSubtasks: defaultPlannedSubtasks,
    taskWeight: taskWeight,
    taskProgress: taskProgress,
    subtasksOf: subtasksOf,
    plannedSubtasksOf: plannedSubtasksOf,
    pillarRawWeight: pillarRawWeight,
    totalRawWeight: totalRawWeight,
    normalizedWeight: normalizedWeight,
    plannedTasksOf: plannedTasksOf,
    actualTasksOf: actualTasksOf,
    completedTasksOf: completedTasksOf,
    pillarScope: pillarScope,
    pillarProgress: pillarProgress,
    programProgress: programProgress,
    canClosePillar: canClosePillar,
    validateClosureNote: validateClosureNote,
    closePillar: closePillar,
    isValidRawWeight: isValidRawWeight,
    isNonNegativeInt: isNonNegativeInt,
    isValidImportance: isValidImportance,
    isValidStatus: isValidStatus
  };
})(window.PMS);