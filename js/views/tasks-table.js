/* ==========================================================================
   Tasks Table view - virtual table, sortable columns, grouping, column
   show/hide, inline quick-edit, filters, saved filters, export.
   Route: /tasks (or /tasks/:mode where mode=table)
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  // id -> task number, refreshed on every table paint and read by cellNumber.
  var numberMap = {};
  // Whole-program facts (the critical path, blocking predecessors) resolved once
  // per render rather than once per row or cell.
  var netAnalysis = null;

  // The task's stable number, so a row can be pointed at out loud ("task 12").
  // The full id sits in the tooltip for anyone who needs to copy it.
  function cellNumber(row) {
    var n = numberMap[row.id];
    return h("span.vt-td-num", {
      text: n ? "#" + n : "",
      attrs: { title: row.id }
    });
  }

  var state = {
    query: {},
    sortKey: "due",
    sortDir: "asc",
    group: "none",
    columns: null,
    // Which tasks have their sub-task block folded away. `collapsed` holds only
    // the tasks the user touched; `defaultCollapsed` decides the rest, so a
    // sub-task list starts folded without having to write an entry per task.
    collapsed: {},
    defaultCollapsed: true
  };

  // A task is folded unless it was explicitly opened. Sub-tasks stay out of the
  // list until their parent is expanded, which is what keeps a long program from
  // arriving as one wall of rows.
  function isCollapsed(id) {
    var own = state.collapsed[id];
    return own === undefined ? state.defaultCollapsed : !!own;
  }

  function setCollapsed(id, collapsed) {
    state.collapsed[id] = collapsed;
  }

  function defaultColumns() {
    return [
      { key: "number", label: t("tasks.number"), width: "68px", render: cellNumber, visible: true, sortable: true },
      { key: "title", label: t("tasks.title"), width: "24%", render: cellTitle, visible: true, sortable: true },
      { key: "project", label: t("tasks.project"), render: cellProject, visible: true, sortable: true },
      { key: "status", label: t("common.status"), render: cellStatus, visible: true, sortable: true },
      { key: "priority", label: t("common.priority"), render: cellPriority, visible: true, sortable: true },
      { key: "assignees", label: t("tasks.assignees"), render: cellAssignees, visible: true },
      { key: "createdBy", label: t("tasks.createdBy"), render: cellCreator, visible: true, sortable: true },
      // After the two "who" columns on purpose: assignee and creator belong
      // together, and the network is a different kind of fact again.
      { key: "dependencies", label: t("deps.title"), width: "210px", render: cellDependencies, visible: true },
      { key: "dueDate", label: t("tasks.dueDate"), render: cellDue, visible: true, sortable: true },
      { key: "estimatedHours", label: t("tasks.estimated"), render: cellEst, visible: true, sortable: true },
      { key: "actualHours", label: t("tasks.actual"), render: cellActual, visible: false, sortable: true },
      { key: "progress", label: t("tasks.progress"), width: "120px", render: cellProgress, visible: true, sortable: true }
    ];
  }

  function filteredRows() {
    var all = PMS.repos.tasks.all();
    var q = state.query;
    var eng = PMS.filterEngine;
    // build criteria
    var criteria = {
      search: q.search,
      projectId: q.projectId,
      personId: q.assigneeId,
      status: q.statusKey ? [q.statusKey] : [],
      priority: q.priorityKey ? [q.priorityKey] : [],
      from: q.from,
      to: q.to,
      startFrom: q.startFrom,
      startTo: q.startTo,
      lateOnly: q.lateOnly,
      blockedOnly: q.blockedOnly,
      criticalOnly: q.criticalOnly,
      mainOnly: q.mainOnly
    };
    var out = eng.filterTasks(all, criteria, PMS.store.data);
    // sort
    var sorted = eng.sortTasks(out, state.sortKey, state.sortDir, PMS.store.data);
    return sorted;
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("tasks.title") }));
    var actions = h("div.actions");
    actions.appendChild(viewModeSwitcher("table"));
    if (PMS.auth ? (PMS.auth.can("tasks.write") || PMS.auth.canCreateTask()) : true) {
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("tasks.newTask"), on: { click: function () { PMS.editors.openTaskEditor(null, {}); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    // collapsible filter bar (hidden by default; auto-expands while filters are active)
    function activeFilterCount(q) {
      var n = 0;
      q = q || {};
      ["search", "projectId", "statusKey", "priorityKey", "assigneeId",
        "from", "to", "startFrom", "startTo"].forEach(function (k) { if (q[k]) n++; });
      ["lateOnly", "blockedOnly", "criticalOnly", "mainOnly"].forEach(function (k) { if (q[k]) n++; });
      return n;
    }
    var actCount = activeFilterCount(state.query);
    var filterArea = h("div.filter-area");
    var filterOpen = actCount > 0; // default: collapsed unless a filter is already applied
    var toggleBtn = h("button.btn.btn-sm.filter-toggle" + (actCount ? ".active" : ""), {
      text: t("tasks.filters") + (actCount ? " (" + actCount + ")" : "") + (filterOpen ? " ▴" : " ▾"),
      on: { click: function () {
        filterOpen = !filterOpen;
        filterBar.classList.toggle("collapsed", !filterOpen);
        toggleBtn.textContent = t("tasks.filters") + (actCount ? " (" + actCount + ")" : "") + (filterOpen ? " ▴" : " ▾");
      } }
    });
    filterArea.appendChild(toggleBtn);
    var filterBar = PMS.taskFilter.build({
      query: state.query,
      onApply: function (f) {
        state.query = f;
        render(container);
      }
    });
    if (!filterOpen) filterBar.classList.add("collapsed");
    filterArea.appendChild(filterBar);
    container.appendChild(filterArea);

    // toolbar: grouping + columns + export
    var toolbar = h("div.toolbar");
    toolbar.appendChild(h("span.u-muted", { text: t("tasks.groupBy") }));
    var groupSel = h("select.select", { on: { change: function (e) { state.group = e.target.value; render(container); } } });
    groupSel.appendChild(h("option", { value: "none", text: "—" }));
    groupSel.appendChild(h("option", { value: "project", text: t("tasks.project") }));
    groupSel.appendChild(h("option", { value: "status", text: t("common.status") }));
    groupSel.appendChild(h("option", { value: "priority", text: t("common.priority") }));
    groupSel.value = state.group;
    toolbar.appendChild(groupSel);

    toolbar.appendChild(columnDropdown());
    toolbar.appendChild(h("button.btn.btn-sm.btn-ghost", {
      text: t("tasks.collapseAllSubtasks"),
      attrs: { title: t("tasks.collapseAllSubtasks") },
      on: { click: function () { setAllSubtasks(true); } }
    }));
    toolbar.appendChild(h("button.btn.btn-sm.btn-ghost", {
      text: t("tasks.expandAllSubtasks"),
      attrs: { title: t("tasks.expandAllSubtasks") },
      on: { click: function () { setAllSubtasks(false); } }
    }));
    toolbar.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("reports.exportCsv"), on: { click: exportCsv } }));
    toolbar.appendChild(h("span.grow"));
    toolbar.appendChild(h("span.u-muted", { text: t("common.savedFilters") + ":" }));
    toolbar.appendChild(savedFilterDropdown());
    toolbar.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.saveFilter"), on: { click: saveFilter } }));
    container.appendChild(toolbar);

    var rows = filteredRows();
    container.appendChild(buildTable(rows));
  }

  function buildTable(rows) {
    var columns = state.columns || defaultColumns();
    var visible = columns.filter(function (c) { return c.visible !== false; });
    var template = visible.map(function (col) { return col.width || "1fr"; }).join(" ");
    var scroll = h("div.vt-scroll", { style: { maxHeight: "calc(100vh - 320px)", minHeight: "300px" } });
    // Ranked once per paint, not once per cell: the list is virtualized and
    // recomputes on every scroll tick.
    numberMap = PMS.utils.taskNumbers(PMS.store.data);
    // Same reasoning for the network: one analysis for the whole render. It is
    // cached on the data version inside the service too, so this is just
    // handing the same answer to the row builders.
    netAnalysis = PMS.dependencies.analyzeCached(PMS.store.data);

    // Header (grid, sticky)
    var head = h("div.vt-head", { style: { gridTemplateColumns: template } });
    visible.forEach(function (col) {
      var th = h("div.vt-th" + (col.sortable ? ".sortable" : "") + (state.sortKey === col.key ? (state.sortDir === "asc" ? ".sort-asc" : ".sort-desc") : ""), {
        on: col.sortable ? { click: function () { sortBy(col.key); } } : null
      });
      th.appendChild(h("span", { text: col.label }));
      if (col.sortable) th.appendChild(h("span.sort-arrow", { text: " ▾" }));
      head.appendChild(th);
    });
    scroll.appendChild(head);

    var body = h("div.vt-body");
    scroll.appendChild(body);

    var ROW_H = 44;      // a main task row
    var SUB_H = 34;      // a nested sub-task row
    var GROUP_H = 34;    // a group header
    var dataRows = rows;

    // true when the user narrowed the list down: sub-tasks then follow the
    // SAME filter instead of dumping every child of a matching parent.
    function filtering() {
      var q = state.query || {};
      return !!(q.search || q.projectId || q.statusKey || q.priorityKey || q.assigneeId || q.lateOnly);
    }
    function matchesQuery(task) {
      if (!filtering()) return true;
      return dataRows.some(function (r) { return r.id === task.id; });
    }
    function childrenOf(parentId) {
      return PMS.repos.tasks.children(parentId).slice().sort(function (a, b) {
        var byStatus = String(a.status || "").localeCompare(String(b.status || ""));
        if (byStatus) return byStatus;
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
    }

    // Flattens the list into absolutely-positionable items. Sub-tasks are
    // emitted right under their parent so they read as a nested block; every
    // task that has children gets a chevron to collapse/expand that block.
    function buildVisual() {
      var visual = [];
      function push(task, depth) {
        var kids = childrenOf(task.id).filter(matchesQuery);
        var collapsed = isCollapsed(task.id);
        visual.push({
          type: "row", row: task, depth: depth,
          height: depth === 0 ? ROW_H : SUB_H,
          hasKids: kids.length > 0, isCollapsed: collapsed, kidCount: kids.length
        });
        // Folded: the sub-task block is not in the list at all, not just hidden
        // behind a toggle that has to be found.
        if (collapsed) return;
        kids.forEach(function (k) { push(k, depth + 1); });
      }
      // A sub-task with no parent here (filtered out, or in another view's data)
      // still needs to be visible, so it is promoted to a row of its own. The test
      // is whether the parent exists at all, NOT whether the parent emitted it: a
      // collapsed parent deliberately emits nothing, and promoting its kids would
      // defeat the fold and re-list them as top-level tasks.
      var present = {};
      dataRows.forEach(function (r) { present[r.id] = true; });
      if (!state.group || state.group === "none") {
        dataRows.filter(function (r) { return !r.parentTaskId; }).forEach(function (r) { push(r, 0); });
        dataRows.filter(function (r) { return !!r.parentTaskId; }).forEach(function (r) {
          if (!present[r.parentTaskId]) push(r, 0);
        });
      } else {
        var groups = {};
        dataRows.forEach(function (r) {
          var g = groupKey(r);
          (groups[g] = groups[g] || []).push(r);
        });
        Object.keys(groups).forEach(function (g) {
          visual.push({ type: "group", label: g, height: GROUP_H });
          groups[g].filter(function (r) { return !r.parentTaskId; }).forEach(function (r) { push(r, 0); });
          groups[g].filter(function (r) { return !!r.parentTaskId; }).forEach(function (r) {
            if (!present[r.parentTaskId]) push(r, 0);
          });
        });
      }
      // cumulative offsets (rows have different heights)
      var top = 0;
      visual.forEach(function (item) { item.top = top; top += item.height; });
      return visual;
    }

    function paint() {
      var visual = buildVisual();
      body.innerHTML = "";
      var total = visual.length ? visual[visual.length - 1].top + visual[visual.length - 1].height : 0;
      body.style.height = total + "px";

      var scrollTop = scroll.scrollTop || 0;
      var viewH = scroll.clientHeight || 500;
      // rows are 34-44px tall, so average to pick a safe window, then overscan
      // by 8 items so scrolling never shows a gap
      var avg = visual.length ? total / visual.length : ROW_H;
      var start = 0, end = visual.length;
      if (avg > 0) {
        start = Math.max(0, Math.floor(scrollTop / avg) - 8);
        end = Math.min(visual.length, Math.ceil((scrollTop + viewH) / avg) + 8);
      }

      for (var i = start; i < end; i++) {
        var item = visual[i];
        var el;
        if (item.type === "group") {
          el = h("div.vt-group", { text: item.label });
        } else {
          el = renderRow(item.row, visible, item);
          el.style.gridTemplateColumns = template;
        }
        el.style.top = item.top + "px";
        el.style.height = item.height + "px";
        body.appendChild(el);
      }
    }

    paint();
    scroll.addEventListener("scroll", function () { paint(); });
    return scroll;
  }

  function renderRow(row, visible, item) {
    var depth = item ? item.depth : 0;
    // The critical path is marked on the row as well as in its own cell: the
    // cell says which task it is, the row says how far down the list to look.
    var rowEl = h("div.vt-row" + (depth ? ".vt-row-sub" : "") + (item && item.isCollapsed ? ".vt-row-collapsed" : "")
      + (PMS.dependencies.isCritical(netAnalysis, row.id) ? ".is-critical" : ""), {
      dataset: { id: row.id, depth: depth },
      attrs: { title: t("tasks.doubleClickForDetails") }
    });
    if (depth) {
      // guide rail that makes the nesting obvious at a glance
      rowEl.style.paddingInlineStart = (8 + (depth - 1) * 18) + "px";
    }
    visible.forEach(function (col) {
      var cell = h("div.vt-td");
      if (col.render) cell.appendChild(col.render(row, rowEl, item));
      else cell.textContent = "";
      rowEl.appendChild(cell);
    });
    // Double click reads the task, it does not edit it. Opening straight into the
    // editor meant a stray double click on a row you only meant to look at could
    // start rewriting it; the detail view carries an explicit Edit button, and the
    // row's own pencil still goes straight to the editor.
    rowEl.addEventListener("dblclick", function () {
      PMS.taskDetail.open(row.id);
    });
    return rowEl;
  }

  // collapse/expand chevron for a task that owns sub-tasks
  function subtaskToggle(row, item) {
    var btn = h("button.vt-twisty" + (item.isCollapsed ? ".collapsed" : ""), {
      text: "▾",
      attrs: { title: item.isCollapsed ? t("tasks.expandSubtasks") : t("tasks.collapseSubtasks"), "aria-label": t("tasks.subtasks") },
      on: {
        click: function (e) {
          e.stopPropagation();
          setCollapsed(row.id, !isCollapsed(row.id));
          PMS.router.handle();
        }
      }
    });
    return btn;
  }

  function cellTitle(row, tr, item) {
    var cell = h("span.u-flex", { style: { gap: "8px" } });
    var titleWrap = h("span.u-flex", { style: { gap: "6px", minWidth: "0" } });
    // collapse/expand control for the sub-task block of this task
    if (item && item.hasKids) titleWrap.appendChild(subtaskToggle(row, item));
    else if (item && item.depth) titleWrap.appendChild(h("span.vt-twisty.vt-twisty-leaf", { text: "•" }));
    titleWrap.appendChild(h("span.u-ellipsis", { text: row.title }));
    if (item && item.hasKids) {
      titleWrap.appendChild(h("span.badge", {
        text: (item.isCollapsed ? "▸ " : "▾ ") + item.kidCount
      }));
    }
    var linkCount = (row.linkedTaskIds || []).length;
    if (linkCount) {
      titleWrap.appendChild(h("span.chip", {
        text: "🔗" + linkCount,
        attrs: { title: t("tasks.linkedTasks") },
        on: { click: function (e) { e.stopPropagation(); } }
      }));
    }
    if (row.meetingId) {
      var mtg = PMS.repos.meetings.get(row.meetingId);
      titleWrap.appendChild(h("span.chip.chip-meeting", {
        text: "🗓" + (mtg ? " " + (mtg.title || "") : ""),
        attrs: { title: t("tasks.fromMeeting") },
        on: { click: function (e) { e.stopPropagation(); if (PMS.meetings) PMS.meetings.openDetail(row.meetingId); } }
      }));
    }
    if (row.tags && row.tags.length) titleWrap.appendChild(h("span.chip", { text: row.tags[0] }));
    cell.appendChild(titleWrap);
    if (PMS.auth ? PMS.auth.canEditTask(row) : true) {
      var editBtn = h("button.btn.btn-sm.btn-icon.btn-ghost", {
        text: "✎",
        attrs: { title: t("tasks.editTask") },
        on: { click: function (e) { e.stopPropagation(); PMS.editors.openTaskEditor(row, {}); } }
      });
      cell.appendChild(editBtn);
    }
    return cell;
  }

  function setAllSubtasks(collapsed) {
    // Set the default rather than writing an entry per task: the list is long and
    // the per-task map is only for the ones the user then touches.
    state.defaultCollapsed = !!collapsed;
    state.collapsed = {};
    render(currentContainer());
  }

  function cellProject(row) {
    var p = PMS.repos.projects.get(row.projectId);
    return h("span", { text: p ? p.name : "—" });
  }

  function cellStatus(row) {
    var statuses = PMS.store.data.taskStatuses || [];
    var sel = h("select.select.vt-status", { value: row.status });
    sel.style.width = "100%";
    sel.style.fontSize = "12px";
    sel.style.padding = "1px 6px";
    if (!statuses.some(function (s) { return s.key === row.status; })) {
      sel.appendChild(h("option", { value: row.status, text: row.status }));
    }
    statuses.forEach(function (s) {
      sel.appendChild(h("option", { value: s.key, text: PMS.i18n.trilingual(s.name)(s.name) }));
    });
    sel.value = row.status;
    var cur = statuses.find(function (s) { return s.key === row.status; });
    if (cur) { sel.style.color = cur.color; sel.style.background = PMS.vformat.hexToSoft(cur.color); }
    // admins: any task; managers additionally re-status tasks inside the
    // projects they manage; members only their own assigned tasks
    var mayStatus = PMS.auth ? PMS.auth.canChangeStatus(row) : true;
    if (!mayStatus) sel.disabled = true;
    sel.addEventListener("change", function () {
      if (sel.value === row.status) return;
      if (PMS.auth && !PMS.auth.canChangeStatus(row)) { PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error"); sel.value = row.status; return; }
      // refuses "done" while sub-tasks are open, and refuses any forward move
      // while a dependency still holds the task, so snap the control back
      var changed = PMS.repos.tasks.setStatus(row.id, sel.value);
      if (changed && changed.error) sel.value = row.status;
    });
    // The status a task is really in, next to the one it is filed under. A
    // blocked task still has a status of its own, so it stays in the dropdown
    // and keeps its colour; this badge is what says the next step is refused.
    // Derived from PMS.dependencies.blocking, the same call the refusal path
    // reads, so the two can never disagree.
    var held = PMS.dependencies.blocking(PMS.store.data, row);
    if (!held.length) return sel;
    var wrapEl = h("div.u-flex", { style: { gap: "4px", alignItems: "center" } });
    wrapEl.appendChild(sel);
    wrapEl.appendChild(h("span.badge.badge-blocked", {
      text: "⛔ " + PMS.i18n.t("deps.blocked"),
      attrs: {
        title: PMS.i18n.t("deps.blockedBy") + ": " + held.map(function (b) {
          return (b.task.title || "") + " (" + PMS.dependencies.label(b.dep.type) + ")";
        }).join(", ")
      }
    }));
    return wrapEl;
  }

  function statusName(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? PMS.i18n.trilingual(s.name)(s.name) : key;
  }

  function cellPriority(row) { return PMS.vformat.priorityBadge(row.priority); }

  // Assignees are READ-ONLY here: assignment is edited in the task editor
  // (double click the row), never inline in the table.
  function cellAssignees(row) {
    var wrap = h("span.u-flex.vt-assignees", { style: { gap: "4px" }, attrs: { title: t("tasks.assigneesReadOnly") } });
    (row.assignees || []).forEach(function (pid) {
      var p = PMS.repos.people.get(pid);
      if (p) wrap.appendChild(PMS.vformat.avatar(p));
    });
    if (!wrap.childNodes.length) wrap.appendChild(h("span.u-muted", { text: "—" }));
    return wrap;
  }

  function cellCreator(row) {
    var chip = PMS.vformat.creatorChip(row);
    if (chip) return chip;
    return h("span.u-muted", { text: "-" });
  }

  // What this task waits on, what waits on it, and whether it is on the
  // critical path or held up. The analysis is worked out once for the whole
  // render, not per row: it is a whole-program question and re-running it for
  // every row would be a full network pass per line of the table.
  function cellDependencies(row) {
    var wrap = h("span.u-flex", { style: { gap: "4px", flexWrap: "wrap", alignItems: "center" } });
    var preds = PMS.dependencies.predecessors(row);
    var succs = PMS.dependencies.successors(PMS.store.data, row.id);
    if (!preds.length && !succs.length && !PMS.dependencies.isCritical(netAnalysis, row.id)) {
      return h("span.u-muted", { text: "-" });
    }
    wrap.appendChild(PMS.vformat.depSummary(PMS.store.data, row, numberMap));
    PMS.vformat.depMarkers(PMS.store.data, row, netAnalysis).forEach(function (m) {
      wrap.appendChild(m);
    });
    return wrap;
  }

  function cellDue(row) {
    var late = row.dueDate && row.dueDate < PMS.utils.todayISO() && row.status !== "done";
    var el = h("span", { text: PMS.utils.formatDate(row.dueDate, PMS.i18n) });
    if (late) { el.style.color = "var(--danger)"; el.classList.add("u-bold"); }
    return el;
  }

  function cellEst(row) { return h("span", { text: PMS.utils.hours(row.estimatedHours, PMS.i18n) }); }

  function cellActual(row) { return h("span", { text: PMS.utils.hours(row.actualHours, PMS.i18n) }); }

  function cellProgress(row) {
    var d = PMS.store.data;
    var p = PMS.programProgress.taskProgress(d, row);
    var st = (d.taskStatuses || []).find(function (s) { return s.key === row.status; });
    var color = st && st.color ? st.color : "var(--primary)";
    var wrap = h("span.u-flex", { style: { gap: "6px" } });
    var track = h("div.progress-track", { style: { width: "64px", height: "6px" } });
    track.appendChild(h("div.progress-fill", { style: { width: Math.floor(p) + "%", background: color } }));
    wrap.appendChild(track);
    wrap.appendChild(h("span.progress-label", { text: PMS.utils.pctBand(p) }));
    return wrap;
  }

  function groupKey(row) {
    if (state.group === "project") { var p = PMS.repos.projects.get(row.projectId); return p ? p.name : "—"; }
    if (state.group === "status") { var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === row.status; }); return s ? PMS.i18n.trilingual(s.name)(s.name) : row.status; }
    if (state.group === "priority") { var pr = (PMS.store.data.priorities || []).find(function (x) { return x.key === row.priority; }); return pr ? PMS.i18n.trilingual(pr.name)(pr.name) : row.priority; }
    return "—";
  }

  function sortBy(key) {
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = "asc"; }
    PMS.router.handle();
  }

  function columnDropdown() {
    var btn = h("button.btn.btn-sm.btn-ghost", { text: t("tasks.columns") + " ▾" });
    btn.addEventListener("click", function () {
      var columns = state.columns || (state.columns = defaultColumns());
      var items = columns.map(function (col) {
        return {
          label: (col.visible !== false ? "✓ " : "   ") + col.label,
          onClick: function () { col.visible = col.visible === false ? true : false; render(currentContainer()); }
        };
      });
      PMS.dropdown.attach(btn, items);
    });
    return btn;
  }

  function savedFilterDropdown() {
    var btn = h("button.btn.btn-sm.btn-ghost", { text: t("common.savedFilters") + " ▾" });
    btn.addEventListener("click", function () {
      var saved = PMS.repos.savedFilters.all();
      var items = saved.map(function (f) {
        return {
          label: f.name,
          onClick: function () { state.query = f.query; render(currentContainer()); }
        };
      });
      if (!items.length) items.push({ header: t("common.noResults") });
      PMS.dropdown.attach(btn, items);
    });
    return btn;
  }

  function saveFilter() {
    var name = prompt(t("common.saveFilter") + ":");
    if (!name) return;
    PMS.repos.savedFilters.add({ name: name, query: state.query, type: "task" });
    PMS.toast.show(t("common.saveFilter") + " ✓", "success");
  }

  function exportCsv() {
    var rows = filteredRows();
    var cols = ["title", "status", "priority", "dueDate", "estimatedHours", "actualHours", "progress"];
    var data = rows.map(function (r) {
      var p = PMS.repos.projects.get(r.projectId);
      return {
        title: r.title, project: p ? p.name : "", status: r.status, priority: r.priority,
        dueDate: r.dueDate, estimatedHours: r.estimatedHours, actualHours: r.actualHours,
        progress: PMS.programProgress.taskProgress(PMS.store.data, r)
      };
    });
    PMS.exportService.downloadCSV("tasks.csv", data, ["title", "project", "status", "priority", "dueDate", "estimatedHours", "actualHours", "progress"]);
  }

  function currentContainer() { return document.getElementById("view-root"); }

  // Shared view-mode switcher across task views
  function viewModeSwitcher(active) {
    var wrap = h("div.segmented");
    [["table", t("tasks.viewTable"), "/tasks"], ["kanban", t("tasks.viewKanban"), "/tasks/kanban"], ["gantt", t("tasks.viewGantt"), "/tasks/gantt"], ["calendar", t("tasks.viewCalendar"), "/tasks/calendar"]].forEach(function (m) {
      var b = h("button" + (active === m[0] ? ".active" : ""), { text: m[1], on: { click: function () { PMS.router.navigate(m[2]); } } });
      wrap.appendChild(b);
    });
    return wrap;
  }

  PMS.taskModeSwitcher = viewModeSwitcher;

  var view = {
    id: "tasks",
    path: "/tasks",
    titleKey: "nav.tasks",
    icon: "☑",
    nav: true,
    render: function (container, params) {
      if (params && params.q !== undefined) {
        state.query.search = params.q || "";
      }
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current.indexOf("/tasks") === 0) render(container); });
      return function () { off(); };
    }
  };

  PMS.registry.registerView(view);
  PMS.router.register("/tasks", "tasks");
})(window.PMS);