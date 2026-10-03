/* ==========================================================================
   PMS.repositories - typed CRUD accessors over the store.
   All writes go through PMS.store.commit so every view auto-refreshes and
   every mutation is undoable.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;

  // ------- global activity log (ZMS-R06) -------
  // Every create/edit/status/progress/delete is appended to `activities`
  // (newest first, capped). The admin-only "Activity log" view lists them and
  // the cloud sync ships them as an append-only per-record collection
  // (zms_activities) so every device records the same history.
  var LOG_LIMIT = 500;
  var LOGGED_COLLECTIONS = ["tasks", "projects", "people", "departments", "meetings"];
  var LOG_NOISE = ["id", "createdAt", "updatedAt", "activity", "checklist", "comments"];
  // Per-collection key stored on an entry = singular entity name (matches the
  // activity.entities i18n keys and the entity colors in the view).
  var ENTITY_KEY = { tasks: "task", projects: "project", people: "person", departments: "department", meetings: "meeting" };

  function actorName() {
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return u ? (u.name || u.username || u.email || "") : "";
  }

  // Who made a record, kept as plain text as well as an id. The id only
  // resolves on the device that made the record, so the name is stored with
  // it: a task or a meeting then still shows who created it after cloud sync.
  function stampCreator(obj) {
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    if (!u) return obj;
    if (!obj.createdBy) obj.createdBy = u.id;
    if (!obj.createdByName) obj.createdByName = u.name || u.username || u.email || "";
    if (!obj.createdByPersonId && u.personId) obj.createdByPersonId = u.personId;
    // The Firebase uid is the ONLY creator identity that is the same on every
    // device. `createdBy` is a local account id and `createdByPersonId` is
    // absent when the account was never linked to a person, so a manager who
    // created a record on one device could not be recognized as its creator on
    // another — which is why auth.js canDeleteRecord() found nothing to delete
    // and the button never appeared.
    if (!obj.createdByCloudUid && u.cloudUid) obj.createdByCloudUid = u.cloudUid;
    return obj;
  }

  // Attachments are links only (a Google Drive file, a document, a link).
  // Anything that is not http(s) is dropped: the value ends up in href
  // attributes, so only web links may survive.
  function normalizeAttachments(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (a) {
      if (!a) return;
      var raw = String(a.url || a.link || "").trim();
      if (!raw) return;
      if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/+/, "");
      if (!/^https?:\/\//i.test(raw)) return;
      var url = raw;
      var name = String(a.name || a.title || "").trim();
      if (!name) {
        // fall back to something readable: the file name in the URL
        var tail = url.split("?")[0].split("#")[0].split("/").pop();
        name = tail ? decodeURIComponent(tail) : url;
      }
      var kind = a.kind === "link" ? "link" : "drive";
      var dup = out.some(function (x) { return x.url === url; });
      if (dup) return;
      out.push({
        id: a.id || PMS.ids.uuid(),
        name: name.slice(0, 200),
        url: url.slice(0, 1000),
        kind: kind,
        addedAt: a.addedAt || new Date().toISOString(),
        addedBy: a.addedBy || actorName()
      });
    });
    return out;
  }

  function entityLabel(collection, rec) {
    if (!rec) return "";
    if (collection === "tasks" || collection === "meetings") return rec.title || "";
    if (rec.name != null) {
      if (typeof rec.name === "string") return rec.name;
      return rec.name.en || rec.name.ar || "";
    }
    return "";
  }

  function statusLabel(collection, key) {
    if (!key) return "—";
    var list = collection === "project"
      ? PMS.store.data.projectStatuses : PMS.store.data.taskStatuses;
    var s = (list || []).find(function (x) { return x.key === key; });
    return s && s.name ? (s.name.en || s.name.ar || key) : key;
  }

  function makeEntry(collection, rec, action, detail) {
    var now = new Date().toISOString();
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    return {
      id: PMS.ids.uuid(),
      at: now,
      updatedAt: now,
      ts: Date.now(),
      actor: actorName(),
      actorId: u ? u.id : null,
      entity: ENTITY_KEY[collection] || collection,
      entityId: rec ? rec.id : null,
      entityName: entityLabel(collection, rec),
      action: action,
      detail: detail || ""
    };
  }

  function pushLog(d, entry) {
    if (!Array.isArray(d.activities)) d.activities = [];
    d.activities.unshift(entry);
    if (d.activities.length > LOG_LIMIT) d.activities.length = LOG_LIMIT;
  }

  function fieldChanged(prev, cur, key) {
    return JSON.stringify(prev ? prev[key] : undefined) !== JSON.stringify(cur ? cur[key] : undefined);
  }

  // Build (and append) an entry describing what a generic update() changed.
  // Fields the status UI manages itself (activity, comments, clocks) never
  // count as changes, so a plain status/progress touch logs exactly that.
  function logUpdate(d, collection, prev, target, patch) {
    if (LOGGED_COLLECTIONS.indexOf(collection) === -1) return;
    var changed = Object.keys(patch || {}).filter(function (k) {
      return LOG_NOISE.indexOf(k) === -1 && fieldChanged(prev, target, k);
    });
    if (!changed.length) return;
    var entry;
    if (changed.indexOf("status") !== -1) {
      entry = makeEntry(collection, target, "status",
        statusLabel(collection, prev.status) + " → " + statusLabel(collection, target.status));
    } else if (changed.indexOf("progress") !== -1) {
      entry = makeEntry(collection, target, "progress",
        (prev.progress === undefined ? 0 : prev.progress) + "% → " + (target.progress === undefined ? 0 : target.progress) + "%");
    } else {
      entry = makeEntry(collection, target, "updated", changed.join(", "));
    }
    pushLog(d, entry);
  }

  function list(collection) {
    return PMS.store.data[collection] || [];
  }

  function find(collection, id) {
    if (!id) return null;
    return list(collection).find(function (x) { return x.id === id; }) || null;
  }

  // Tell the user a `done` was refused, and name what is still open so they can
  // go and finish it. A count alone ("3 sub-tasks open") leaves the user hunting
  // for which three; listing the first few titles answers it on the spot. Kept
  // here because both refusing paths (update and setStatus) must say the same
  // thing, whichever screen the change came from.
  function warnNotDone(check) {
    if (!PMS.toast) return;
    var titles = (check.titles || []).filter(Boolean);
    var msg = PMS.i18n.t("projects.subtaskNotDone", { n: check.open });
    if (titles.length) {
      // Name the first few so the user can go straight to them, and say how many
      // are left out so the list never reads as the whole story.
      var shown = titles.slice(0, 3).join(", ");
      var rest = titles.length - 3;
      msg += " " + PMS.i18n.t("projects.subtaskNotDoneList", { names: shown });
      if (rest > 0) msg += " " + PMS.i18n.t("projects.subtaskNotDoneMore", { n: rest });
    }
    PMS.toast.show(msg, "error");
  }

  // Members only ever see their own work: the tasks assigned to them (or made
  // by them) and the meetings they attended (or created). Managers and admins
  // see everything.
  //
  // The filter lives HERE, in the single read path every screen goes through,
  // so no view, report or export can hand a member a record they have no
  // business seeing - it is not left to each screen to remember.
  function canViewRecord(collection, rec) {
    if (!rec) return false;
    if (!PMS.auth || !PMS.auth.currentUser) return true;
    var u = PMS.auth.currentUser();
    if (!u || u.role !== "member") return true;
    if (collection === "tasks" && PMS.auth.canViewTask) return PMS.auth.canViewTask(rec);
    if (collection === "meetings" && PMS.auth.canViewMeeting) return PMS.auth.canViewMeeting(rec);
    return true;
  }

  function visible(collection) {
    var all = list(collection);
    if (collection !== "tasks" && collection !== "meetings") return all;
    return all.filter(function (rec) { return canViewRecord(collection, rec); });
  }

  // Same filter for a single record: a member asking for a record that is not
  // theirs gets null (reported as "not found") rather than the record.
  function findVisible(collection, id) {
    var rec = find(collection, id);
    if (!rec) return null;
    return canViewRecord(collection, rec) ? rec : null;
  }

  function add(collection, obj) {
    var now = new Date().toISOString();
    var record = U.deepClone(obj);
    record.id = record.id || PMS.ids.uuid();
    record.createdAt = record.createdAt || now;
    record.updatedAt = now;
    PMS.store.commit(function (d) {
      if (!Array.isArray(d[collection])) d[collection] = [];
      d[collection].push(record);
      if (LOGGED_COLLECTIONS.indexOf(collection) !== -1) pushLog(d, makeEntry(collection, record, "created"));
    }, "add-" + collection);
    return record;
  }

  // Writes one dependency link into place. Module level because both
  // addDependency and setDependency need it and a repo method cannot call its
  // neighbour by bare name. Keeping the pair down to one link is the point:
  // the type describes the two tasks, so a second entry would be two
  // contradictory constraints rather than a stricter one.
  // The type is checked BEFORE normalizing, and that order matters: norm() folds
  // an unknown type to FS so that old or hand-edited data still draws, which
  // would make a check on the normalized value true forever.
  function writeDependency(taskId, predecessorId, type, lag) {
    var t = find("tasks", taskId);
    if (!t) return { error: "notfound" };
    if (type !== undefined && type !== null && type !== "" && !PMS.dependencies.isType(type)) {
      return { error: "type" };
    }
    var dep = PMS.dependencies.norm({ id: predecessorId, type: type, lag: lag });
    var kept = PMS.dependencies.predecessors(t).filter(function (d) { return d.id !== predecessorId; });
    kept.push(dep);
    update("tasks", taskId, { dependencies: kept });
    return dep;
  }

  function update(collection, id, patch) {
    var record = find(collection, id);
    if (!record) return null;
    var prev = U.deepClone(record);
    PMS.store.commit(function (d) {
      var target = d[collection].find(function (x) { return x.id === id; });
      if (target) U.deepClone(patch) && Object.keys(patch || {}).forEach(function (k) {
        target[k] = U.deepClone(patch[k]);
      });
      if (target) target.updatedAt = new Date().toISOString();
      if (target) logUpdate(d, collection, prev, target, patch);
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
          var rec = d.departments.find(function (x) { return x.id === id; });
          d.departments = d.departments.filter(function (x) { return x.id !== id; });
          if (rec) pushLog(d, makeEntry("departments", rec, "deleted"));
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
          if (p) pushLog(d, makeEntry("people", p, "archived"));
        }, "archive-person");
        return true;
      }
    },

    projects: {
      all: function () { return list("projects"); },
      get: function (id) { return find("projects", id); },
      add: function (obj) {
        obj.parentId = obj.parentId || null;
        // Pillars need an owner for the same reason tasks and meetings do:
        // auth.js canDeleteRecord() lets a manager delete a pillar they
        // created, and it can only answer that if the creator was stamped.
        // Without this a manager who created a pillar could never delete it.
        stampCreator(obj);
        // plannedTaskCount is the target number of tasks for this pillar.
        if (obj.plannedTaskCount === undefined || obj.plannedTaskCount === null) obj.plannedTaskCount = 0;
        else obj.plannedTaskCount = Math.max(0, parseInt(obj.plannedTaskCount, 10) || 0);
        if (obj.plannedTasks === undefined || obj.plannedTasks === null) obj.plannedTasks = obj.plannedTaskCount;
        else obj.plannedTasks = Math.max(0, Math.floor(parseInt(obj.plannedTasks,10)||0));
        if (typeof obj.weight !== "number" || isNaN(obj.weight) || obj.weight <= 0) {
          // A record created while `rawWeight` still existed may only carry the
          // old field; adopt it rather than silently resetting the pillar to 1.
          var legacyRw = Number(obj.rawWeight);
          obj.weight = isNaN(legacyRw) || legacyRw <= 0 ? 1 : legacyRw;
        }
        obj.weight = Number(obj.weight);
        delete obj.rawWeight;
        delete obj.defaultTaskImportance;
        return add("projects", obj);
      },
      update: function (id, patch) {
        if (patch && patch.plannedTaskCount !== undefined && patch.plannedTaskCount !== null) {
          patch.plannedTaskCount = Math.max(0, parseInt(patch.plannedTaskCount, 10) || 0);
        }
        if (patch && patch.plannedTasks !== undefined && patch.plannedTasks !== null) {
          patch.plannedTasks = Math.max(0, Math.floor(parseInt(patch.plannedTasks,10)||0));
          if (patch.plannedTaskCount === undefined) patch.plannedTaskCount = patch.plannedTasks;
        }
        if (patch && patch.weight !== undefined && patch.weight !== null) {
          var pw = Number(patch.weight);
          if (isNaN(pw) || pw <= 0) pw = 1;
          patch.weight = pw;
        }
        // Fold a stale rawWeight onto the single weight field, then drop it.
        if (patch && patch.rawWeight !== undefined && patch.rawWeight !== null && patch.weight === undefined) {
          var legacyRw = Number(patch.rawWeight);
          patch.weight = isNaN(legacyRw) || legacyRw <= 0 ? 1 : legacyRw;
        }
        if (patch) delete patch.rawWeight;
        if (patch) delete patch.defaultTaskImportance;
        return update("projects", id, patch);
      },
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
          var root = d.projects.find(function (p) { return p.id === id; });
          d.projects = d.projects.filter(function (p) { return toDelete.indexOf(p.id) === -1; });
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.projectId) === -1; });
          if (root) pushLog(d, makeEntry("projects", root, "deleted"));
        }, "remove-project");
        return true;
      },
      children: function (parentId) {
        return list("projects").filter(function (p) { return p.parentId === parentId; });
      }
    },

    tasks: {
      all: function () { return visible("tasks"); },
      get: function (id) { return findVisible("tasks", id); },
      add: function (obj) {
        obj.parentTaskId = obj.parentTaskId || null;
        obj.meetingId = obj.meetingId || null;
        if (!Array.isArray(obj.linkedTaskIds)) obj.linkedTaskIds = [];
        // dependencies are links with a type and a lag; a bare id list is
        // accepted on input and normalized once, here, so nothing downstream has
        // to cope with both shapes.
        obj.dependencies = PMS.dependencies.normList(obj.dependencies);
        // `priority` is the single importance field; a stale `importance` from
        // before that cleanup is folded in, then dropped.
        var levels = (PMS.programProgress && PMS.programProgress.IMPORTANCE_LEVELS) || ["low", "medium", "high", "urgent"];
        if (levels.indexOf(obj.priority) === -1 && levels.indexOf(obj.importance) !== -1) {
          obj.priority = obj.importance;
        }
        if (levels.indexOf(obj.priority) === -1) obj.priority = "medium";
        delete obj.importance;
        var iw = PMS.programProgress.importanceWeights(PMS.store.data)[obj.priority];
        if (typeof iw !== "number" || isNaN(iw)) iw = 2;
        obj.importanceWeight = iw;
        if (typeof obj.plannedSubtasks !== "number" || isNaN(obj.plannedSubtasks) || obj.plannedSubtasks < 0) obj.plannedSubtasks = (PMS.schema && PMS.schema.defaultData && PMS.schema.defaultData().settings.defaultPlannedSubtasks) || 10;
        obj.plannedSubtasks = Math.max(0, Math.floor(obj.plannedSubtasks));
        if (obj.calculatedProgress === undefined || obj.calculatedProgress === null || isNaN(obj.calculatedProgress)) obj.calculatedProgress = 0;
        stampCreator(obj);
        return add("tasks", obj);
      },
      update: function (id, patch) {
        if (patch) {
          // Same single-field rule as on create: `priority` wins, a stale
          // `importance` is folded in, and the duplicate never gets written.
          var lv = (PMS.programProgress && PMS.programProgress.IMPORTANCE_LEVELS) || ["low", "medium", "high", "urgent"];
          if (patch.importance !== undefined && patch.importance !== null) {
            if (patch.priority === undefined || lv.indexOf(patch.priority) === -1) {
              if (lv.indexOf(patch.importance) !== -1) patch.priority = patch.importance;
            }
            delete patch.importance;
          }
          if (patch.priority !== undefined && patch.priority !== null) {
            if (lv.indexOf(patch.priority) === -1) patch.priority = "medium";
            patch.importanceWeight = PMS.programProgress.importanceWeights(PMS.store.data)[patch.priority];
          }
        }
        if (patch && patch.plannedSubtasks !== undefined && patch.plannedSubtasks !== null) {
          patch.plannedSubtasks = Math.max(0, Math.floor(parseInt(patch.plannedSubtasks,10)||0));
        }
        if (patch && patch.dependencies !== undefined) {
          // A full edit writes the whole predecessor list, so it needs the same
          // two guards `addDependency` applies one edge at a time: normalize the
          // shape, and refuse the write if the finished graph would contain a
          // loop. Self-links and links to deleted tasks are dropped rather than
          // refused, because there is nothing the user could do about them.
          var depRec = find("tasks", id);
          var normDeps = PMS.dependencies.normList(patch.dependencies).filter(function (d) {
            return d.id && d.id !== id && !!find("tasks", d.id);
          });
          if (depRec && PMS.dependencies.wouldCycleWith(PMS.store.data, id, normDeps)) {
            if (PMS.toast) PMS.toast.show(PMS.i18n.t("deps.cycleRefused"), "error");
            return { error: "cycle" };
          }
          patch.dependencies = normDeps;
        }
        // A task may only be marked done once every subtask is done. Enforced
        // here so the rule holds whichever screen (or import) asks for it; the
        // UI checks first and shows the warning.
        if (patch && patch.status === "done") {
          var target = find("tasks", id);
          if (target) {
            var doneCheck = PMS.programProgress.canMarkTaskDone(PMS.store.data, target);
            if (!doneCheck.ok) {
              // Warn here too: a full task edit reaches this path, not setStatus.
              warnNotDone(doneCheck);
              return { error: doneCheck.reason, open: doneCheck.open, titles: doneCheck.titles };
            }
          }
        }
        return update("tasks", id, patch);
      },
      // The one place a task status changes. Every screen funnels through here so the
      // "done means every sub-task is done" rule is enforced in one place and
      // the user gets told why it was refused.
      setStatus: function (id, status) {
        var rec = find("tasks", id);
        if (!rec) return { error: "notFound" };
        if (status === "done") {
          var check = PMS.programProgress.canMarkTaskDone(PMS.store.data, rec);
          if (!check.ok) {
            warnNotDone(check);
            // Same shape as a refused update(), so callers only test `.error`.
            return { error: check.reason, open: check.open, titles: check.titles };
          }
        }
        return update("tasks", id, { status: status });
      },
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
          var root = d.tasks.find(function (t) { return t.id === id; });
          d.tasks = d.tasks.filter(function (t) { return toDelete.indexOf(t.id) === -1; });
          // a task's subtasks are part of that task's scope: they go with it
          if (Array.isArray(d.subtasks)) {
            d.subtasks = d.subtasks.filter(function (s) { return toDelete.indexOf(s.taskId) === -1; });
          }
          d.tasks.forEach(function (t) {
            // links naming a deleted task are dropped. The entry is {id,type,lag}
            // now, but older files hold bare ids and both are read here.
            t.dependencies = (t.dependencies || []).filter(function (dep) {
              var id = typeof dep === "string" ? dep : (dep && (dep.id || dep.taskId));
              return id && toDelete.indexOf(id) === -1;
            });
            // task-to-task links pointing at a deleted task are dropped too
            t.linkedTaskIds = (t.linkedTaskIds || []).filter(function (lid) {
              return toDelete.indexOf(lid) === -1 && lid !== t.id;
            });
          });
          if (root) pushLog(d, makeEntry("tasks", root, "deleted"));
        }, "remove-task");
        return true;
      },
      forProject: function (projectId) {
        return visible("tasks").filter(function (t) { return t.projectId === projectId; });
      },
      children: function (parentTaskId) {
        return visible("tasks").filter(function (t) { return t.parentTaskId === parentTaskId; });
      },
      forMeeting: function (meetingId) {
        return visible("tasks").filter(function (t) { return t.meetingId === meetingId; });
      },
      // ---- typed dependencies: what this task waits on, and what waits on it --
      //
      // These are deliberately separate from linkedTaskIds. A link is "these two
      // are related"; a dependency is an ordering constraint that the schedule
      // and the critical path have to obey, so it is directed, typed, and
      // checked for loops.
      dependenciesOf: function (taskId) {
        var t = findVisible("tasks", taskId);
        return PMS.dependencies.predecessors(t);
      },
      dependentsOf: function (taskId) {
        return PMS.dependencies.successors(PMS.store.data, taskId).filter(function (s) {
          return findVisible("tasks", s.task.id) !== null;
        });
      },
      // Link `predecessorId` in front of `taskId`. Refuses a task depending on
      // itself and any link that would close a loop: a cycle has no earliest
      // start, so it would leave the whole network unanalysable rather than
      // just this task wrong.
      addDependency: function (taskId, predecessorId, type, lag) {
        var t = find("tasks", taskId);
        var p = find("tasks", predecessorId);
        if (!t || !p) return { error: "notfound" };
        if (taskId === predecessorId) return { error: "self" };
        var dep = PMS.dependencies.norm({ id: predecessorId, type: type, lag: lag });
        var current = PMS.dependencies.predecessors(t);
        // Re-linking an existing pair is how its type or lag gets changed, and
        // it cannot loop anything: the edge is already there.
        if (current.some(function (d) { return d.id === predecessorId; })) {
          return writeDependency(taskId, predecessorId, type, lag);
        }
        // taskId already waits on predecessorId further down the chain, so
        // pointing it back at predecessorId closes a loop. This has to be the
        // whole chain, not the direct links: A waits on B and B waits on C, so
        // making C wait on A is just as much a loop as A waiting on C directly.
        if (PMS.dependencies.reaches(PMS.store.data, taskId, predecessorId)) {
          return { error: "cycle" };
        }
        return writeDependency(taskId, predecessorId, type, lag);
      },
      setDependency: function (taskId, predecessorId, type, lag) {
        return writeDependency(taskId, predecessorId, type, lag);
      },
      removeDependency: function (taskId, predecessorId) {
        var t = find("tasks", taskId);
        if (!t) return false;
        var kept = PMS.dependencies.predecessors(t).filter(function (d) { return d.id !== predecessorId; });
        if (kept.length === PMS.dependencies.predecessors(t).length) return false;
        update("tasks", taskId, { dependencies: kept });
        return true;
      },
      // Would linking predecessor -> task close a loop? Checked before the
      // write and re-checked over the stored data, so the editor can grey the
      // option out instead of only reporting the refusal afterwards.
      wouldCycle: function (taskId, predecessorId) {
        if (taskId === predecessorId) return true;
        return PMS.dependencies.reaches(PMS.store.data, taskId, predecessorId);
      },
      // task-to-task links (symmetric stored one-way: A lists B)
      linksOf: function (taskId) {
        var t = findVisible("tasks", taskId);
        return ((t && t.linkedTaskIds) || []).map(function (id) { return findVisible("tasks", id); }).filter(Boolean);
      },
      linkedCount: function (taskId) {
        var t = findVisible("tasks", taskId);
        return t && Array.isArray(t.linkedTaskIds) ? t.linkedTaskIds.length : 0;
      },
      link: function (taskId, otherId) {
        if (!taskId || !otherId || taskId === otherId) return false;
        var t = find("tasks", taskId);
        var o = find("tasks", otherId);
        if (!t || !o) return false;
        if ((t.linkedTaskIds || []).indexOf(otherId) === -1) {
          update("tasks", taskId, { linkedTaskIds: (t.linkedTaskIds || []).concat([otherId]) });
        }
        if ((o.linkedTaskIds || []).indexOf(taskId) === -1) {
          update("tasks", otherId, { linkedTaskIds: (o.linkedTaskIds || []).concat([taskId]) });
        }
        return true;
      },
      unlink: function (taskId, otherId) {
        var t = find("tasks", taskId);
        if (!t) return false;
        if ((t.linkedTaskIds || []).indexOf(otherId) !== -1) {
          update("tasks", taskId, { linkedTaskIds: t.linkedTaskIds.filter(function (id) { return id !== otherId; }) });
        }
        var o = find("tasks", otherId);
        if (o && (o.linkedTaskIds || []).indexOf(taskId) !== -1) {
          update("tasks", otherId, { linkedTaskIds: o.linkedTaskIds.filter(function (id) { return id !== taskId; }) });
        }
        return true;
      }
    },

    // Sub-tasks only MEASURE a task: they distribute the task weight across the
    // planned subtask slots and never add weight of their own (spec 20).
    subtasks: {
      all: function () { return list("subtasks"); },
      get: function (id) { return find("subtasks", id); },
      forTask: function (taskId) {
        return list("subtasks").filter(function (s) { return s.taskId === taskId; });
      },
      completedForTask: function (taskId) {
        return this.forTask(taskId).filter(function (s) {
          return s.status === "done" || Number(s.progress) >= 100;
        });
      },
      add: function (obj) {
        obj.taskId = obj.taskId || null;
        obj.title = obj.title || "";
        obj.status = obj.status || "todo";
        if (typeof obj.progress !== "number" || isNaN(obj.progress)) obj.progress = obj.status === "done" ? 100 : 0;
        stampCreator(obj);
        // Subtasks are the bottom of the tree, so refuse to hang one off
        // another subtask rather than storing a level nothing can display.
        var nest = PMS.programProgress.canNestSubtask(PMS.store.data, obj.taskId);
        if (!nest.ok) return { error: nest.reason };
        return add("subtasks", obj);
      },
      update: function (id, patch) {
        var rec = find("subtasks", id);
        if (patch && rec) {
          var nextTask = patch.taskId === undefined ? rec.taskId : patch.taskId;
          if (nextTask !== rec.taskId) {
            var nest = PMS.programProgress.canNestSubtask(PMS.store.data, nextTask);
            if (!nest.ok) return { error: nest.reason };
          }
        }
        if (patch && patch.status === "done" && patch.progress === undefined) patch.progress = 100;
        return update("subtasks", id, patch);
      },
      remove: function (id) {
        PMS.store.commit(function (d) {
          var rec = d.subtasks.find(function (x) { return x.id === id; });
          d.subtasks = d.subtasks.filter(function (x) { return x.id !== id; });
          if (rec) pushLog(d, makeEntry("subtasks", rec, "deleted"));
        }, "remove-subtask");
        return true;
      }
    },

    meetings: {
      all: function () { return visible("meetings"); },
      get: function (id) { return findVisible("meetings", id); },
      add: function (obj) {
        obj.attendees = Array.isArray(obj.attendees) ? obj.attendees : [];
        obj.agenda = Array.isArray(obj.agenda) ? obj.agenda : [];
        obj.projectIds = Array.isArray(obj.projectIds) ? obj.projectIds : [];
        obj.taskIds = Array.isArray(obj.taskIds) ? obj.taskIds : [];
        obj.status = obj.status || "planned";
        obj.attachments = normalizeAttachments(obj.attachments);
        stampCreator(obj);
        return add("meetings", obj);
      },
      update: function (id, patch) {
        if (patch && Array.isArray(patch.attachments)) patch.attachments = normalizeAttachments(patch.attachments);
        return update("meetings", id, patch);
      },
      // Adds a link to a meeting (or a task) without opening the editor.
      addAttachment: function (id, attachment) {
        var rec = find("meetings", id);
        if (!rec) return null;
        var next = normalizeAttachments((rec.attachments || []).concat([attachment || {}]));
        update("meetings", id, { attachments: next });
        return next;
      },
      removeAttachment: function (id, attachmentId) {
        var rec = find("meetings", id);
        if (!rec) return null;
        var next = (rec.attachments || []).filter(function (a) { return a.id !== attachmentId; });
        update("meetings", id, { attachments: next });
        return next;
      },
      // deleting a meeting never deletes its tasks: they stay in the Tasks tab
      remove: function (id) {
        PMS.store.commit(function (d) {
          var rec = d.meetings.find(function (m) { return m.id === id; });
          d.meetings = d.meetings.filter(function (m) { return m.id !== id; });
          (d.tasks || []).forEach(function (t) { if (t.meetingId === id) t.meetingId = null; });
          if (rec) pushLog(d, makeEntry("meetings", rec, "deleted"));
        }, "remove-meeting");
        return true;
      },
      tasksOf: function (meetingId) {
        return visible("tasks").filter(function (t) { return t.meetingId === meetingId; });
      },
      upcoming: function () {
        var today = PMS.utils.todayISO();
        return visible("meetings").filter(function (m) { return m.date && m.date >= today; })
          .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
      },
      past: function () {
        var today = PMS.utils.todayISO();
        return visible("meetings").filter(function (m) { return m.date && m.date < today; })
          .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      },
      // The meetings a person attended (used by the person card/detail).
      forPerson: function (personId) {
        if (!personId) return [];
        return visible("meetings").filter(function (m) {
          return (m.attendees || []).indexOf(personId) !== -1;
        });
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

  // Account/security events (sign-in, sign-out, role changes, account
  // create/delete/enable/disable, password resets) are NOT part of this array:
  // accounts live in Firebase Auth and never pass through PMS.store, so there
  // is nothing to append to locally. They are written straight to
  // zms_account_events by the sync layer and arrive here as a cloud-only cache,
  // so the admin timeline covers BOTH kinds of action in one list.
  function accountEventRows() {
    var cached = (PMS.store.data && PMS.store.data.accountEvents) || [];
    return cached.map(function (e) {
      var c = U.deepClone(e || {});
      c.entity = c.entity || "account";
      // entityName is the SUBJECT of the action (the account that was changed),
      // while actor is who performed it.
      c.entityName = c.target || c.entityName || c.detail || c.entity;
      c.action = c.action || c.kind || "";
      if (!c.action) c.action = c.detail || "updated";
      c.accountEvent = true;
      return c;
    });
  }

  PMS.activity = {
    // Admin sees the full timeline: project records AND account events,
    // merged newest-first. A member still only sees entries about records they
    // may view, and never any account event (the cloud rules deny them those
    // documents as well, so the client filter is a second line, not the only).
    entries: function () {
      var all = (PMS.store.data && PMS.store.data.activities) || [];
      if (!PMS.auth || !PMS.auth.currentUser) return all;
      var u = PMS.auth.currentUser();
      // No session at all (first paint / signed out): show everything, exactly
      // as before. Only an actual "member" is narrowed — treating a null user
      // as a member would hide entries before anyone has signed in.
      if (!u) return all;
      if (u.role !== "member") {
        return all.concat(accountEventRows()).sort(function (a, b) {
          return String(b.at || b.updatedAt || "").localeCompare(String(a.at || a.updatedAt || ""));
        });
      }
      return all.filter(function (e) {
        if (e.entity === "task") return canViewRecord("tasks", find("tasks", e.entityId)) || !e.entityId;
        if (e.entity === "meeting") return canViewRecord("meetings", find("meetings", e.entityId)) || !e.entityId;
        return e.entity !== "task" && e.entity !== "meeting";
      });
    },
    // Refresh the cloud-only account-event cache. Safe to call anywhere: it
    // resolves with the current list (local cache included) and never throws.
    refreshAccountEvents: function () {
      if (PMS.cloudsync && PMS.cloudsync.accountEvents) return PMS.cloudsync.accountEvents();
      return Promise.resolve(accountEventRows());
    },
    clear: function () {
      PMS.store.commit(function (d) { d.activities = []; }, "clear-activities");
      return true;
    },
    limit: LOG_LIMIT
  };

  // The whole store, with tasks and meetings narrowed by the same visibility
  // rule the repositories use. The dashboard, the pillar pages and the report
  // engine take a "data" object rather than reading one collection at a time,
  // so without this they would quietly total up work the reader may not see.
  // Shallow copy on purpose: the callers only read, and the live arrays stay
  // the single source of truth.
  PMS.repos.scopedData = function () {
    var data = PMS.store.data || {};
    var u = PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    if (!u || u.role !== "member") return data;
    var out = Object.create(null);
    Object.keys(data).forEach(function (k) { out[k] = data[k]; });
    out.tasks = visible("tasks");
    out.meetings = visible("meetings");
    return out;
  };
})(window.PMS);
