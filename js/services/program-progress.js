/* ==========================================================================
   PMS.programProgress - the hierarchical Progress & Weight calculation model.

Program (the whole tool / workspace)
        └─ Pillar   (weight -> normalized program share)
              └─ Task  (priority -> task weight; status -> progress band)
                   └─ Subtask (distributes the task weight, never adds any)

   Everything below is pure and takes the store snapshot as `data`, so it is
   deterministic and testable without touching the DOM.

Key rules implemented (per spec):
     - A pillar's weight is a RELATIVE number, never a percentage. It is
       normalized against the sum of all pillar weights: weight / total.
     - Program progress = SUM (normalized weight x pillar progress).
     - PLANNED SCOPE IS A SLOT BUDGET. `plannedTasks` counts LOW-priority
       slots (low weighs 1). A real task spends slots equal to its own
       priority weight: low 1, medium 2, high 3, urgent 4. The capacity is
       therefore FIXED by the plan, so creating a task can never move progress
       - only its own completion can. That is what stops "I added a task and my
       progress went down".
     - Task status is a BAND, not just a ceiling. With subtasks, the earned
       ratio (completed / planned) is scaled into the band:
         todo        0 .. 44.9
         inprogress  45 .. 74.9   (all subtasks done lands on 74.9)
         review      75 .. 99
         done        100, and only when EVERY subtask is done.
       A task with no subtasks reports its plain status progress (0/45/75/100).
     - Subtasks are FLAT: a subtask can never own a subtask of its own.
     - Pillar closure is EXPLICIT: closing sets status=completed, progress=100
       and freezes the unused planned scope into an audit record instead of
       deleting the original plan.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var IMPORTANCE_LEVELS = ["low", "medium", "high", "urgent"];

  var DEFAULT_IMPORTANCE_WEIGHTS = { low: 1, medium: 2, high: 3, urgent: 4 };

  var DEFAULT_STATUS_CEILINGS = { todo: 44.9, inprogress: 74.9, review: 99, done: 100 };

  // Each task status owns a progress BAND. Subtask completion earns part of the
  // way through its own band, so the reported progress can never read lower or
  // higher than the status promises (spec 8 / 11).
  var STATUS_BANDS = {
    todo: { min: 0, max: 44.9 },
    inprogress: { min: 45, max: 74.9 },
    review: { min: 75, max: 99 },
    done: { min: 100, max: 100 }
  };

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
    // The task's own `priority` is the single source of importance. A separate
    // `importance` field used to sit beside it and duplicated it exactly, so it
    // is read only as a fallback for records saved before that cleanup.
    var key = IMPORTANCE_LEVELS.indexOf(task.priority) !== -1
      ? task.priority
      : (IMPORTANCE_LEVELS.indexOf(task.importance) !== -1 ? task.importance : "medium");
    // Derived from the priority every time on purpose: the weights are a
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

  function statusBand(data, status) {
    var ceilings = statusCeilings(data);
    var band = STATUS_BANDS[status] || STATUS_BANDS.todo;
    // An admin may retune a ceiling inside its band, but the hard limits below
    // are part of the spec: a stored setting can never push a band wider.
    var max = ceilings[status] !== undefined ? ceilings[status] : band.max;
    if (max < band.min) max = band.min;
    if (max > band.max) max = band.max;
    return { min: band.min, max: max };
  }

  // Each subtask carries an equal slice of the task's own weight. Subtasks
  // therefore never add weight to the program, they only divide it (spec 20).
  function subtaskWeight(data, task) {
    var n = subtasksOf(data, task && task.id).length;
    if (!n) return 0;
    return taskWeight(data, task) / n;
  }

  function openSubtasksOf(data, task) {
    return subtasksOf(data, task && task.id).filter(function (s) { return !isSubtaskDone(s); });
  }

  // A task may only be `done` once every one of its subtasks is done. This is
  // the check the UI warns with, so the rule lives in one place.
  function canMarkTaskDone(data, task) {
    if (!task) return { ok: false, reason: "notFound" };
    // No "already done" shortcut here on purpose: a record that was forced to
    // done while a sub-task was open still has to report the open sub-task.
    var open = openSubtasksOf(data, task);
    if (open.length) {
      return { ok: false, reason: "openSubtasks", open: open.length, titles: open.map(function (s) { return s.title; }) };
    }
    return { ok: true };
  }

  // How much of the task's own weight is done, in percent.
  function taskProgress(data, task) {
    if (!task) return 0;
    var status = task.status || "todo";

    // `done` is a claim about the whole task, so it is only honoured when the
    // subtasks agree. Otherwise the task is held at the top of `review`.
    if (status === "done") return canMarkTaskDone(data, task).ok ? 100 : 99;

    var planned = plannedSubtasksOf(data, task);
    var subs = subtasksOf(data, task.id);
    // A task with no subtasks carries no subtask scope, so its own status is the
    // whole story (spec 8). `plannedSubtasks` only becomes the denominator once
    // there is real subtask work to divide the task's weight across.
    if (!subs.length) {
      return clamp(DIRECT_STATUS_PCT[status] !== undefined ? DIRECT_STATUS_PCT[status] : 0);
    }

    var completed = subs.filter(isSubtaskDone).length;
    var ratio = planned > 0 ? completed / planned : 0;
    if (ratio > 1) ratio = 1;

    // Scale the earned ratio into the band this status promises, so "all
    // subtasks done" always reads as the top of the band rather than a number
    // borrowed from a different status.
    var band = statusBand(data, status);
    if (ratio >= 1) return clamp(band.max);
    return clamp(band.min + ratio * (band.max - band.min));
  }

  // ---------- Pillar level ----------

  function pillars(data) {
    return (data && data.projects) || [];
  }

  // The pillar's own weight. `weight` is the pre-existing field and the only one:
  // a second "rawWeight" beside it meant the same number lived in two places.
  function pillarRawWeight(p) {
    var w = Number(p && p.weight);
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

  // Only TOP-LEVEL tasks hold planned slots. A task flagged as somebody's
  // sub-task (parentTaskId) is a breakdown of its parent, so counting it as
  // capacity would inflate the scope twice - and it disagreed with every other
  // screen, which all filtered those out already.
  function actualTasksOf(data, projectId) {
    return (data.tasks || []).filter(function (t) {
      return t && t.projectId === projectId && !t.parentTaskId;
    });
  }

  function completedTasksOf(data, projectId) {
    // `done` only counts when the sub-tasks agree, so a record that was forced
    // to done (legacy data, a hand-edited import) is not reported as complete.
    return actualTasksOf(data, projectId).filter(function (t) {
      return t.status === "done" && canMarkTaskDone(data, t).ok;
    });
  }

  // Everything the pillar UI and the audit record need, in one pass.
  // `plannedTasks` counts LOW slots, and low weighs 1, so the planned capacity
  // is simply the planned count. A real task spends slots equal to its own
  // priority weight, which is why capacity never changes when one is added.
  function pillarScope(data, projectId) {
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    var planned = plannedTasksOf(p);
    var tasks = p ? actualTasksOf(data, projectId) : [];
    var capacity = planned;
    var spent = 0;
    var earned = 0;
    tasks.forEach(function (t) {
      var w = taskWeight(data, t);
      spent += w;
      earned += w * (taskProgress(data, t) / 100);
    });
    var completed = completedTasksOf(data, projectId).length;
    return {
      pillar: p,
      plannedTasks: planned,
      plannedCapacity: capacity,
      actualTasks: tasks.length,
      completedTasks: completed,
      // Slots still unspent, in low-task equivalents. This is the scope a
      // closure writes off, so it must never go negative.
      slotsSpent: spent,
      remainingTasks: Math.max(0, capacity - spent),
      overcommittedSlots: Math.max(0, spent - capacity),
      unusedPlannedCapacity: Math.max(0, capacity - spent),
      earnedCapacity: earned
    };
  }

  function pillarProgress(data, projectId) {
    var p = pillars(data).find(function (x) { return x.id === projectId; });
    if (!p) return 0;
    // Explicit closure wins: a closed pillar is done, whatever is left open.
    if (p.status === "completed") return 100;

    var tasks = actualTasksOf(data, projectId);
    var scope = pillarScope(data, projectId);

    // No plan to measure against: fall back to the plain average so a pillar
    // still shows something honest instead of dividing by zero.
    if (scope.plannedCapacity <= 0) {
      if (!tasks.length) return 0;
      var sum = 0;
      tasks.forEach(function (t) { sum += taskProgress(data, t); });
      return clamp(sum / tasks.length);
    }

    return clamp((scope.earnedCapacity / scope.plannedCapacity) * 100);
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

  // Per-pillar values on the same engine, for the list and any report that
  // shows every pillar at once. Reuses the fresh calculation, never a stored
  // snapshot, so a task edit shows up immediately.
  function allPillarProgress(data) {
    var out = {};
    pillars(data).forEach(function (p) { out[p.id] = pillarProgress(data, p.id); });
    return out;
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
      slotsSpent: scope.slotsSpent,
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

  // Subtasks are the bottom of the tree: they may hang off a task, never off
  // another subtask. The UI calls this before saving so the user gets told
  // instead of silently losing the deeper level.
  function canNestSubtask(data, parentId) {
    if (!parentId) return { ok: true };
    var all = (data && data.subtasks) || [];
    var isSubtask = all.some(function (s) { return s && s.id === parentId; });
    if (isSubtask) return { ok: false, reason: "subtaskOfSubtask" };
    var isTask = ((data && data.tasks) || []).some(function (t) { return t && t.id === parentId; });
    if (!isTask) return { ok: false, reason: "unknownParent" };
    return { ok: true };
  }

  PMS.programProgress = {
    IMPORTANCE_LEVELS: IMPORTANCE_LEVELS,
    DEFAULT_IMPORTANCE_WEIGHTS: DEFAULT_IMPORTANCE_WEIGHTS,
    DEFAULT_STATUS_CEILINGS: DEFAULT_STATUS_CEILINGS,
    STATUS_BANDS: STATUS_BANDS,
    DIRECT_STATUS_PCT: DIRECT_STATUS_PCT,
    DEFAULT_PLANNED_SUBTASKS: DEFAULT_PLANNED_SUBTASKS,
    MIN_CLOSURE_NOTE: MIN_CLOSURE_NOTE,
    clamp: clamp,
    round2: round2,
    importanceWeights: importanceWeights,
    statusCeilings: statusCeilings,
    statusBand: statusBand,
    defaultPlannedSubtasks: defaultPlannedSubtasks,
    taskWeight: taskWeight,
    taskProgress: taskProgress,
    subtasksOf: subtasksOf,
    openSubtasksOf: openSubtasksOf,
    subtaskWeight: subtaskWeight,
    canMarkTaskDone: canMarkTaskDone,
    canNestSubtask: canNestSubtask,
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
    allPillarProgress: allPillarProgress,
    canClosePillar: canClosePillar,
    validateClosureNote: validateClosureNote,
    closePillar: closePillar,
    isValidRawWeight: isValidRawWeight,
    isNonNegativeInt: isNonNegativeInt,
    isValidImportance: isValidImportance,
    isValidStatus: isValidStatus
  };
})(window.PMS);