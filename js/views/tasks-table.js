/* ==========================================================================
   Tasks Table view - virtual table, sortable columns, grouping, column
   show/hide, inline quick-edit, filters, saved filters, export.
   Route: /tasks (or /tasks/:mode where mode=table)
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var state = {
    query: {},
    sortKey: "due",
    sortDir: "asc",
    group: "none",
    columns: null
  };

  function defaultColumns() {
    return [
      { key: "title", label: t("tasks.title"), width: "26%", render: cellTitle, visible: true, sortable: true },
      { key: "project", label: t("tasks.project"), render: cellProject, visible: true, sortable: true },
      { key: "status", label: t("common.status"), render: cellStatus, visible: true, sortable: true },
      { key: "priority", label: t("common.priority"), render: cellPriority, visible: true, sortable: true },
      { key: "assignees", label: t("tasks.assignees"), render: cellAssignees, visible: true },
      { key: "dueDate", label: t("tasks.dueDate"), render: cellDue, visible: true, sortable: true },
      { key: "estimatedHours", label: t("tasks.estimated"), render: cellEst, visible: true, sortable: true },
      { key: "actualHours", label: t("tasks.actual"), render: cellActual, visible: false, sortable: true },
      { key: "progress", label: t("tasks.progress"), render: cellProgress, visible: true, sortable: true }
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
      lateOnly: q.lateOnly
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

    // filter bar
    var filterBar = PMS.taskFilter.build({
      query: state.query,
      onApply: function (f) {
        state.query = f;
        render(container);
      }
    });
    container.appendChild(filterBar);

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

    var rowHeight = 44;
    var dataRows = rows;

    // Build a flat visual list: rows or group-header rows
    function buildVisual() {
      var visual = [];
      if (!state.group || state.group === "none") {
        dataRows.forEach(function (r) { visual.push({ type: "row", row: r }); });
      } else {
        var groups = {};
        dataRows.forEach(function (r) {
          var g = groupKey(r);
          (groups[g] = groups[g] || []).push(r);
        });
        Object.keys(groups).forEach(function (g) {
          visual.push({ type: "group", label: g });
          groups[g].forEach(function (r) { visual.push({ type: "row", row: r }); });
        });
      }
      return visual;
    }

    function paint() {
      var visual = buildVisual();
      body.innerHTML = "";
      body.style.height = (visual.length * rowHeight) + "px";

      var scrollTop = scroll.scrollTop || 0;
      var viewH = scroll.clientHeight || 500;
      var start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
      var end = Math.min(visual.length, Math.ceil((scrollTop + viewH) / rowHeight) + 8);

      for (var i = start; i < end; i++) {
        var item = visual[i];
        var el;
        if (item.type === "group") {
          el = h("div.vt-group", { text: item.label });
        } else {
          el = renderRow(item.row, visible);
          el.style.gridTemplateColumns = template;
        }
        el.style.top = (i * rowHeight) + "px";
        el.style.height = rowHeight + "px";
        body.appendChild(el);
      }
    }

    paint();
    scroll.addEventListener("scroll", function () { paint(); });
    return scroll;
  }

  function renderRow(row, visible) {
    var rowEl = h("div.vt-row");
    visible.forEach(function (col) {
      var cell = h("div.vt-td");
      if (col.render) cell.appendChild(col.render(row, rowEl));
      else cell.textContent = "";
      rowEl.appendChild(cell);
    });
    // inline edit on double click of title
    rowEl.addEventListener("dblclick", function () { PMS.taskDetail.open(row.id); });
    return rowEl;
  }

  function cellTitle(row, tr) {
    var cell = h("span.u-flex", { style: { gap: "8px" } });
    var titleWrap = h("span.u-flex", { style: { gap: "6px", minWidth: "0" } });
    titleWrap.appendChild(h("span.u-ellipsis", { text: row.title }));
    var subCount = PMS.repos.tasks.children(row.id).length;
    if (subCount) titleWrap.appendChild(h("span.badge", { text: "+" + subCount }));
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
    // members/managers may only re-status the tasks assigned to them
    var mayStatus = PMS.auth ? PMS.auth.canEditTask(row) : true;
    if (!mayStatus) sel.disabled = true;
    sel.addEventListener("change", function () {
      if (sel.value === row.status) return;
      if (PMS.auth && !PMS.auth.canEditTask(row)) { PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error"); sel.value = row.status; return; }
      PMS.repos.tasks.update(row.id, { status: sel.value }); // repos.logUpdate records the change
    });
    return sel;
  }

  function statusName(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? PMS.i18n.trilingual(s.name)(s.name) : key;
  }

  function cellPriority(row) { return PMS.vformat.priorityBadge(row.priority); }

  function cellAssignees(row) {
    var wrap = h("span.u-flex", { style: { gap: "4px" } });
    (row.assignees || []).forEach(function (pid) {
      var p = PMS.repos.people.get(pid);
      if (p) wrap.appendChild(PMS.vformat.avatar(p));
    });
    if (!wrap.childNodes.length) wrap.appendChild(h("span.u-muted", { text: "—" }));
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

  function cellProgress(row) { return PMS.vformat.progressChip(derivedProgress(row)); }

  function derivedProgress(row) {
    return PMS.progress.taskProgress(PMS.store.data, row.id, PMS.store.data.settings.weightByTime);
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
    var w = PMS.store.data.settings.weightByTime;
    var data = rows.map(function (r) {
      var p = PMS.repos.projects.get(r.projectId);
      return {
        title: r.title, project: p ? p.name : "", status: r.status, priority: r.priority,
        dueDate: r.dueDate, estimatedHours: r.estimatedHours, actualHours: r.actualHours,
        progress: PMS.progress.taskProgress(PMS.store.data, r.id, w)
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