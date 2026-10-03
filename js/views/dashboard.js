/* ==========================================================================
   Dashboard view - KPIs, status/priority donuts, progress by project,
   overdue tasks, upcoming tasks, team workload.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  function render(container) {
    container.innerHTML = "";
    // scoped, so a member's dashboard totals only the work they may see
    var data = PMS.repos.scopedData();
    var tasks = data.tasks || [];
    var projects = data.projects || [];
    var people = data.people || [];
    var today = PMS.utils.todayISO();
    var weekEnd = PMS.utils.toISODate(new Date(Date.now() + 7 * 86400000));
    var doneKey = findDoneKey("task");

    var totalTasks = tasks.length;
    var overdue = tasks.filter(function (tsk) { return tsk.dueDate && tsk.dueDate < today && tsk.status !== doneKey; });
    var dueThisWeek = tasks.filter(function (tsk) { return tsk.dueDate && tsk.dueDate >= today && tsk.dueDate <= weekEnd; });
    var activeProjects = projects.filter(function (p) { return p.status === "active"; });

    // avg progress of top-level tasks (derived from status + sub-tasks)
    var progSum = 0, progN = 0;
    var progressMap = {};
    tasks.forEach(function (tsk) {
      var p = PMS.programProgress.taskProgress(data, tsk);
      // A task flagged as somebody's breakdown is represented by its parent, so
      // counting both would count the same work twice in this average.
      if (!tsk.parentTaskId) { progSum += p; progN++; }
      progressMap[tsk.id] = p;
    });
    var avg = progN ? progSum / progN : 0;

    // overall progress: weighted mean over ALL pillars — each pillar's weight
    // decides its share of the total. Same engine as the pillar pages, so the
    // dashboard ring can never disagree with a pillar's own number.
    var overall = PMS.programProgress.programProgress(data);
    // how many pillars actually participate in that mean (have direct work + weight)
    var weightedPillars = projects.filter(function (p) {
      return PMS.programProgress.pillarRawWeight(p) > 0 && tasks.some(function (t) { return t.projectId === p.id && !t.parentTaskId; });
    }).length;

    // by status/priority
    var byStatus = {}, byPriority = {};
    tasks.forEach(function (tsk) { byStatus[tsk.status] = (byStatus[tsk.status] || 0) + 1; byPriority[tsk.priority] = (byPriority[tsk.priority] || 0) + 1; });

    // projects by status (for the byProjectStatus donut)
    var byProjectStatus = {};
    projects.forEach(function (p) { byProjectStatus[p.status] = (byProjectStatus[p.status] || 0) + 1; });

    var statusColors = {}, prioColors = {}, pStatusColors = {};
    (data.taskStatuses || []).forEach(function (s) { statusColors[s.key] = s.color; });
    (data.priorities || []).forEach(function (p) { prioColors[p.key] = p.color; });
    (data.projectStatuses || []).forEach(function (s) { pStatusColors[s.key] = s.color; });

    // KPIs
    var kpis = h("div.kpi-grid");
    addKpi(kpis, t("dashboard.kpiProjects"), projects.length, t("dashboard.activeProjects") + " " + activeProjects.length);
    addKpi(kpis, t("dashboard.kpiTasks"), totalTasks, t("dashboard.kpiAvgProgress") + ": " + PMS.utils.pct(avg));
    addKpi(kpis, t("dashboard.kpiOverdue"), overdue.length, overdue.length ? t("projects.late") : t("dashboard.noLate"), overdue.length ? "danger" : "ok");
    addKpi(kpis, t("dashboard.kpiDueThisWeek"), dueThisWeek.length, "");

    var root = h("div");

    if (!tasks.length && !projects.length) {
      var intro = h("div.card", { style: { marginBlockEnd: "16px" } });
      var introActions = [];
      if (PMS.auth ? (PMS.auth.can("tasks.write") || PMS.auth.canCreateTask()) : true) {
        introActions.push(h("button.btn.btn-primary", { text: "+ " + t("dashboard.newTask"), on: { click: function () { PMS.editors.openTaskEditor(null, {}); } } }));
      }
      if (PMS.auth ? PMS.auth.can("projects.write") : true) {
        introActions.unshift(h("button.btn", { text: "+ " + t("dashboard.newProject"), on: { click: function () { PMS.editors.openProjectEditor(null, {}); } } }));
      }
      if (PMS.auth ? PMS.auth.can("data.manage") : true) {
        introActions.push(h("button.btn.btn-ghost", { text: t("settings.seedData"), on: { click: function () { PMS.auth.confirmSensitive(function () { PMS.editors.loadSampleData(); }); } } }));
      }
      intro.appendChild(h("div.card-body", [
        h("p.u-bold", { text: t("dashboard.title") }),
        h("p.u-muted", { text: t("dashboard.emptyHint") }),
        h("div.u-flex", { style: { gap: "10px" } }, introActions)
      ]));
      root.appendChild(intro);
    }

    root.appendChild(kpis);

    // Hero charts row: overall ring + task distribution donuts
    var charts = h("div.dash-charts");
    charts.appendChild(overallCard(overall, weightedPillars));
    charts.appendChild(chartCard(t("dashboard.byStatus"), donutChart(byStatus, statusColors, totalTasks)));
    charts.appendChild(chartCard(t("dashboard.byPriority"), donutChart(byPriority, prioColors, totalTasks)));
    root.appendChild(charts);

    // Second charts row: projects by status + progress by project
    var charts2 = h("div.dash-charts.dash-charts-2col");
    charts2.appendChild(chartCard(t("dashboard.byProjectStatus"), donutChart(byProjectStatus, pStatusColors, projects.length)));
    charts2.appendChild(progressCard(t("dashboard.byProject"), topProjects(projects)));
    root.appendChild(charts2);

    // Lists row
    var lists = h("div.grid-2.dash-lists");
    lists.appendChild(listCard(t("dashboard.lateTasks"), overdueRow(overdue.slice(0, 8)), overdue.length));
    lists.appendChild(listCard(t("dashboard.upcomingTasks"), upcomingRow(dueThisWeek.slice(0, 8)), dueThisWeek.length));
    root.appendChild(lists);

    // workload
    var workloadRows = (data.people || []).slice(0, 8).map(function (person) {
      var cnt = tasks.filter(function (tsk) { return (tsk.assignees || []).indexOf(person.id) !== -1 && tsk.status !== doneKey; }).length;
      var bar = h("div.progress-track", { style: { width: "80px", height: "6px" } },
        [h("div.progress-fill", { style: { width: Math.min(100, cnt * 10) + "%" } })] );
      var wrap = h("div.project-progress-row");
      wrap.appendChild(PMS.vformat.avatar(person));
      wrap.appendChild(h("span.pp-name.u-ellipsis", { text: person.name }));
      wrap.appendChild(bar);
      wrap.appendChild(h("span.progress-label", { text: cnt + " " + t("dashboard.tasksTotal") }));
      return wrap;
    });
    root.appendChild(listCard(t("dashboard.workload"), workloadRows, (data.people || []).length, true));

    container.appendChild(root);
  }

  function addKpi(grid, label, value, sub, cls) {
    var card = h("div.card.kpi-card");
    card.appendChild(h("div.kpi-label", { text: label }));
    card.appendChild(h("div.kpi-value" + (cls ? "." + cls : ""), { text: String(value) }));
    card.appendChild(h("div.kpi-sub", { text: sub || "" }));
    grid.appendChild(card);
  }

  function chartCard(title, svgEl) {
    var card = h("div.card.chart-card");
    var head = h("div.card-header", [h("div.card-title", { text: title })]);
    var body = h("div.card-body", [svgEl]);
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  // Big Zain-colored overall-progress ring (centerpiece of the dashboard).
  function overallCard(percent, rootCount) {
    var card = h("div.card.chart-card.overall-ring-card");
    var head = h("div.card-header", [h("div.card-title", { text: t("dashboard.overallProgress") })]);
    var ring = PMS.charts.ring(percent, { size: 210, thick: 26, color: "#23AEB7" });
    ring.style.display = "block";
    var body = h("div.card-body", [
      ring,
      h("div.chart-legend", [
        h("span.lg-item", [
          h("span.lg-swatch", { style: { background: "var(--brand-grad)" } }),
          h("span", { text: t("dashboard.overallSub", { n: rootCount }) })
        ])
      ])
    ]);
    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  function donutChart(counts, colors, total) {
    var items = Object.keys(counts).map(function (k) {
      return { label: k, value: counts[k], color: colors[k] || PMS.utils.colorForSeed(k) };
    });
    var wrap = h("div", { style: { display: "flex", alignItems: "center", gap: "20px" } });
    wrap.appendChild(PMS.charts.donut(items, { size: 150, thickness: 26, centerText: String(total || 0) }));
    var legend = h("div.chart-legend");
    items.forEach(function (it) {
      var item = h("span.lg-item");
      item.appendChild(h("span.lg-swatch", { style: { background: it.color } }));
      item.appendChild(h("span", { text: prettyKey(it.label) + " (" + it.value + ")" }));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  function progressCard(title, list) {
    var card = h("div.card.chart-card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: title })]));
    var body = h("div.card-body", [h("div.project-progress-list", list)]);
    card.appendChild(body);
    return card;
  }

  function topProjects(projects) {
    var roots = projects.filter(function (p) { return !p.parentId; }).slice(0, 8);
    // The planned-slot engine: a new task adds spent slots but never changes the
    // denominator, so this list cannot drop when someone adds a task.
    var PP = PMS.programProgress;
    var all = PP.allPillarProgress(PMS.store.data);
    return roots.map(function (p) {
      var prog = all[p.id];
      var w = PP.pillarRawWeight(p);
      var row = h("div.project-progress-row");
      row.appendChild(h("span.pp-name.u-ellipsis", { text: p.name }));
      row.appendChild(h("span.badge", { text: t("projects.weight") + " " + w, style: { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
      row.appendChild(PMS.vformat.progressChip(prog));
      return row;
    });
  }

  function listCard(title, rows, count, full) {
    var card = h("div.card" + (full ? "" : ""));
    var head = h("div.card-header");
    head.appendChild(h("div.card-title", { text: title }));
    head.appendChild(h("span.badge", { text: String(count) }));
    card.appendChild(head);
    var body = h("div.card-body.stack", rows.length ? rows : [h("div.empty-state", [h("div", { text: "—" })])]);
    card.appendChild(body);
    return card;
  }

  function overdueRow(list) {
    return list.map(function (tsk) {
      var row = h("div.project-progress-row");
      row.appendChild(h("span.pp-name.u-ellipsis", { text: tsk.title }));
      row.style.cursor = "pointer";
      row.addEventListener("click", function () { openTask(tsk); });
      row.appendChild(h("span.badge", { text: tsk.dueDate || "", style: { background: "var(--danger-soft)", color: "var(--danger)" } }));
      return row;
    });
  }

  function upcomingRow(list) {
    return list.map(function (tsk) {
      var row = h("div.project-progress-row");
      row.appendChild(h("span.pp-name.u-ellipsis", { text: tsk.title }));
      row.style.cursor = "pointer";
      row.addEventListener("click", function () { openTask(tsk); });
      var statusColor = statusColorOf(tsk.status);
      row.appendChild(h("span.badge", { text: tsk.dueDate || "", style: { background: PMS.vformat.hexToSoft(statusColor), color: statusColor } }));
      return row;
    });
  }

  function findDoneKey(entity) {
    var list = entity === "project" ? PMS.store.data.projectStatuses : PMS.store.data.taskStatuses;
    var done = (list || []).find(function (s) { return s.key === "done"; });
    return done ? "done" : ((list && list[list.length - 1]) ? list[list.length - 1].key : "done");
  }

  function prettyKey(k) {
    var tk = "statuses.task." + k, pk = "statuses.project." + k, pr = "priorities." + k;
    if (PMS.i18n.t(tk) !== tk) return PMS.i18n.t(tk);
    if (PMS.i18n.t(pk) !== pk) return PMS.i18n.t(pk);
    if (PMS.i18n.t(pr) !== pr) return PMS.i18n.t(pr);
    return k;
  }

  function statusColorOf(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? s.color : "#6b7280";
  }

  function openTask(tsk) { PMS.router.navigate("/tasks"); }

  var view = {
    id: "dashboard",
    path: "/",
    titleKey: "nav.dashboard",
    icon: "▦",
    nav: true,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/") render(container); });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/", "dashboard");
})(window.PMS);