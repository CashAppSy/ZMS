/* A scoped conflict inbox available to every cloud user, including roles that
   cannot open administrative settings. All values render as text. */
(function (PMS) {
  "use strict";
  var h = PMS.dom.h;
  function t(key) { return PMS.i18n.t(key); }
  function valueText(field, value) {
    if (value === undefined || value === null) return "—";
    if (field === "dependencies") return PMS.dependencies.normList(value).map(function (dep) {
      var task = PMS.repos.tasks.get(dep.id);
      return (task ? task.title : t("deps.missingTask")) + " — " + dep.type + " (" + dep.lag + " " + t("deps.lagDays") + ")";
    }).join(", ") || t("deps.none");
    if (field === "assignees") return (value || []).map(function (id) {
      var person = PMS.repos.people.get(id); return person ? person.name : "—";
    }).join(", ") || "—";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  function render(container, onResolved) {
    var labels = { title: "tasks.title", name: "common.name", description: "common.description",
      dependencies: "deps.title", assignees: "tasks.assignees", startDate: "tasks.startDate",
      dueDate: "tasks.dueDate", status: "common.status", plannedSubtasks: "projects.plannedSubtasks" };
    var pending = PMS.cloudsync.conflicts();
    pending.forEach(function (conflict) {
      var box = h("div.card.sync-conflict-card");
      var rec = conflict.local || conflict.remote || {};
      box.appendChild(h("strong", { text: t("cloud.conflictTitle") + ": " + (rec.title || rec.name || t("common.name")) }));
      box.appendChild(h("p", { text: t("cloud.conflictHint") }));
      conflict.fields.forEach(function (field) {
        box.appendChild(h("p.sync-conflict-value", { text: (labels[field] ? t(labels[field]) : field) + ": "
          + t("cloud.localVersion") + " " + valueText(field, (conflict.local || {})[field])
          + " / " + t("cloud.remoteVersion") + " " + valueText(field, (conflict.remote || {})[field]) }));
      });
      if (!conflict.local) box.appendChild(h("p", { text: t("cloud.localDeleted") }));
      if (!conflict.remote) box.appendChild(h("p", { text: t("cloud.remoteDeleted") }));
      var actions = h("div.u-flex", { style: { gap: "8px", flexWrap: "wrap" } });
      [true, false].forEach(function (keepLocal) {
        actions.appendChild(h("button.btn", { text: t(keepLocal ? "cloud.keepLocal" : "cloud.useRemote"),
          on: { click: function () {
            if (PMS.cloudsync.resolveConflict(conflict.key, keepLocal)) onResolved();
          } } }));
      });
      box.appendChild(actions); container.appendChild(box);
    });
    if (!pending.length) container.appendChild(h("p", { text: t("cloud.noConflicts") }));
  }
  function open() {
    PMS.modal.open({title:t("cloud.conflictAction"),size:"lg",content:function () {
      var container = h("div.stack");
      render(container, function () { if (PMS.cloudsync.conflicts().length) open(); else PMS.modal.close(); });
      return container;
    },footer:[{label:t("common.cancel"),onClick:function () { PMS.modal.close(); }}]});
  }
  var timer = null, presented = {};
  function showPending() {
    timer = null;
    var pending = PMS.cloudsync.conflicts();
    var unseen = pending.filter(function (conflict) {
      return presented[conflict.key] !== JSON.stringify([conflict.local, conflict.remote]);
    });
    if (!unseen.length) return;
    // Keep the current editor and its unsaved input intact. Present the
    // conflict after it closes, once per distinct pair of conflicting versions.
    if (PMS.modal.isOpen) { timer = setTimeout(showPending, 250); return; }
    unseen.forEach(function (conflict) { presented[conflict.key] = JSON.stringify([conflict.local, conflict.remote]); });
    open();
  }
  PMS.bus.on("cloud:conflict", function (event) {
    if (event && event.resolved) return;
    if (!timer) timer = setTimeout(showPending, 0);
  });
  PMS.syncConflicts = {render:render,open:open};
})(window.PMS);
