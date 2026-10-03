/* ==========================================================================
   Tasks Kanban view - drag & drop cards across status columns.
   Route: /tasks/kanban
   Uses native HTML5 drag & drop (works on file://).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var projectFilter = null;
  // Whole-program facts, resolved once per render and read by every card:
  // ranking each card's tasks here would re-sort the program per card.
  var netAnalysis = null;
  var netNumbers = {};

  function statuses() { return PMS.store.data.taskStatuses || []; }

  function tasksOf(status) {
    return PMS.repos.tasks.all().filter(function (tsk) {
      return tsk.status === status && !tsk.parentTaskId && (!projectFilter || tsk.projectId === projectFilter);
    });
  }

  function render(container) {
    container.innerHTML = "";
    netAnalysis = PMS.dependencies.analyzeCached(PMS.store.data);
    netNumbers = PMS.utils.taskNumbers(PMS.store.data);
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("tasks.viewKanban") }));
    var actions = h("div.actions");
    actions.appendChild(PMS.taskModeSwitcher("kanban"));
    actions.appendChild(projectSelector());
    if (PMS.auth ? (PMS.auth.can("tasks.write") || PMS.auth.canCreateTask()) : true) {
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("tasks.newTask"), on: { click: function () { PMS.editors.openTaskEditor(null, {}); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    var board = h("div.kanban-board");

    statuses().forEach(function (st) {
      var col = h("div.kanban-col", { dataset: { status: st.key } });
      var head = h("div.kanban-col-header", { style: { color: st.color } });
      head.appendChild(h("span.badge-dot", { style: { background: st.color } }));
      head.appendChild(h("span", { text: PMS.i18n.trilingual(st.name)(st.name) }));
      head.appendChild(h("span.count", { text: String(tasksOf(st.key).length) }));
      col.appendChild(head);

      var body = h("div.kanban-body");
      body.addEventListener("dragover", function (e) { e.preventDefault(); col.classList.add("drag-over"); });
      body.addEventListener("dragleave", function () { col.classList.remove("drag-over"); });
      body.addEventListener("drop", function (e) {
        e.preventDefault();
        col.classList.remove("drag-over");
        var id = e.dataTransfer.getData("text/plain");
        if (!id) return;
        var tsk = PMS.repos.tasks.get(id);
        if (tsk && tsk.status !== st.key) {
          // status change rules: admins any; managers own projects; members assigned only
          if (PMS.auth && !PMS.auth.canChangeStatus(tsk)) { PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error"); return; }
          // refuses "done" while sub-tasks are open; put the card back where it was
          var moved = PMS.repos.tasks.setStatus(id, st.key);
          if (moved && moved.error) body.appendChild(card(tsk, st));
        }
      });

      tasksOf(st.key).forEach(function (tsk) { body.appendChild(card(tsk, st)); });
      col.appendChild(body);
      board.appendChild(col);
    });

    container.appendChild(board);
  }

  function card(tsk, st) {
    var canMove = PMS.auth ? PMS.auth.canChangeStatus(tsk) : true;
    // A blocked task cannot honestly be dragged into done, and a critical one
    // is the one the program hinges on. Both are marked on the card itself so a
    // board read at a glance shows where the risk is.
    var critical = PMS.dependencies.isCritical(netAnalysis, tsk.id);
    var blocked = PMS.dependencies.isBlocked(PMS.store.data, tsk);
    var c = h("div.kanban-card" + (critical ? ".is-critical" : "") + (blocked ? ".is-blocked" : ""), {
      attrs: { "data-id": tsk.id },
      on: {
        dragstart: function (e) {
          e.dataTransfer.setData("text/plain", tsk.id);
          e.dataTransfer.effectAllowed = "move";
          c.classList.add("dragging");
        },
        dragend: function () { c.classList.remove("dragging"); },
        click: function () { PMS.taskDetail.open(tsk.id); },
        dblclick: function (e) { e.stopPropagation(); PMS.editors.openTaskEditor(tsk, {}); }
      }
    });
    if (canMove) c.setAttribute("draggable", "true");
    c.appendChild(h("div.kc-title", { text: tsk.title }));
    // who created the task, on its own line so it never crowds the badges
    var by = PMS.vformat.creatorChip(tsk);
    if (by) c.appendChild(h("div.kc-meta.kc-meta-by", [by]));
    var meta = h("div.kc-meta");
    meta.appendChild(PMS.vformat.priorityBadge(tsk.priority));
    if (tsk.dueDate) {
      var late = tsk.dueDate < PMS.utils.todayISO() && tsk.status !== "done";
      meta.appendChild(h("span.chip", { text: PMS.utils.formatDate(tsk.dueDate, PMS.i18n), style: late ? { color: "var(--danger)", fontWeight: "600" } : null }));
    }
    if (tsk.estimatedHours) meta.appendChild(h("span.chip", { text: PMS.utils.hours(tsk.estimatedHours, PMS.i18n) }));
    var assignees = (tsk.assignees || []).map(function (pid) { return PMS.repos.people.get(pid); }).filter(Boolean);
    var avatars = PMS.dom.h("span.u-flex", { style: { marginInlineStart: "auto", gap: "3px" } });
    assignees.slice(0, 3).forEach(function (p) { avatars.appendChild(PMS.vformat.avatar(p)); });
    meta.appendChild(avatars);
    c.appendChild(meta);
    if (tsk.tags && tsk.tags.length) c.appendChild(h("div.kc-meta", PMS.vformat.tagsChips(tsk.tags)));
    // The network: a link line and the critical/blocked marks, on their own row
    // so they read as a separate fact and not as another tag.
    var preds = PMS.dependencies.predecessors(tsk);
    var succs = PMS.dependencies.successors(PMS.store.data, tsk.id);
    if (preds.length || succs.length || critical) {
      var net = h("div.kc-meta", { style: { gap: "4px", flexWrap: "wrap" } });
      net.appendChild(PMS.vformat.depSummary(PMS.store.data, tsk, netNumbers));
      PMS.vformat.depMarkers(PMS.store.data, tsk, netAnalysis).forEach(function (m) { net.appendChild(m); });
      c.appendChild(net);
    }
    // status-derived progress bar (reacts to the column/status the card sits in)
    var pv = PMS.programProgress.taskProgress(PMS.store.data, tsk);
    var bar = h("div.progress-track", { style: { height: "6px", marginBlockStart: "8px" } }, [h("div.progress-fill", { style: { width: Math.floor(pv) + "%" } })]);
    c.appendChild(bar);
    return c;
  }

  function statusColorOf(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? s.color : "#3b82f6";
  }

  function projectSelector() {
    var sel = h("select.select", { dataset: { id: "kanban-project-filter" }, style: { minWidth: "180px" }, on: { change: function (e) {
      projectFilter = e.target.value === "__all__" ? null : e.target.value;
      render(currentContainer());
    } } });
    sel.appendChild(h("option", { value: "__all__", text: t("common.all") + " — " + t("tasks.project") }));
    PMS.repos.projects.all().forEach(function (p) {
      sel.appendChild(h("option", { value: p.id, text: p.name }));
    });
    sel.value = projectFilter || "__all__";
    return sel;
  }

  function currentContainer() { return document.getElementById("view-root"); }

  var view = {
    id: "tasks-kanban",
    titleKey: "tasks.viewKanban",
    icon: "🗂",
    nav: false,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/tasks/kanban") render(container); });
      return function () { off(); };
    }
  };

  PMS.registry.registerView(view);
  PMS.router.register("/tasks/kanban", "tasks-kanban");
})(window.PMS);