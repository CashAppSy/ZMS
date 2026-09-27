/* ==========================================================================
   Tasks Gantt view - timeline with dependencies, draggable bars.
   Route: /tasks/gantt
   Pure DIV/SVG implementation (no dependencies).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var DAY = 24 * 60 * 60 * 1000;
  var zoom = 40; // px per day

  function tasksForGantt() {
    return PMS.repos.tasks.all();
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("tasks.viewGantt") }));
    var actions = h("div.actions");
    actions.appendChild(PMS.taskModeSwitcher("gantt"));
    var zoomSel = h("select.select", { on: { change: function (e) { zoom = Number(e.target.value); render(container); } } });
    [["days", 26], ["week", 40], ["month", 70]].forEach(function (z) {
      zoomSel.appendChild(h("option", { value: String(z[1]), text: t("gantt." + z[0]) }));
    });
    zoomSel.value = String(zoom);
    actions.appendChild(zoomSel);
    if (PMS.auth ? (PMS.auth.can("tasks.write") || PMS.auth.canCreateTask()) : true) {
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("tasks.newTask"), on: { click: function () { PMS.editors.openTaskEditor(null, {}); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    var tasks = tasksForGantt();
    var canDrag = PMS.auth ? PMS.auth.can("tasks.write") : true;
    container.appendChild(h("div.u-muted", { text: (tasks.length ? (t("tasksTotal") + ": " + tasks.length + " · ") : "") + (canDrag ? t("gantt.dragHint") : t("gantt.viewOnly")), style: { marginBlockEnd: "12px", fontSize: "0.8rem" } }));

    if (!tasks.length) {
      var emptyActions = [h("div", { text: t("tasks.noTasks") })];
      if (PMS.auth ? PMS.auth.can("data.manage") : true) emptyActions.push(h("button.btn.btn-primary", { text: t("settings.seedData"), on: { click: function () { PMS.editors.loadSampleData(); } } }));
      container.appendChild(h("div.empty-state", emptyActions));
      return;
    }

    // compute date range
    var min = null, max = null;
    tasks.forEach(function (tsk) {
      var s = PMS.utils.parseDate(tsk.startDate), e = PMS.utils.parseDate(tsk.dueDate);
      if (s && (!min || s < min)) min = s;
      if (e && (!max || e > max)) max = e;
    });
    if (!min || !max) { min = new Date(); max = new Date(Date.now() + 7 * DAY); }
    min.setHours(0, 0, 0, 0); max.setHours(0, 0, 0, 0);
    var today = PMS.utils.parseDate(PMS.utils.todayISO());

    var timeSpanDays = Math.round((max - min) / DAY) + 1;
    // cap gridline density for huge date ranges (keeps the DOM light)
    var gridStep = Math.max(1, Math.ceil(timeSpanDays / 240));

    var root = h("div.gantt-root", { style: { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)" } });
    var wrap = h("div.gantt-wrap");
    root.appendChild(wrap);

    // ---- header row ----
    var headRow = h("div.gantt-header", { style: { display: "flex", borderBlockEnd: "1px solid var(--border)", background: "var(--bg-subtle)" } });
    headRow.appendChild(h("div.gantt-label-col", { text: t("tasks.title"), style: { fontWeight: "700", padding: "12px 12px", borderInlineEnd: "1px solid var(--border)" } }));
    var timeHead = h("div.gantt-time-col", { style: { position: "relative", height: "38px" } });

    // month band (date labels)
    var monthStarts = monthStartsIn(min, max);
    monthStarts.forEach(function (ms, idx) {
      var offLeft = Math.round((ms - min) / DAY) * zoom;
      var mEnd = idx + 1 < monthStarts.length ? monthStarts[idx + 1] : new Date(max.getTime() + DAY);
      var offRight = Math.round((mEnd - min) / DAY) * zoom;
      var ml = h("div.gantt-month-label", {
        style: { position: "absolute", top: "0", left: offLeft + "px", width: Math.max(10, offRight - offLeft) + "px", height: "24px", lineHeight: "24px", paddingInlineStart: "8px", fontSize: "0.72rem", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden" }
      });
      ml.textContent = PMS.utils.formatDate(PMS.utils.toISODate(ms), PMS.i18n, { month: "short", year: "numeric" });
      timeHead.appendChild(ml);

      // month separator gridline
      timeHead.appendChild(h("div.gantt-gridline.gantt-monthline", { style: { left: offLeft + "px", top: "0", height: "38px" } }));
    });

    // day numbers
    for (var i = 0; i <= timeSpanDays; i += gridStep) {
      var dayD = new Date(min.getTime() + i * DAY);
      var lbl = h("div.gantt-day-label", { style: { left: (i * zoom) + "px", top: "24px" } });
      lbl.textContent = String(dayD.getDate());
      timeHead.appendChild(lbl);
      var gridline = h("div.gantt-gridline", { style: { left: (i * zoom) + "px", top: "24px", height: "14px" } });
      timeHead.appendChild(gridline);
    }
    headRow.appendChild(timeHead);
    wrap.appendChild(headRow);

    // ---- body rows ----
    var body = h("div.gantt-body");
    var SVG_NS = "http://www.w3.org/2000/svg";
    var linksSvg = h("svg.gantt-links", { attrs: { width: ((timeSpanDays) * zoom) + "px", height: (tasks.length * 40) + "px", style: "position:absolute;top:0;left:0;pointer-events:none;" } });
    try {
      var defs = h("defs", {}, [h("marker", { attrs: { id: "arrowhead", markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: "auto" } }, [h("polygon", { attrs: { points: "0 0, 10 3.5, 0 7" } })])]);
      linksSvg.appendChild(defs);
    } catch (e) { console.error("[gantt] svg defs", e); }

    function buildRow(tsk, idx) {
      var isSub = !!tsk.parentTaskId;
      var row = h("div.gantt-row" + (isSub ? ".gantt-row-sub" : ""), { style: { height: "40px" } });
      var labelCell = h("div.gantt-label-col", { style: { padding: "0 12px", borderInlineEnd: "1px solid var(--border)" } });
      if (isSub) labelCell.style.paddingInlineStart = "28px";
      labelCell.appendChild(h("span.u-ellipsis", { text: tsk.title }));
      var startD = PMS.utils.parseDate(tsk.startDate);
      var endD = PMS.utils.parseDate(tsk.dueDate);
      var rangeText;
      if (!startD && !endD) rangeText = t("gantt.noDate");
      else if (!startD) rangeText = t("gantt.due") + " " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
      else if (!endD) rangeText = t("gantt.from") + " " + PMS.utils.formatDate(tsk.startDate, PMS.i18n);
      else rangeText = PMS.utils.formatDate(tsk.startDate, PMS.i18n) + " \u2192 " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
      labelCell.appendChild(h("div.u-muted", { text: rangeText, style: { fontSize: "0.7rem", lineHeight: "1.2", direction: "ltr", textAlign: "start" } }));
      row.appendChild(labelCell);

      var timeCell = h("div.gantt-time-col", { style: { position: "relative" } });
      var start = PMS.utils.parseDate(tsk.startDate);
      var end = PMS.utils.parseDate(tsk.dueDate);
      if (!start && !end) { start = today; end = new Date(today.getTime() + DAY); }
      else if (!start) start = end;
      else if (!end) end = start;
      var left = Math.round((start - min) / DAY) * zoom;
      var width = Math.max(18, Math.round((end - start) / DAY) * zoom + zoom);

      var color = statusColorOf(tsk.status);
      var bar = h("div.gantt-bar" + (isSub ? ".gantt-bar-sub" : ""), {
        dataset: { id: tsk.id },
        attrs: { title: barTitle(tsk, t) },
        style: { left: left + "px", width: width + "px", background: color },
        on: {
          click: function (e) { e.stopPropagation(); PMS.taskDetail.open(tsk.id); }
        }
      });
      bar.textContent = tsk.title;
      addDragBar(bar, tsk, start, min, end, render, container, zoom);
      timeCell.appendChild(bar);

      for (var c = 0; c <= timeSpanDays; c += gridStep) {
        var gl = h("div.gantt-gridline", { style: { left: (c * zoom) + "px" } });
        timeCell.insertBefore(gl, timeCell.firstChild);
      }
      var td = h("div.gantt-today", { style: { left: (Math.round((today - min) / DAY) * zoom) + "px" } });
      timeCell.appendChild(td);

      row.appendChild(timeCell);
      body.appendChild(row);
    }

    tasks.forEach(function (tsk) {
      try {
        buildRow(tsk);
      } catch (e) {
        console.error("[gantt] row render failed", tsk, e);
        var badRow = h("div.gantt-row", { style: { height: "40px", color: "var(--danger)", padding: "0 12px" } });
        badRow.textContent = (tsk && tsk.title ? tsk.title + " — " : "") + (e && e.message ? e.message : e);
        body.appendChild(badRow);
      }
    });

    container.appendChild(root);

    // after layout, draw dependency links (need pixel positions; compute manually again)
    drawLinks(linksSvg, tasks, min, zoom);

    // insert linksSvg over body
    var bodyWrapper = h("div", { style: { position: "relative" } });
    bodyWrapper.appendChild(body);
    bodyWrapper.appendChild(linksSvg);
    wrap.appendChild(bodyWrapper);
  }

  function addDragBar(bar, tsk, start, min, end, render, container, zoom) {
    // only admins may move/schedule tasks (members: status-only edits)
    if (!(PMS.auth ? PMS.auth.can("tasks.write") : true)) {
      bar.style.cursor = "pointer";
      return;
    }
    var isDragging = false;
    bar.addEventListener("pointerdown", function (e) {
      var startX = e.clientX;
      var origStart = start.getTime();
      var origEnd = end.getTime();
      var moved = false;
      function move(ev) {
        var dx = ev.clientX - startX;
        var days = Math.round(dx / zoom);
        var newStart = new Date(origStart + days * DAY);
        var newEnd = new Date(origEnd + days * DAY);
        if (newStart.toISOString() === start.toISOString() && newEnd.toISOString() === end.toISOString()) { moved = true; }
        bar.style.left = (Math.round((newStart - min) / DAY) * zoom) + "px";
        bar.style.width = Math.max(18, Math.round((newEnd - newStart) / DAY) * zoom + zoom) + "px";
        bar._temp = { s: PMS.utils.toISODate(newStart), e: PMS.utils.toISODate(newEnd) };
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (bar._temp) {
          PMS.repos.tasks.update(tsk.id, { startDate: bar._temp.s, dueDate: bar._temp.e });
          bar._temp = null;
        }
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      bar.setPointerCapture && bar.setPointerCapture(e.pointerId);
    });
  }

  function drawLinks(linksSvg, tasks, min, zoom) {
    tasks.forEach(function (tsk) {
      var deps = Array.isArray(tsk.dependencies) ? tsk.dependencies : [];
      deps.forEach(function (depId) {
        var dep = PMS.repos.tasks.get(depId);
        if (!dep) return;
        var tStart = PMS.utils.parseDate(tsk.startDate) || PMS.utils.parseDate(tsk.dueDate);
        var tEnd = PMS.utils.parseDate(tsk.dueDate) || tStart;
        var dStart = PMS.utils.parseDate(dep.startDate) || PMS.utils.parseDate(dep.dueDate);
        var dEnd = PMS.utils.parseDate(dep.dueDate) || dStart;
        if (!tStart || !dEnd) return;
        var x1 = Math.round((dEnd - min) / DAY) * zoom + zoom;
        var x2 = Math.round((tStart - min) / DAY) * zoom;
        var y1 = taskRowY(dep.id) + 20;
        var y2 = taskRowY(tsk.id) + 20;
        var path = h("path", { attrs: { d: "M " + x1 + " " + y1 + " H " + (x1 + 8) + " C " + (x1 + 18) + " " + y1 + ", " + (x2 - 18) + " " + y2 + ", " + (x2 - 8) + " " + y2 + " H " + x2, markerEnd: "url(#arrowhead)" } });
        linksSvg.appendChild(path);
      });
    });
  }

  function taskRowY(taskId) {
    var idx = tasksForGantt().findIndex(function (tsk) { return tsk.id === taskId; });
    return idx === -1 ? 0 : idx * 40;
  }

  function monthStartsIn(min, max) {
    var starts = [];
    var cur = new Date(min.getFullYear(), min.getMonth(), 1);
    while (cur <= max) {
      starts.push(new Date(cur));
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return starts;
  }

  function barTitle(tsk, t) {
    var st = PMS.utils.parseDate(tsk.startDate), ed = PMS.utils.parseDate(tsk.dueDate);
    var dates;
    if (!st && !ed) dates = t("gantt.noDate");
    else if (!st) dates = t("gantt.due") + " " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
    else if (!ed) dates = t("gantt.from") + " " + PMS.utils.formatDate(tsk.startDate, PMS.i18n);
    else dates = PMS.utils.formatDate(tsk.startDate, PMS.i18n) + " \u2192 " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
    var st2 = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === tsk.status; });
    var adv = PMS.progress.taskProgress(PMS.store.data, tsk.id, PMS.store.data.settings.weightByTime);
    return (tsk.title || "") + "\n" + dates + "\n" + (st2 ? st2.name.en : tsk.status || "") + " · " + Math.round(adv) + "%";
  }

  function statusColorOf(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? s.color : "#3b82f6";
  }

  var view = {
    id: "tasks-gantt",
    titleKey: "tasks.viewGantt",
    icon: "▤",
    nav: false,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/tasks/gantt") render(container); });
      return function () { off(); };
    }
  };

  PMS.registry.registerView(view);
  PMS.router.register("/tasks/gantt", "tasks-gantt");
})(window.PMS);