/* ==========================================================================
   Activity log view (admin-only) - the global, append-only history of every
   create / edit / status / progress / delete across tasks, projects, people
   and departments, recorded with the acting user and timestamp. Entries are
   sorted newest-first; CSV export mirrors the visible rows.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var ENTITY_COLORS = { task: "#2563eb", project: "#7c3aed", person: "#16a34a", department: "#ea580c", meeting: "#db2777", account: "#b45309" };

  function entityLabel(entity) {
    return t("activity.entities." + (entity || "")) !== ("activity.entities." + (entity || ""))
      ? t("activity.entities." + entity)
      : entity;
  }

  function actionLabel(action) {
    return t("activity.actions." + (action || "")) !== ("activity.actions." + (action || ""))
      ? t("activity.actions." + action)
      : action;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try { return d.toLocaleString(); } catch (e) { return iso; }
  }

  function exportCSV() {
    var entries = PMS.activity.entries();
    var labels = { at: t("activity.at"), actor: t("activity.user"), entity: t("activity.entity"), entityName: t("activity.entityName"), action: t("activity.action"), detail: t("activity.detail") };
    var rows = entries.slice().reverse().map(function (e) {
      return {
        at: e.at || "",
        actor: e.actor || "",
        entity: entityLabel(e.entity),
        entityName: e.entityName || "",
        action: actionLabel(e.action),
        detail: e.detail || ""
      };
    });
    PMS.exportService.downloadCSV("activity-log-" + PMS.utils.toISODate(new Date()) + ".csv", rows, ["at", "actor", "entity", "entityName", "action", "detail"], labels);
  }

  function clearLog(container) {
    PMS.modal.open({
      title: t("activity.clear"),
      content: h("p", { text: t("activity.clearConfirm") }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("activity.clear"), class: "btn-danger", onClick: function () {
          PMS.activity.clear();
          PMS.modal.close();
          PMS.toast.show(t("activity.cleared"), "success");
          render(container);
        } }
      ]
    });
  }

  function entryRow(e) {
    var color = ENTITY_COLORS[e.entity] || "var(--text-muted)";
    var row = h("div.act-row");
    row.appendChild(h("span.act-badge", { style: { background: PMS.vformat.hexToSoft(color), color: color }, text: entityLabel(e.entity) }));
    var main = h("div.act-main");
    var head = h("div.act-head");
    head.appendChild(h("span.act-name", { text: e.entityName || "—" }));
    head.appendChild(h("span.act-action", { text: actionLabel(e.action) }));
    main.appendChild(head);
    if (e.detail) main.appendChild(h("div.act-detail", { text: e.detail }));
    row.appendChild(main);
    var meta = h("div.act-meta");
    meta.appendChild(h("span.act-actor", { text: e.actor || "—" }));
    meta.appendChild(h("time.act-time", { attrs: { title: e.at || "" }, text: fmtTime(e.at) }));
    row.appendChild(meta);
    return row;
  }

  function render(container) {
    container.innerHTML = "";
    var entries = PMS.activity.entries();
    draw(container, entries);
    // Account/security events live in the cloud, not in the synced dataset, so
    // the first paint above may only have the local cache. Refresh and redraw
    // when the cloud answers. Only the admin view is reachable here, and the
    // rules deny these documents to everyone else.
    if (PMS.activity.refreshAccountEvents) {
      PMS.activity.refreshAccountEvents().then(function (rows) {
        if (!rows || !rows.length) return;
        if (PMS.router && PMS.router.current && PMS.router.current !== "/activity") return;
        draw(container, PMS.activity.entries());
      });
    }
  }

  function draw(container, entries) {

    var head = h("div.card");
    var headRow = h("div.u-flex", { style: { flexWrap: "wrap", gap: "10px", alignItems: "center", justifyContent: "space-between" } });
    var left = h("div.u-flex", { style: { gap: "8px", alignItems: "center" } });
    left.appendChild(h("div.u-bold", { text: t("activity.title") }));
    left.appendChild(h("span.badge", { text: String(entries.length) }));
    headRow.appendChild(left);
    var actions = h("div.u-flex", { style: { gap: "8px" } });
    actions.appendChild(h("button.btn.btn-sm", { text: t("activity.export"), on: { click: exportCSV } }));
    actions.appendChild(h("button.btn.btn-sm.btn-danger", { text: t("activity.clear"), on: { click: function () { clearLog(container); } } }));
    headRow.appendChild(actions);
    head.appendChild(h("div.card-body", [headRow]));

    var root = h("div");
    root.appendChild(head);

    var body = h("div.act-list");
    if (!entries.length) {
      body.appendChild(h("div.empty-state", [h("div", { text: t("activity.empty") })]));
    } else {
      entries.forEach(function (e) { body.appendChild(entryRow(e)); });
    }
    root.appendChild(body);

    container.appendChild(root);
  }

  var view = {
    id: "activity",
    path: "/activity",
    titleKey: "activity.title",
    icon: "◉",
    nav: true,
    adminOnly: true,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/activity") render(container); });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/activity", "activity");
})(window.PMS);