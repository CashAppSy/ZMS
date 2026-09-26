/* ==========================================================================
   PMS.taskFilter - reusable filter toolbar for task views.
   Builds: search box, project/status/priority/assignee/department selects,
   tags, date range, "late only" toggle, group-by select.
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
    var statusSel = selectOptions(data.taskStatuses.map(function (s) { return { label: PMS.i18n.trilingual(s.name)(s.name), value: s.key }; }), query.statusKey, t("common.status") + "…");
    bar.appendChild(statusSel);

    // priority
    var prioSel = selectOptions(data.priorities.map(function (p) { return { label: PMS.i18n.trilingual(p.name)(p.name), value: p.key }; }), query.priorityKey, t("common.priority") + "…");
    bar.appendChild(prioSel);

    // assignee
    var assignSel = selectOptions(data.people.map(function (p) { return { label: p.name, value: p.id }; }), query.assigneeId, t("tasks.assignees") + "…");
    bar.appendChild(assignSel);

    // late only
    var lateCb = h("label.checkbox-row");
    var lateChk = h("input", { type: "checkbox", checked: !!query.lateOnly });
    lateCb.appendChild(lateChk);
    lateCb.appendChild(h("span", { text: t("tasks.overdue") }));
    bar.appendChild(lateCb);

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
          lateOnly: lateChk.checked
        };
        opts.onApply && opts.onApply(f);
      } }
    }));
    bar.appendChild(h("button.btn.btn-sm.btn-ghost", {
      text: t("common.clear"),
      on: { click: function () {
        searchInput.value = "";
        projectSel.value = "";
        statusSel.value = "";
        prioSel.value = "";
        assignSel.value = "";
        lateChk.checked = false;
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

  PMS.taskFilter = { build: build };
})(window.PMS);