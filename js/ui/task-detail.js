/* ==========================================================================
   PMS.taskDetail - full task detail modal: description, assignees, dates,
   progress slider, checklist, sub-tasks, comments, activity log,
   dependencies, custom fields.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  function open(taskId) {
    // repos.tasks.get already hides a task the signed-in member may not see,
    // so this is the single gate: a task outside their scope simply does not
    // open, from any screen that links to it.
    var task = PMS.repos.tasks.get(taskId);
    if (!task) { PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error"); return; }
    currentTaskId = taskId;
    detailOpen = true;
    renderBody(task);
  }

  var currentTaskId = null;
  var detailOpen = false;
  // Marks the detail modal as gone so a later store change (e.g. an inline
  // status change in the table) does not re-open it over another dialog.
  function markClosed() { detailOpen = false; }
  PMS.bus.on("store:changed", function () {
    if (!PMS.modal.isOpen || !detailOpen || !currentTaskId) return;
    // only re-open when the task detail is really the dialog on screen
    if (!PMS.modal.body || !PMS.modal.body.querySelector(".task-detail-body")) { detailOpen = false; return; }
    PMS.modal.close();
    open(currentTaskId);
  });

  function renderBody(task) {
    PMS.modal.open({
      title: task.title,
      size: "lg",
      content: function () {
        var node = h("div.stack.task-detail-body");

        // meta row
        var meta = h("div.detail-list");
        meta.appendChild(metaItem(t("tasks.project"), projectName(task.projectId)));
        meta.appendChild(metaItem(t("tasks.status"), statusName(task.status)));
        meta.appendChild(metaItem(t("tasks.priority"), priorityName(task.priority)));
        meta.appendChild(metaItem(t("tasks.startDate"), PMS.utils.formatDate(task.startDate, PMS.i18n)));
        meta.appendChild(metaItem(t("tasks.dueDate"), PMS.utils.formatDate(task.dueDate, PMS.i18n)));
        meta.appendChild(metaItem(t("tasks.estimated"), PMS.utils.hours(task.estimatedHours, PMS.i18n)));
        meta.appendChild(metaItem(t("tasks.actual"), PMS.utils.hours(task.actualHours, PMS.i18n)));
        meta.appendChild(metaItem(t("tasks.createdBy"), PMS.vformat.creatorOf(task) || "—"));
        node.appendChild(meta);

        // progress (derived from status — no manual value)
        var canFull = !PMS.auth || PMS.auth.can("tasks.write");
        var derived = PMS.progress.taskProgress(PMS.store.data, task.id, PMS.store.data.settings.weightByTime);
        var progressRow = h("div.field");
        progressRow.appendChild(h("label", { text: t("tasks.progress") + " (" + PMS.utils.pct(derived) + ")" }));
        progressRow.appendChild(PMS.vformat.progressChip(derived));
        if (!canFull) progressRow.appendChild(h("div.hint", { text: t("tasks.progressFromStatus") }));
        node.appendChild(progressRow);

        if (task.description) node.appendChild(h("div.card", [h("div.card-body", [h("p", { text: task.description })])]));
        if (task.tags && task.tags.length) node.appendChild(h("div.u-flex", PMS.vformat.tagsChips(task.tags)));

        // assignees
        node.appendChild(h("div.section-title", [txt(t("tasks.assignees"))]));
        var assignees = (task.assignees || []).map(function (pid) { return PMS.repos.people.get(pid); }).filter(Boolean);
        node.appendChild(h("div.u-flex", assignees.length ? assignees.map(function (p) { return PMS.vformat.personChip(p.id); }) : [h("span.u-muted", { text: "—" })]));
        // status editors open for anyone who may change the task status
        // (admins any; managers their assigned + own-project tasks; members assigned)
        var canEdit = PMS.auth ? PMS.auth.canChangeStatus(task) : true;
        if (canEdit) node.appendChild(h("button.btn.btn-sm", { text: "+ " + t("common.edit"), on: { click: function () { markClosed(); PMS.modal.close(); PMS.editors.openTaskEditor(task, { onSaved: function () {} }); } } }));

        // sub tasks
        var subs = PMS.repos.tasks.children(task.id);
        if (subs.length) {
          node.appendChild(h("div.section-title", [txt(t("tasks.subTasks"))]));
          var subList = h("div.stack");
          subs.forEach(function (s) { subList.appendChild(subRow(s)); });
          node.appendChild(subList);
        }

        // links to other tasks (task <-> task)
        node.appendChild(linksSection(task));

        // meeting this task came from
        if (task.meetingId) {
          var mtg = PMS.repos.meetings.get(task.meetingId);
          if (mtg) {
            node.appendChild(h("div.section-title", [txt(t("tasks.fromMeeting"))]));
            var mRow = h("div.project-tree-row", { style: { cursor: "pointer" } });
            mRow.appendChild(h("span", { text: "🗓" }));
            mRow.appendChild(h("span.u-grow.u-ellipsis", { text: mtg.title }));
            mRow.appendChild(h("span.u-muted", { text: PMS.utils.formatDate(mtg.date, PMS.i18n) }));
            mRow.addEventListener("click", function () { markClosed(); PMS.modal.close(); if (PMS.meetings) PMS.meetings.openDetail(mtg.id); });
            node.appendChild(mRow);
          }
        }

        appendingSections(node, task);

        // quick add comment (admin only — members may only change status)
        var canComment = PMS.auth ? PMS.auth.can("tasks.write") : true;
        if (canComment) {
          node.appendChild(h("div.section-title", [txt(t("tasks.comments"))]));
          var commentArea = h("div.field");
          var cInput = h("textarea.textarea", { placeholder: t("tasks.addComment"), rows: 2 });
          commentArea.appendChild(cInput);
          var cBtn = h("button.btn.btn-sm.btn-primary", { text: t("tasks.addComment"), on: { click: function () {
            var text = cInput.value.trim();
            if (!text) return;
            var comments = task.comments || [];
            comments.push({ id: PMS.ids.uuid(), authorId: null, text: text, createdAt: new Date().toISOString() });
            PMS.repos.tasks.update(task.id, { comments: comments });
          } } });
          commentArea.appendChild(cBtn);
          node.appendChild(commentArea);
        }

        return node;
      },
      footer: [
        {
          label: t("common.delete"), class: "btn-soft-danger",
          onClick: function (m, body) {
            markClosed();
            PMS.confirmTaskDelete(task);
          }
        },
        { label: t("common.close"), onClick: function () { markClosed(); PMS.modal.close(); } }
      ]
    });
  }

  // ---------------- task <-> task links ----------------
  function linksSection(task) {
    var wrap = h("div.stack");
    wrap.appendChild(h("div.section-title", [txt(t("tasks.linkedTasks"))]));
    var linked = PMS.repos.tasks.linksOf(task.id);
    var canEdit = PMS.auth ? PMS.auth.canEditTask(task) : true;
    var list = h("div.stack");
    if (!linked.length) {
      list.appendChild(h("div.u-muted", { text: t("tasks.noLinkedTasks") }));
    }
    linked.forEach(function (lk) {
      var row = h("div.project-tree-row", { style: { cursor: "pointer" } });
      row.appendChild(h("span", { text: "🔗" }));
      row.appendChild(h("span.u-grow.u-ellipsis", { text: lk.title }));
      row.appendChild(PMS.vformat.statusBadge(lk.status, "task"));
      if (canEdit) {
        row.appendChild(h("span.btn-icon.chip-x", {
          text: "✕",
          attrs: { title: t("tasks.unlinkTask") },
          on: { click: function (e) { e.stopPropagation(); PMS.repos.tasks.unlink(task.id, lk.id); } }
        }));
      }
      row.addEventListener("click", function () { markClosed(); PMS.modal.close(); open(lk.id); });
      list.appendChild(row);
    });
    wrap.appendChild(list);
    if (canEdit) {
      wrap.appendChild(h("button.btn.btn-sm", { text: "+ " + t("tasks.linkTask"), on: { click: function (e) { linkPicker(task, e.currentTarget); } } }));
    }
    return wrap;
  }

  function linkPicker(task, trigger) {
    var all = PMS.repos.tasks.all().filter(function (x) {
      return x.id !== task.id && (x.linkedTaskIds || []).indexOf(task.id) === -1;
    });
    var items = all.slice(0, 60).map(function (x) {
      var p = PMS.repos.projects.get(x.projectId);
      return {
        label: x.title + (p ? "  ·  " + p.name : ""),
        onClick: function () { PMS.repos.tasks.link(task.id, x.id); }
      };
    });
    if (!items.length) items.push({ separator: true, header: t("common.noResults") });
    PMS.dropdown.attach(trigger, items, { alignEnd: true });
  }

  function appendingSections(node, task) {
    var canEdit = PMS.auth ? PMS.auth.can("tasks.write") : true;
    // checklist (admin only — members may only change status)
    var items = task.checklist || [];
    node.appendChild(h("div.section-title", [txt(t("tasks.checklist"))]));
    var listWrap = h("div");
    function drawChecklist() {
      PMS.dom.clear(listWrap);
      items.forEach(function (it) {
        var item = h("div.checklist-item" + (it.done ? ".done" : ""));
        var done = !!it.done;
        var cb = h("input", {
          type: "checkbox", checked: done, disabled: !canEdit,
          on: { change: function () { toggleCheck(task, it.id); } }
        });
        item.appendChild(cb);
        item.appendChild(h("label", { text: it.text, style: { flex: 1 } }));
        if (canEdit) item.appendChild(h("span.btn-icon.chip-x", { text: "✕", on: { click: function () { removeCheck(task, it.id); } } }));
        listWrap.appendChild(item);
      });
    }
    drawChecklist();
    node.appendChild(listWrap);
    if (canEdit) {
      var addCheck = h("div.u-flex");
      var cItem = h("input.input", { placeholder: t("tasks.addCheckItem"), style: { flex: 1 } });
      addCheck.appendChild(cItem);
      addCheck.appendChild(h("button.btn.btn-sm", { text: "+", on: { click: function () {
        var v = cItem.value.trim();
        if (!v) return;
        var nw = (task.checklist || []).concat([{ id: PMS.ids.uuid(), text: v, done: false }]);
        PMS.repos.tasks.update(task.id, { checklist: nw });
      } } }));
      node.appendChild(addCheck);
    }

    // dependencies
    var deps = (task.dependencies || []).map(function (did) { return PMS.repos.tasks.get(did); }).filter(Boolean);
    if (deps.length) {
      node.appendChild(h("div.section-title", [txt(t("tasks.dependencies"))]));
      var depWrap = h("div.stack");
      deps.forEach(function (d) { depWrap.appendChild(h("div.u-flex", [h("span", { text: "⛓" }), h("span", { text: d.title })])); });
      node.appendChild(depWrap);
    }

    // activity log
    var activity = task.activity || [];
    if (activity.length) {
      node.appendChild(h("div.section-title", [txt(t("tasks.activity"))]));
      var act = h("div");
      activity.slice().reverse().forEach(function (a) {
        var row = h("div.activity-item");
        row.appendChild(h("span", { text: a.action }));
        row.appendChild(h("span.when", { text: PMS.utils.formatDate(a.at, PMS.i18n) }));
        act.appendChild(row);
      });
      node.appendChild(act);
    }
  }

  function txt(s) { return s; }

  function subRow(s) {
    var row = h("div.project-tree-row", { style: { marginBlockEnd: "2px" } });
    row.style.cursor = "pointer";
    row.addEventListener("click", function () { PMS.modal.close(); open(s.id); });
    row.appendChild(h("span", { text: s.status === "done" ? "✓" : "○" }));
    row.appendChild(h("span.u-grow.u-ellipsis", { text: s.title }));
    row.appendChild(PMS.vformat.statusBadge(s.status, "task"));
    return row;
  }

  function metaItem(label, value) {
    var d = h("div.detail-item");
    d.appendChild(h("div.dl-label", { text: label }));
    d.appendChild(h("div.dl-value", { text: value || "—" }));
    return d;
  }

  function projectName(pid) {
    var p = PMS.repos.projects.get(pid);
    return p ? p.name : "—";
  }

  function statusName(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? PMS.i18n.trilingual(s.name)(s.name) : key;
  }

  function priorityName(key) {
    var p = (PMS.store.data.priorities || []).find(function (x) { return x.key === key; });
    return p ? PMS.i18n.trilingual(p.name)(p.name) : key;
  }

  function toggleCheck(task, checkId) {
    var items = (task.checklist || []).map(function (it) {
      if (it.id === checkId) return Object.assign({}, it, { done: !it.done });
      return it;
    });
    PMS.repos.tasks.update(task.id, { checklist: items, activity: appendActivity(task, "checklist:" + checkId) });
  }

  function removeCheck(task, checkId) {
    var items = (task.checklist || []).filter(function (it) { return it.id !== checkId; });
    PMS.repos.tasks.update(task.id, { checklist: items });
  }

  function appendActivity(task, action) {
    return (task.activity || []).concat([{ id: PMS.ids.uuid(), action: action, at: new Date().toISOString() }]);
  }

  PMS.confirmTaskDelete = function (task) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deleteTask", { title: task.title }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.delete"), class: "btn-danger", onClick: function () {
          PMS.repos.tasks.remove(task.id);
          PMS.modal.close();
          PMS.toast.show(t("common.delete") + " ✓", "success");
        } }
      ]
    });
  };

  PMS.taskDetail = { open: open, markClosed: markClosed };
})(window.PMS);