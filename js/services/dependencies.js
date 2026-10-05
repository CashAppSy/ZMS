/* ==========================================================================
   PMS.dependencies - the task network: typed links and the critical path.

   A dependency is stored on the successor and names the tasks it waits on:

     task.dependencies = [ { id: <predecessor task id>, type: "FS", lag: 0 } ]

   `type` is the relationship between the two tasks' dates:

     FS  finish-to-start   this cannot start until the predecessor finishes
     SS  start-to-start    this cannot start until the predecessor starts
     FF  finish-to-finish  this cannot finish until the predecessor finishes
     SF  start-to-finish   this cannot finish until the predecessor starts

   `lag` is whole days added to the constraint; a positive lag waits longer, a
   negative one overlaps the two tasks on purpose.

   A bare id string is still accepted and read as FS with no lag, which is what
   this field held before types existed, so old data and old exports keep
   working without a rewrite.

   THE CRITICAL PATH is the longest chain through the network: the tasks whose
   slip pushes the end of the program. It is worked out from task DURATIONS, not
   from the dates on the bars. A network is about how much work sits in each
   link; the dates on screen are where someone chose to schedule that work, and a
   task can be scheduled late or dragged early without leaving the chain. Bar
   positions still come from the dates - this only decides which tasks are on
   the chain and how much slack each one has.

   Only tasks that are actually LINKED are ever marked. A task with no
   predecessors and no successors is not on a chain, so there is no path through
   it that can be late - see the note on the marking itself below.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var DAY = 86400000;
  var TYPES = ["FS", "FF", "SS", "SF"];
  var EPS = 1e-6;

  function isType(t) { return TYPES.indexOf(t) !== -1; }

  function clampLag(n) {
    n = Math.round(Number(n));
    return isNaN(n) ? 0 : n;
  }

  // One link as { id, type, lag }. Accepts the bare ids this field used to hold
  // and rejects anything that cannot name a task.
  function norm(dep) {
    if (!dep) return null;
    if (typeof dep === "string") return dep ? { id: dep, type: "FS", lag: 0 } : null;
    if (typeof dep !== "object") return null;
    var id = dep.id || dep.taskId;
    if (!id) return null;
    return {
      id: id,
      type: isType(dep.type) ? dep.type : "FS",
      lag: clampLag(dep.lag !== undefined ? dep.lag : dep.lagDays)
    };
  }

  // One link per pair of tasks: the type describes the pair, so a second entry
  // for the same predecessor would be two contradictory constraints, not a
  // stronger one. First mention wins, which keeps a duplicate from quietly
  // changing an existing link's type.
  function normList(deps) {
    if (!Array.isArray(deps)) return [];
    var out = [], seen = {};
    deps.forEach(function (d) {
      var n = norm(d);
      if (!n || seen[n.id]) return;
      seen[n.id] = true;
      out.push(n);
    });
    return out;
  }

  function predecessors(task) { return normList(task && task.dependencies); }

  // The other direction: tasks that list this one as a predecessor.
  function successors(data, taskId) {
    var out = [];
    (data.tasks || []).forEach(function (t) {
      if (!t || t.id === taskId) return;
      predecessors(t).forEach(function (dep) {
        if (dep.id === taskId) out.push({ task: t, dep: dep });
      });
    });
    return out;
  }

  // Every edge in the network, predecessor first. A link naming a task that is
  // gone (deleted, or invisible to this user) is not an edge - it is a leftover,
  // and counting it would hang a task waiting on work nobody can see.
  function edges(data) {
    var byId = {};
    (data.tasks || []).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var out = [];
    (data.tasks || []).forEach(function (t) {
      if (!t) return;
      predecessors(t).forEach(function (dep) {
        var from = byId[dep.id];
        if (!from) return;
        out.push({
          from: from, to: t, fromId: from.id, toId: t.id,
          type: dep.type, lag: dep.lag, dep: dep
        });
      });
    });
    return out;
  }

  // Does `fromId` already wait on `toId`, directly or anywhere down the chain?
  //
  // This is the question behind refusing a loop. It has to be the whole chain:
  // if A waits on B and B waits on C, then making C wait on A closes the same
  // loop as making A wait on C directly, and a check that only looked at the
  // direct links would wave the first one through and leave the network
  // unanalysable after the fact.
  function reaches(data, fromId, toId) {
    if (!fromId || !toId) return false;
    var seen = {}, queue = [fromId], found = false;
    while (queue.length && !found) {
      var id = queue.shift();
      if (id === toId) { found = true; break; }
      if (seen[id]) continue;
      seen[id] = true;
      (data.tasks || []).forEach(function (t) {
        if (!t || t.id === id) return;
        predecessors(t).forEach(function (dep) {
          if (dep.id === id) queue.push(t.id);
        });
      });
    }
    return found;
  }

  // Would replacing one task's whole predecessor list with `deps` close a loop?
  //
  // Checking the pairs one by one is not enough: a batch can be acyclic on its
  // own and cyclic once the task's OLD edges are still in place, or the other
  // way round. So the question is asked of the finished graph - the candidate
  // data with the new list already swapped in - which is the only thing the
  // user will actually end up with.
  function wouldCycleWith(data, taskId, deps) {
    var tasks = data.tasks || [];
    var candidate = {
      tasks: tasks.map(function (x) {
        return x.id === taskId ? Object.assign({}, x, { dependencies: deps }) : x;
      })
    };
    return analyze(candidate).cyclic === true;
  }

  // Length of a task in whole days. Both ends count, the way the gantt draws a
  // bar, so a one-day task measures 1 rather than 0. A task with no dates still
  // occupies a slot, or every link through it would look free.
  function durationDays(task) {
    var s = PMS.utils.parseDate(task && task.startDate);
    var e = PMS.utils.parseDate(task && task.dueDate);
    if (!s && !e) return 1;
    if (!s) s = e;
    if (!e) e = s;
    var d = Math.round((e - s) / DAY) + 1;
    return d > 0 ? d : 1;
  }

  // The constraint written as "the earliest this successor may start", in the
  // predecessor's own coordinates. FF and SF constrain the successor's FINISH,
  // so they come back as a start by subtracting the successor's own length.
  function earliestStart(dep, pES, pEF, sDur) {
    switch (dep.type) {
      case "SS": return pES + dep.lag;
      case "FF": return pEF + dep.lag - sDur;
      case "SF": return pES + dep.lag - sDur;
      default: return pEF + dep.lag;             // FS
    }
  }

  // The same constraint read backwards: the latest this predecessor may finish
  // without pushing the successor past its own late dates. The mirror of the
  // table above, and the two have to agree or the float comes out negative.
  function latestFinish(dep, sLS, sLF, pDur) {
    switch (dep.type) {
      case "FS": return sLS - dep.lag;
      case "SS": return sLS - dep.lag + pDur;
      case "FF": return sLF - dep.lag;
      default: return sLF - dep.lag + pDur;     // SF
    }
  }

  /* --------------------------------------------------------------------------
     Longest-path analysis.

     Forward pass: each task starts as early as the network allows.
     Backward pass: each task gets the latest start that still ends the program
                    on time.
     Float is the gap between the two, and no float means no delay can be
     absorbed here, which is exactly what "critical" means.

     Kahn's algorithm does the ordering and finds cycles for free: if not every
     task comes out, the network loops. A loop has no longest path - asking for
     the critical path through it has no answer - so the caller gets an empty
     critical set rather than a confident wrong one.
     -------------------------------------------------------------------------- */
  function analyze(data, opts) {
    opts = opts || {};
    var tasks = (data.tasks || []).filter(function (t) { return t && t.id; });
    var dur = {}, es = {}, ef = {}, ls = {}, lf = {}, slack = {}, critical = {};
    var preds = {}, succs = {}, indeg = {}, order = [], queue = [];
    var i, id, e;

    for (i = 0; i < tasks.length; i++) {
      id = tasks[i].id;
      dur[id] = opts.duration ? opts.duration(tasks[i]) : durationDays(tasks[i]);
      es[id] = 0; ef[id] = 0; ls[id] = 0; lf[id] = 0;
      preds[id] = []; succs[id] = [];
      indeg[id] = 0;
    }

    edges(data).forEach(function (link) {
      if (!(link.fromId in dur) || !(link.toId in dur)) return;
      preds[link.toId].push(link);
      succs[link.fromId].push(link);
      indeg[link.toId]++;
    });

    for (i = 0; i < tasks.length; i++) if (indeg[tasks[i].id] === 0) queue.push(tasks[i].id);
    while (queue.length) {
      id = queue.shift();
      order.push(id);
      succs[id].forEach(function (link) {
        if (--indeg[link.toId] === 0) queue.push(link.toId);
      });
    }

    var cyclic = order.length !== tasks.length;
    var result = {
      cyclic: cyclic, critical: critical, slack: slack, dur: dur,
      es: es, ef: ef, ls: ls, lf: lf, order: order, length: 0
    };
    if (cyclic) return result;

    // forward
    order.forEach(function (tid) {
      preds[tid].forEach(function (link) {
        var want = earliestStart(link.dep, es[link.fromId], ef[link.fromId], dur[tid]);
        if (want > es[tid]) es[tid] = want;
      });
      ef[tid] = es[tid] + dur[tid];
    });
    var end = 0, endLinked = 0, anyLinked = false;
    order.forEach(function (tid) {
      if (ef[tid] > end) end = ef[tid];
      // The end the chains are measured against is the end of the NETWORK. An
      // unlinked task is not on a chain, so it has no say in when the program
      // ends: letting it set that date handed every real chain a fortnight of
      // free float and left the actual critical path unmarked, because the
      // longest loose task in the dataset had pushed the deadline past it. With
      // nothing linked at all there is no network to measure, so the longest
      // single task still sets the reported length.
      if (!preds[tid].length && !succs[tid].length) return;
      anyLinked = true;
      if (ef[tid] > endLinked) endLinked = ef[tid];
    });
    if (anyLinked) end = endLinked;
    result.length = end;

    // backward: successors are already resolved because we walk in reverse order
    for (i = order.length - 1; i >= 0; i--) {
      id = order[i];
      if (!succs[id].length) {
        lf[id] = end;
      } else {
        var best = end;
        succs[id].forEach(function (link) {
          var cap = latestFinish(link.dep, ls[link.toId], lf[link.toId], dur[id]);
          if (cap < best) best = cap;
        });
        // The end of the program is a hard deadline for every task, not just
        // the last one. Seeding `best` with it matters for SS/FF/SF, whose caps
        // come back as a start plus a length and can land past the end - a task
        // allowed to finish after the program ends would report slack it cannot
        // actually spend, and the task that really sets the end would lose its
        // critical marking.
        lf[id] = best;
      }
      ls[id] = lf[id] - dur[id];
    }

    order.forEach(function (tid) {
      slack[tid] = Math.max(0, ls[tid] - es[tid]);
      // A task with no links is not on a chain at all, so it cannot be ON the
      // critical path - there is no path through it to be late on. Leaving it
      // out is not a detail: the backward pass pins every successor-less task
      // to the end of the program, and the forward pass starts every
      // predecessor-less task at zero, so an UNLINKED task's float works out to
      // exactly "how much longer the program is than this task is". The single
      // longest loose task in the dataset therefore always measured zero float
      // and was badged critical while the real chains sat beside it with slack.
      // Its length still counts towards the program end - that part is right -
      // but it is not marked, because "a delay here moves the end" is a claim
      // about a chain and this task is not on one.
      if (!preds[tid].length && !succs[tid].length) return;
      if (slack[tid] <= EPS) critical[tid] = true;
    });
    return result;
  }

  // Views render many rows at once and the network is a whole-program question,
  // so the answer is worked out once per data version and shared. The key is the
  // store's own updatedAt plus the task count, which changes on every commit.
  var cache = { key: null, value: null };

  function analyzeCached(data) {
    var meta = (data && data.meta) || {};
    var key = (meta.updatedAt || "") + ":" + ((data && data.tasks) || []).length;
    if (cache.key !== key) {
      cache = { key: key, value: analyze(data) };
    }
    return cache.value;
  }

  function isCritical(result, taskId) {
    return !!(result && !result.cyclic && result.critical[taskId]);
  }

  function slackOf(result, taskId) {
    if (!result || result.cyclic) return null;
    var v = result.slack[taskId];
    return v === undefined ? null : v;
  }

  /* --------------------------------------------------------------------------
     Waiting, and broken promises.

     A task is blocked while a predecessor is unfinished. "Finished" is asked of
     the progress engine rather than read off the status label, so work sitting
     at 99.9% still holds the gate shut - the same rule that keeps the status
     from being flipped to done.
     -------------------------------------------------------------------------- */
  function isTaskDone(data, task) {
    if (!task) return true;
    if (PMS.programProgress && PMS.programProgress.taskProgress) {
      return PMS.programProgress.taskProgress(data, task) >= 100;
    }
    return task.status === "done";
  }

  // Has this task begun any work? Asked of the progress engine rather than read
  // off the status label, so a task sitting at 0.1% through its band still counts
  // as started - the same "ask the engine, trust the number" rule as above.
  function hasStarted(data, task) {
    if (!task) return true;
    if (isTaskDone(data, task)) return true;
    if (PMS.programProgress && PMS.programProgress.taskProgress) {
      return PMS.programProgress.taskProgress(data, task) > 0;
    }
    return task.status !== "todo";
  }

  /* --------------------------------------------------------------------------
     The gate each relationship puts in front of the successor.

     What a link waits for is read off its OWN type, because that is what the
     type means:

       FS  finish-to-start   tied to the predecessor's FINISH  -> wait for done
       FF  finish-to-finish  tied to the predecessor's FINISH  -> wait for done
       SS  start-to-start    tied to the predecessor's START   -> wait for started
       SF  start-to-finish   tied to the predecessor's START   -> wait for started

     Treating every type as "wait until the predecessor is done" would be wrong
     for the two links that hang off a START: a start-to-start pair is meant to
     run side by side, so holding it back until the predecessor finishes would
     deadlock two tasks the plan deliberately overlaps. And treating every type
     as "wait for started" would let a successor finish early on a finish-to-
     finish link it was supposed to land alongside.

     `isSatisfied` above answers a different question - whether the DATES on the
     two bars honour the link - so a link can be satisfied on paper while the
     work itself has not happened yet. This is the work gate; that is the
     calendar one.
     -------------------------------------------------------------------------- */
  function gateOpen(data, dep, pred) {
    if (!pred) return true;
    if (isTaskDone(data, pred)) return true;
    if (dep.type === "SS" || dep.type === "SF") return hasStarted(data, pred);
    return false;
  }

  function blocking(data, task) {
    if (!task) return [];
    // A finished task is waiting on nothing: its gate opened on the way in, so
    // painting it Blocked now would contradict the status shown beside it.
    if (isTaskDone(data, task)) return [];
    var open = [];
    var byId = {};
    (data.tasks || []).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    predecessors(task).forEach(function (dep) {
      var p = byId[dep.id];
      if (!p || gateOpen(data, dep, p)) return;
      open.push({ task: p, dep: dep });
    });
    return open;
  }

  function isBlocked(data, task) {
    return blocking(data, task).length > 0;
  }

  // Has this link been kept on the schedule as written? Only answerable when
  // both tasks carry the dates the type needs; otherwise it is unknown and the
  // caller should not paint a verdict.
  function isSatisfied(dep, pred, succ) {
    var pS = PMS.utils.parseDate(pred.startDate), pE = PMS.utils.parseDate(pred.dueDate);
    var sS = PMS.utils.parseDate(succ.startDate), sE = PMS.utils.parseDate(succ.dueDate);
    var need = null;
    // .getTime() and not `date + days`: adding a number to a Date object uses the
    // default primitive hint, which for a Date is its toString(), so the result
    // is a string like "Fri Jan 02 2026 ...0" and every comparison against it
    // silently reads as false.
    switch (dep.type) {
      case "SS": if (pS && sS) need = pS.getTime() + dep.lag * DAY; break;
      case "FF": if (pE && sE) need = pE.getTime() + dep.lag * DAY; break;
      case "SF": if (pS && sE) need = pS.getTime() + dep.lag * DAY; break;
      default: if (pE && sS) need = pE.getTime() + dep.lag * DAY; break;   // FS
    }
    if (need === null) return null;
    var have = (dep.type === "SS" || dep.type === "FS") ? sS : sE;
    return have.getTime() >= need;
  }

  function label(type) {
    return {
      FS: PMS.i18n.t("deps.typeFS"),
      FF: PMS.i18n.t("deps.typeFF"),
      SS: PMS.i18n.t("deps.typeSS"),
      SF: PMS.i18n.t("deps.typeSF")
    }[type] || type;
  }

  PMS.dependencies = {
    TYPES: TYPES,
    DAY: DAY,
    isType: isType,
    norm: norm,
    normList: normList,
    predecessors: predecessors,
    successors: successors,
    edges: edges,
    reaches: reaches,
    wouldCycleWith: wouldCycleWith,
    durationDays: durationDays,
    analyze: analyze,
    analyzeCached: analyzeCached,
    isCritical: isCritical,
    slackOf: slackOf,
    blocking: blocking,
    isBlocked: isBlocked,
    isTaskDone: isTaskDone,
    hasStarted: hasStarted,
    gateOpen: gateOpen,
    isSatisfied: isSatisfied,
    label: label
  };
})(window.PMS);