/* ==========================================================================
   PMS.taskFilter - reusable filter toolbar for task views.
   Builds: search box, project/status/priority/assignee/department selects,
   due-date and start-date ranges, "late only" / "blocked only" /
   "critical only" / "main tasks only" toggles.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  function build(opts) {
    opts = opts || {};
    var state = opts.state || {};
    var query = Object.assign({}, opts.query);
    var bar = h("div.filter-bar");
    var data = PMS.store.data;

    // search
    var searchInput = h("input.input", { placeholder: t("search.placeholderTasks"), value: query.search || "" });
    searchInput.style.width = "140px";
    bar.appendChild(searchInput);

    // project
    var projectSel = selectOptions(data.projects.map(function (p) { return { label: p.name, value: p.id }; }), query.projectId, t("tasks.project") + "…");
    bar.appendChild(projectSel);

    // status
    var statusSel = selectOptions(data.taskStatuses.map(function (s) { return { label: PMS.i18n.trilingual(s.name)(s.name), value: s.key }; }), query.statusKey || firstOf(query.status), t("common.status") + "…");
    bar.appendChild(statusSel);

    // priority
    var prioSel = selectOptions(data.priorities.map(function (p) { return { label: PMS.i18n.trilingual(p.name)(p.name), value: p.key }; }), query.priorityKey || firstOf(query.priority), t("common.priority") + "…");
    bar.appendChild(prioSel);

    // assignee
    var assignSel = selectOptions(data.people.map(function (p) { return { label: p.name, value: p.id }; }), query.assigneeId, t("tasks.assignees") + "…");
    bar.appendChild(assignSel);

    // due-date range: the two ends of the schedule a reader actually asks about.
    // Both are optional and independent, so "everything due in March" and
    // "everything overdue" can be asked in one go.
    var dueFrom = dateInput(t("tasks.dueFrom"), query.from);
    var dueTo = dateInput(t("tasks.dueTo"), query.to);
    bar.appendChild(dueFrom.wrap);
    bar.appendChild(dueTo.wrap);

    // start-date range, for "what are we working on this month" as opposed to
    // "what is due this month".
    var startFrom = dateInput(t("tasks.startFrom"), query.startFrom);
    var startTo = dateInput(t("tasks.startTo"), query.startTo);
    bar.appendChild(startFrom.wrap);
    bar.appendChild(startTo.wrap);

    // toggles
    var lateCb = check(t("tasks.overdue"), query.lateOnly);
    var blockedCb = check(t("deps.showBlocked"), query.blockedOnly);
    var criticalCb = check(t("deps.showCritical"), query.criticalOnly);
    var mainCb = check(t("tasks.mainOnly"), query.mainOnly);
    bar.appendChild(lateCb.row);
    bar.appendChild(blockedCb.row);
    bar.appendChild(criticalCb.row);
    bar.appendChild(mainCb.row);

    // apply
    bar.appendChild(h("button.btn.btn-primary.btn-sm", {
      text: t("common.apply"),
      on: { click: function () {
        var f = {
          search: searchInput.value,
          projectId: projectSel.value || undefined,
          statusKey: statusSel.value || undefined,
          priorityKey: prioSel.value || undefined,
          assigneeId: assignSel.value || undefined,
          from: dueFrom.input.value || undefined,
          to: dueTo.input.value || undefined,
          startFrom: startFrom.input.value || undefined,
          startTo: startTo.input.value || undefined,
          lateOnly: lateCb.input.checked,
          blockedOnly: blockedCb.input.checked,
          criticalOnly: criticalCb.input.checked,
          mainOnly: mainCb.input.checked
        };
        opts.onApply && opts.onApply(f);
      } }
    }));
    bar.appendChild(h("button.btn.btn-sm.btn-ghost", {
      text: t("common.clear"),
      on: { click: function () {
        // Every control goes back to blank, not just the ones the user touched:
        // a stale date left behind would silently keep narrowing the list after
        // "Clear".
        searchInput.value = "";
        projectSel.value = "";
        statusSel.value = "";
        prioSel.value = "";
        assignSel.value = "";
        dueFrom.input.value = ""; dueTo.input.value = "";
        startFrom.input.value = ""; startTo.input.value = "";
        [lateCb, blockedCb, criticalCb, mainCb].forEach(function (c) { c.input.checked = false; });
        opts.onApply && opts.onApply({});
      } }
    }));

    function selectOptions(list, selected, placeholder) {
      var sel = h("select.select.filter-multi");
      sel.appendChild(h("option", { value: "", text: placeholder }));
      list.forEach(function (o) { sel.appendChild(h("option", { value: o.value, text: o.label })); });
      sel.value = selected || "";
      return sel;
    }

    return bar;
  }

  // A bare date box. `type="date"` gives the browser's own calendar and returns
  // an ISO yyyy-mm-dd string, which is the format every stored date uses - so no
  // parsing and no locale ambiguity between what was typed and what is compared.
  function dateInput(label, value) {
    var wrap = h("label.date-filter", { attrs: { title: label } });
    var input = h("input.input", { type: "date", value: value || "" });
    input.style.width = "140px";
    wrap.appendChild(h("span.date-filter-label", { text: label }));
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function check(label, checked) {
    var row = h("label.checkbox-row");
    var input = h("input", { type: "checkbox", checked: !!checked });
    row.appendChild(input);
    row.appendChild(h("span", { text: label }));
    return { row: row, input: input };
  }

  // A saved filter may carry the array form; the single-value selects show the
  // first entry so the toolbar reflects what is actually applied.
  function firstOf(list) { return Array.isArray(list) ? list[0] : undefined; }

  PMS.taskFilter = { build: build };
})(window.PMS);