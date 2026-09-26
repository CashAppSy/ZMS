/* ==========================================================================
   Reports view - runs registered reports, renders tables + charts,
   exports CSV/JSON, printable.
   Route: /reports
   New reports = one PMS.reports.register() call (see report-engine.js).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("reports.title") }));
    var actions = h("div.actions");
    actions.appendChild(h("button.btn.btn-ghost", { text: t("reports.exportJson"), on: { click: PMS.exportService.exportAllJSON } }));
    actions.appendChild(h("button.btn.btn-ghost", { text: t("common.print"), on: { click: function () { window.print(); } } }));
    header.appendChild(actions);
    container.appendChild(header);

    if (!PMS.store.data.tasks.length) {
      var hint = h("div.card", { style: { marginBlockEnd: "16px" } });
      var hintBody = [h("p.u-muted", { text: t("reports.empty") })];
      if (PMS.auth ? PMS.auth.can("data.manage") : true) hintBody.push(h("button.btn.btn-sm", { text: t("settings.seedData"), on: { click: function () { PMS.editors.loadSampleData(); } } }));
      hint.appendChild(h("div.card-body", hintBody));
      container.appendChild(hint);
    }

    PMS.reports.all().forEach(function (def) {
      container.appendChild(reportCard(def));
    });
  }

  function reportCard(def) {
    var data = PMS.store.data;
    var result = PMS.reports.generate(def.id, data, {});
    if (!result) return h("div");

    var card = h("div.card.report-card");
    var head = h("div.card-header");
    head.appendChild(h("div.u-grow.report-row-head", [
      h("div.card-title", { text: t(def.titleKey) }),
      h("span.u-muted", { text: t("reports.count") + ": " + result.rows.length })
    ]));
    var toolbar = h("div.report-toolbar");
    toolbar.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("reports.exportCsv"), on: { click: function () {
      PMS.exportService.downloadCSV(def.id + ".csv", result.rows, result.columns);
    } } }));
    head.appendChild(toolbar);
    card.appendChild(head);

    var body = h("div.card-body");

    // chart
    if (result.chart && result.chart.type === "donut") {
      var d = result.chart;
      var items = d.values.map(function (r) {
        var key = r && r.key !== undefined ? r.key : r[d.label];
        return { label: r[d.label], value: r[d.value], color: d.colorMap ? d.colorMap[key] : PMS.utils.colorForSeed(r[d.label]) };
      });
      var chartRow = h("div.u-flex", [PMS.charts.donut(items, { size: 130, thickness: 22 })]);
      body.appendChild(chartRow);
    }

    // table
    if (result.rows.length) {
      var tbl = h("table.tbl");
      var thead = h("thead");
      var hr = h("tr");
      result.columns.forEach(function (c) { hr.appendChild(h("th", { text: c })); });
      thead.appendChild(hr);
      tbl.appendChild(thead);
      var tbody = h("tbody");
      result.rows.forEach(function (r) {
        var tr = h("tr");
        result.columns.forEach(function (c) {
          var val = r[c];
          if (result.cellTypes && result.cellTypes[c] === "money") val = PMS.utils.money(val, PMS.store.data.settings.currency, PMS.i18n);
          tr.appendChild(h("td", { text: val === undefined || val === null ? "" : String(val) }));
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      var wrap = h("div.tbl-wrap", [tbl]);
      body.appendChild(wrap);
    } else {
      body.appendChild(h("div.u-muted", { text: t("reports.empty") }));
    }

    card.appendChild(body);
    return card;
  }

  var view = {
    id: "reports",
    path: "/reports",
    titleKey: "nav.reports",
    icon: "📊",
    nav: true,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/reports") render(container); });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/reports", "reports");
})(window.PMS);