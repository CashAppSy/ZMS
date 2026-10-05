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

  /* One source of truth for the chart's vertical geometry.
     The rows are DOM elements and the dependency arrows are an SVG painted on
     top of them, so the two halves have to agree on how tall a row is and where
     its centre sits. These were 40 and 20 repeated across four separate places:
     the row builder, the error-row fallback, the row->y lookup and the arrow
     maths. Editing any one of them slid the arrows off the bars they belong to
     - down one row, or by the height of a border - and nothing failed loudly
     enough to notice. BAR_H is what CSS draws (.gantt-bar); it is named here so
     the arrow endpoints and the bar share a value rather than a coincidence. */
  var ROW_H = 40;   // px per task row
  var BAR_H = 22;   // px bar height
  var ARROW_DY = ROW_H / 2; // centre line of a row: where an arrow enters/leaves
  /* Width of the label column. One value, pushed into CSS as a custom property,
     because the timeline geometry depends on it twice: the bars are placed from
     the time column's own left edge, and the arrow overlay has to start exactly
     there too. */
  var LABEL_W = 260;

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
      if (PMS.auth ? PMS.auth.can("data.manage") : true) emptyActions.push(h("button.btn.btn-primary", { text: t("settings.seedData"), on: { click: function () { PMS.auth.confirmSensitive(function () { PMS.editors.loadSampleData(); }); } } }));
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
    // CSS reads the column width from here rather than keeping its own copy, so
    // the rows and the arrow overlay can never disagree about where the timeline
    // begins.
    root.style.setProperty("--gantt-label-w", LABEL_W + "px");
    var wrap = h("div.gantt-wrap");
    // The label column plus the whole timeline. Without this the wrapper was
    // sized by the arrow overlay alone, which squeezed the time column by the
    // width of the label column and pushed the last bars past the right edge.
    var timelineW = timeSpanDays * zoom;
    wrap.style.minWidth = "max(100%, " + (LABEL_W + timelineW) + "px)";
    root.appendChild(wrap);

    // ---- header row ----
    // The header is a sticky band sitting on rows of ROW_H. Two pixels shorter, its
    // month band did not line up with the first row's bar centre, so the sticky
    // header visibly nudged the grid by 1px when you scrolled past it.
    var headRow = h("div.gantt-header", { style: { display: "flex", borderBlockEnd: "1px solid var(--border)", background: "var(--bg-subtle)" } });
    headRow.appendChild(h("div.gantt-label-col", { text: t("tasks.title"), style: { fontWeight: "700", padding: "12px 12px", borderInlineEnd: "1px solid var(--border)" } }));
    var timeHead = h("div.gantt-time-col", { style: { position: "relative", height: ROW_H + "px" } });

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
      timeHead.appendChild(h("div.gantt-gridline.gantt-monthline", { style: { left: offLeft + "px", top: "0", height: ROW_H + "px" } }));
    });

    // day numbers. They hang under the month band, so the band's own height is
    // the offset and the row height is the ceiling: the tick marks run to the
    // bottom of the header whatever that height is, rather than to a second
    // hand-typed number that quietly stops matching it.
    var DAY_BAND_TOP = 24;
    for (var i = 0; i <= timeSpanDays; i += gridStep) {
      var dayD = new Date(min.getTime() + i * DAY);
      var lbl = h("div.gantt-day-label", { style: { left: (i * zoom) + "px", top: DAY_BAND_TOP + "px" } });
      lbl.textContent = String(dayD.getDate());
      timeHead.appendChild(lbl);
      var gridline = h("div.gantt-gridline", { style: { left: (i * zoom) + "px", top: DAY_BAND_TOP + "px", height: (ROW_H - DAY_BAND_TOP) + "px" } });
      timeHead.appendChild(gridline);
    }
    headRow.appendChild(timeHead);
    wrap.appendChild(headRow);

    // ---- body rows ----
    var body = h("div.gantt-body");
    var SVG_NS = "http://www.w3.org/2000/svg";
    /* The overlay sits over the time column, not over the whole chart: it is offset
       by the label column so its x origin is the same origin the bars are placed
       from. Anchored at 0 it drew every arrow one label-column to the left of the
       bar it belonged to. */
    var linksSvg = h("svg.gantt-links", { attrs: { width: (timelineW) + "px", height: (tasks.length * ROW_H) + "px", style: "position:absolute;top:0;left:" + LABEL_W + "px;pointer-events:none;" } });
    try {
      // One marker per link type, so the arrowhead carries the same colour as
      // its line. A single marker would be filled one colour and every arrow
      // would claim to be the same kind of link.
      var MARKER_FILL = {
        FS: "var(--primary)", SS: "var(--info)",
        FF: "var(--warning)", SF: "var(--purple)",
        broken: "var(--danger)"
      };
      var markers = Object.keys(MARKER_FILL).map(function (k) {
        return h("marker", {
          attrs: { id: "arrowhead-" + k, markerWidth: 10, markerHeight: 7, refX: 9, refY: 3.5, orient: "auto" }
        }, [h("polygon", { attrs: { points: "0 0, 10 3.5, 0 7", fill: MARKER_FILL[k] } })]);
      });
      linksSvg.appendChild(h("defs", {}, markers));
    } catch (e) { console.error("[gantt] svg defs", e); }

    // Once per render: the critical path and the blocking predecessors are
    // whole-program questions, and asking per bar would analyse the network
    // once for every row on the screen.
    var netAnalysis = PMS.dependencies.analyzeCached(PMS.store.data);

    function buildRow(tsk, idx) {
      var isSub = !!tsk.parentTaskId;
      var row = h("div.gantt-row" + (isSub ? ".gantt-row-sub" : ""), { style: { height: ROW_H + "px" } });
      var labelCell = h("div.gantt-label-col", { style: { padding: "0 12px", borderInlineEnd: "1px solid var(--border)" } });
      if (isSub) labelCell.style.paddingInlineStart = "28px";
// Title and dates are stacked and each truncates on its own, so the cell
    // keeps one fixed width no matter how long the title is. The markers ride
    // on the title's own line: appended as siblings they became extra rows in
    // this column flex, and with the row only ROW_H tall the overflow spilled
    // over the dates and made the fields look stacked on top of each other.
    var labelHead = h("div.gantt-label-head");
    labelHead.appendChild(h("span.gantt-label-title", { text: tsk.title, attrs: { title: tsk.title } }));
    var markers = PMS.vformat.depMarkers(PMS.store.data, tsk, netAnalysis);
    markers.forEach(function (m) { labelHead.appendChild(m); });
    labelCell.appendChild(labelHead);
if (PMS.dependencies.isCritical(netAnalysis, tsk.id)) labelCell.classList.add("is-critical");
    var startD = PMS.utils.parseDate(tsk.startDate);
      var endD = PMS.utils.parseDate(tsk.dueDate);
      var rangeText;
      if (!startD && !endD) rangeText = t("gantt.noDate");
      else if (!startD) rangeText = t("gantt.due") + " " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
      else if (!endD) rangeText = t("gantt.from") + " " + PMS.utils.formatDate(tsk.startDate, PMS.i18n);
      else rangeText = PMS.utils.formatDate(tsk.startDate, PMS.i18n) + " → " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
      labelCell.appendChild(h("div.gantt-label-dates.u-muted", { text: rangeText, style: { direction: "ltr", textAlign: "start" }, attrs: { title: rangeText } }));
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
      // Critical and blocked are classes, not colours: the bar keeps its status
      // colour so the band stays readable, and the marking is a ring or a mark
      // laid over it.
      var bar = h("div.gantt-bar" + (isSub ? ".gantt-bar-sub" : "")
        + (PMS.dependencies.isCritical(netAnalysis, tsk.id) ? ".is-critical" : "")
        + (PMS.dependencies.isBlocked(PMS.store.data, tsk) ? ".is-blocked" : ""), {
        dataset: { id: tsk.id },
        attrs: { title: barTitle(tsk, t, netAnalysis) },
        style: { left: left + "px", width: width + "px", background: color },
        on: {
          click: function (e) { e.stopPropagation(); PMS.taskDetail.open(tsk.id); }
        }
      });
      // Wrapped so the bar's own overflow clips the text with an ellipsis;
      // a bare text node cannot be truncated by text-overflow.
      bar.appendChild(h("span", { text: tsk.title }));
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
        var badRow = h("div.gantt-row", { style: { height: ROW_H + "px", color: "var(--danger)", padding: "0 12px" } });
        badRow.textContent = (tsk && tsk.title ? tsk.title + " — " : "") + (e && e.message ? e.message : e);
        body.appendChild(badRow);
      }
    });

    container.appendChild(root);

    // A legend, because four line styles and a red ring cannot be guessed at.
    // It only appears when the chart actually draws links.
    if (PMS.dependencies.edges(PMS.store.data).length) {
      var legend = h("div.gantt-legend", { style: { padding: "8px 12px" } });
      ["FS", "SS", "FF", "SF"].forEach(function (type) {
        var key = h("span.u-flex", { style: { gap: "5px", alignItems: "center" } });
        var swatch = h("span", { style: { width: "22px", height: "0", borderTopWidth: "2px", borderTopStyle: type === "FS" ? "solid" : "dashed" } });
        swatch.classList.add("dep-" + type);
        key.appendChild(swatch);
        key.appendChild(h("span", { text: PMS.dependencies.label(type) }));
        legend.appendChild(key);
      });
      legend.appendChild(h("span.dep-marker.dep-marker-critical", { text: "◆ " + t("deps.critical") }));
      legend.appendChild(h("span.dep-marker.dep-marker-blocked", { text: "⛔ " + t("deps.blocked") }));
      wrap.appendChild(legend);
    }

    // after layout, draw dependency links (need pixel positions; compute manually again)
    drawLinks(linksSvg, tasks, min, zoom, netAnalysis);

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

  function drawLinks(linksSvg, tasks, min, zoom, netAnalysis) {
    // Where an arrow leaves and lands depends on the type of link. Every type
    // but FS hangs off the predecessor's START or the successor's END, so
    // drawing them all from finish to start - which is what this used to do -
    // drew an SS link that started at the wrong edge and said nothing true
    // about the constraint.
    //
    //   FS  predecessor finish -> successor start
    //   SS  predecessor start  -> successor start
    //   FF  predecessor finish -> successor finish
    //   SF  predecessor start  -> successor finish
    function edgesOf(tsk) {
      var s = PMS.utils.parseDate(tsk.startDate) || PMS.utils.parseDate(tsk.dueDate);
      var e = PMS.utils.parseDate(tsk.dueDate) || s;
      if (!s) return null;
      return {
        start: Math.round((s - min) / DAY) * zoom,
        end: Math.round((e - min) / DAY) * zoom + zoom
      };
    }

    PMS.dependencies.edges(PMS.store.data).forEach(function (edge) {
      // A link to a task that is not on this chart has no row to point at. Row 0 is
      // a real row, so membership is asked of the list, not of the y value.
      var onChart = function (id) { return tasks.some(function (x) { return x.id === id; }); };
      if (!onChart(edge.fromId) || !onChart(edge.toId)) return;
      var from = edgesOf(edge.from), to = edgesOf(edge.to);
      if (!from || !to) return;

      var x1 = edge.type === "SS" || edge.type === "SF" ? from.start : from.end;
      var x2 = edge.type === "FS" || edge.type === "SS" ? to.start : to.end;
      var y1 = taskRowY(edge.fromId) + ARROW_DY;
      var y2 = taskRowY(edge.toId) + ARROW_DY;
      // A link whose dates already break it is drawn in the danger colour: the
      // arrow is then saying something is wrong, not just that a link exists.
      var broken = PMS.dependencies.isSatisfied(edge.dep, edge.from, edge.to) === false;
      var critical = PMS.dependencies.isCritical(netAnalysis, edge.fromId) &&
        PMS.dependencies.isCritical(netAnalysis, edge.toId);
      var cls = "dep-" + edge.type + (broken ? " dep-broken" : "") + (critical ? " dep-critical" : "");
      var title = edge.from.title + " → " + edge.to.title + " (" + PMS.dependencies.label(edge.type) +
        (edge.dep.lag ? " " + (edge.dep.lag > 0 ? "+" : "") + edge.dep.lag + "d" : "") + ")" +
        (broken ? " — " + t("deps.broken") : "");

      // Route around the bars when the successor starts before the predecessor
      // ends, the way every gantt tool does: a curve straight through the two
      // bars would hide them.
      var d;
      if (x2 < x1 + 16) {
        // The successor starts before the predecessor ends, so a straight run
        // would go backwards through both bars. Route it out to the side, down
        // and back in from the right, so the head still points into the bar: the
        // last segment has to travel towards x2, not away from it, or the
        // arrowhead lands short of the target and faces the wrong way.
        var dip = 14;
        d = "M " + x1 + " " + y1 + " h " + dip + " V " + y2 + " H " + (x2 + dip) +
          " a " + dip + " " + (dip / 2) + " 0 0 1 " + (-dip) + " " + (dip / 2);
      } else {
        d = "M " + x1 + " " + y1 + " H " + (x1 + 8) + " C " + (x1 + 18) + " " + y1 + ", " + (x2 - 18) + " " + y2 + ", " + (x2 - 8) + " " + y2 + " H " + x2;
      }
      // Every arrow is given its own markerhead by attribute. The attribute is
      // spelled "marker-end": written as markerEnd it is dropped as an unknown
      // property, which is why the arrows used to arrive headless.
      var path = h("path", {
        attrs: {
          d: d, fill: "none", "stroke-linecap": "round",
          class: cls,
          "marker-end": "url(#arrowhead-" + (broken ? "broken" : edge.type) + ")"
        }
      }, [h("title", { text: title })]);
      linksSvg.appendChild(path);
    });
  }

  function taskRowY(taskId) {
    var idx = tasksForGantt().findIndex(function (tsk) { return tsk.id === taskId; });
    return idx === -1 ? 0 : idx * ROW_H;
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

  function barTitle(tsk, t, netAnalysis) {
    var st = PMS.utils.parseDate(tsk.startDate), ed = PMS.utils.parseDate(tsk.dueDate);
    var dates;
    if (!st && !ed) dates = t("gantt.noDate");
    else if (!st) dates = t("gantt.due") + " " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
    else if (!ed) dates = t("gantt.from") + " " + PMS.utils.formatDate(tsk.startDate, PMS.i18n);
    else dates = PMS.utils.formatDate(tsk.startDate, PMS.i18n) + " \u2192 " + PMS.utils.formatDate(tsk.dueDate, PMS.i18n);
    var st2 = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === tsk.status; });
    var adv = PMS.programProgress.taskProgress(PMS.store.data, tsk);
    // The network facts a bar has no room to show, on the hover: a task on the
    // critical path or waiting on an unfinished predecessor is exactly the one
    // to read before moving it.
    var net = [];
    if (PMS.dependencies.isCritical(netAnalysis, tsk.id)) net.push(t("deps.critical"));
    var blocked = PMS.dependencies.blocking(PMS.store.data, tsk);
    if (blocked.length) {
      net.push(t("deps.blockedBy") + ": " + blocked.map(function (b) { return b.task.title; }).join(", "));
    }
    var lines = [(tsk.title || ""), dates,
      (st2 ? st2.name.en : tsk.status || "") + " · " + PMS.utils.pctBand(adv)];
    if (net.length) lines.push(net.join(" — "));
    return lines.join("\n");
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