/* ==========================================================================
   Projects view - collapsible tree of projects + project detail page.
   Routes: "/projects", "/projects/:id"
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };
  var data = function () { return PMS.store.data; };

  function buildTree(progressMap) {
    var projs = data().projects || [];
    var pctOf = function (p) {
      var v = progressMap && progressMap[p.id] !== undefined ? progressMap[p.id] : 0;
      return typeof v === "number" && !isNaN(v) ? v : 0;
    };
    // Sorts pillars by progress (highest first) so parents and sub-pillars are
    // always listed in the same, automatic order. Ties fall back to the name.
    function byProgressDesc(a, b) {
      var d = pctOf(b) - pctOf(a);
      if (d) return d;
      return String(a.name || "").localeCompare(String(b.name || ""));
    }

    var childrenMap = {};
    projs.filter(function (p) { return p.parentId; }).forEach(function (p) {
      (childrenMap[p.parentId] = childrenMap[p.parentId] || []).push(p);
    });
    var roots = projs.filter(function (p) { return !p.parentId; }).sort(byProgressDesc);
    function node(p) {
      return {
        id: p.id,
        children: (childrenMap[p.id] || []).slice().sort(byProgressDesc).map(node),
        collapsed: false,
        raw: p,
        render: function (n) {
          var prog = progressMap && progressMap[n.raw.id] !== undefined ? progressMap[n.raw.id] : 0;
          var wrap = h("div.project-tree-item");
          var head = h("div.pillar-row-head");
          head.appendChild(h("span.u-ellipsis.u-bold", { text: n.raw.name }));
          var color = statusColorOf(n.raw.status);
          head.appendChild(h("span.badge", {
            text: t("projects.progress") + " " + PMS.utils.pct(prog),
            style: { background: PMS.vformat.hexToSoft(color), color: color }
          }));
          wrap.appendChild(head);

          // progress bar
          var track = h("div.progress-track", { style: { width: "100%", height: "8px" } },
            [h("div.progress-fill", { style: { width: Math.round(prog) + "%" } })]);
          wrap.appendChild(track);

          // meta line: status, owner, dates, task count
          var meta = h("div.pillar-row-meta");
          meta.appendChild(PMS.vformat.statusBadge(n.raw.status, "project"));
          meta.appendChild(PMS.vformat.priorityBadge(n.raw.priority));
          meta.appendChild(ownerChip(n.raw.managerId));
          var taskCount = PMS.repos.tasks.forProject(n.raw.id).length;
          if (taskCount) meta.appendChild(h("span.chip", { text: "☑ " + taskCount }));
          if (n.raw.endDate) {
            meta.appendChild(h("span.chip", {
              text: "📅 " + PMS.utils.formatDate(n.raw.endDate, PMS.i18n)
            }));
          }
          wrap.appendChild(meta);

          if (PMS.auth ? PMS.auth.canEditProject(n.raw) : true) {
            var editBtn = h("button.btn.btn-sm.btn-icon.btn-ghost", {
              text: "✎",
              attrs: { title: t("common.edit") },
              on: { click: function (e) { e.stopPropagation(); PMS.editors.openProjectEditor(n.raw, { onSaved: function () {} }); } }
            });
            wrap.appendChild(editBtn);
          }
          return wrap;
        }
      };
    }
    return roots.map(node);
  }

  // Owner name next to every pillar (falls back to a muted dash when unset).
  function ownerChip(managerId) {
    var owner = managerId ? PMS.repos.people.get(managerId) : null;
    var wrap = h("span.chip.chip-owner", { attrs: { title: t("projects.owner") } });
    wrap.appendChild(h("span", { text: "👤 " + t("projects.owner") + ": " + (owner ? owner.name : t("common.none")) }));
    if (owner) wrap.style.cursor = "pointer";
    if (owner) {
      wrap.addEventListener("click", function (e) {
        e.stopPropagation();
        PMS.editors.openPersonEditor(owner, function () {});
      });
    }
    return wrap;
  }

  function renderList(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("projects.title") }));
    var actions = h("div.actions");
    actions.appendChild(h("button.btn", { text: t("projects.collapseAll"), on: { click: function () { toggleAll(true); } } }));
    actions.appendChild(h("button.btn", { text: t("projects.expandAll"), on: { click: function () { toggleAll(false); } } }));
    if (PMS.auth ? PMS.auth.can("projects.write") : true) {
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("projects.newProject"), on: { click: function () { PMS.editors.openProjectEditor(null, { onSaved: function () {} }); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    // Pillars are always listed highest progress first, so the pillars that
    // need attention float to the top without the user re-sorting anything.
    var progressMap = PMS.progress.allProjectProgress(data());
    var treed = PMS.treeService.Tree;
    var listEl = h("div.pillar-grid");
    var tree = new treed({
      nodes: buildTree(progressMap),
      onNodeClick: function (node) { PMS.router.navigate("/projects/" + (node.raw ? node.raw.id : node.id)); }
    });
    listEl.appendChild(tree.el);
    container.appendChild(listEl);
    container.appendChild(h("div.u-muted", {
      text: t("projects.sortedByProgress"),
      style: { fontSize: "0.78rem", marginBlockStart: "10px" }
    }));

    // empty state
    if (!(data().projects || []).length) {
      container.appendChild(h("div.empty-state", [
        h("div.empty-icon", { text: "🗂" }),
        h("div", { text: t("projects.title") + " — " + t("common.noResults") })
      ]));
    }
  }

  function toggleAll(expanded) {
    document.querySelectorAll(".tree-node").forEach(function (n) {
      if (expanded) n.classList.remove("collapsed");
      else n.classList.add("collapsed");
    });
  }

  function statusColorOf(key) {
    var s = (data().projectStatuses || []).find(function (x) { return x.key === key; });
    return s ? s.color : "#64748b";
  }

  function renderDetail(container, id) {
    var proj = PMS.repos.projects.get(id);
    container.innerHTML = "";
    if (!proj) {
      container.appendChild(h("div.empty-state", [h("div", { text: t("errors.notFound") }), h("button.btn.btn-primary", { text: t("common.back"), on: { click: function () { PMS.router.navigate("/projects"); } } })]));
      return;
    }

    var allData = data();
    var progress = PMS.progress.projectProgress(allData, id, 0);
    var prog = progress;
    var children = PMS.repos.projects.children(id);
    var tasks = PMS.repos.tasks.forProject(id);
    var membersList = (proj.memberIds || []).map(function (mid) { return PMS.repos.people.get(mid); }).filter(Boolean);

    // header
    var header = h("div.page-header");
    header.appendChild(h("button.btn.btn-icon", { text: "←", on: { click: function () { PMS.router.navigate("/projects"); }, attrs: { "aria-label": t("common.back") } } }));
    header.appendChild(h("h1", { text: proj.name }));
    if (proj.parentId) {
      var parent = PMS.repos.projects.get(proj.parentId);
      if (parent) header.appendChild(h("span.badge", { text: "↑ " + parent.name }));
    }
    header.appendChild(PMS.vformat.statusBadge(proj.status, "project"));
    header.appendChild(PMS.vformat.priorityBadge(proj.priority));
    var actions = h("div.actions");
    var isAdminWrite = PMS.auth ? PMS.auth.can("projects.write") : true;
    var canEdit = PMS.auth ? PMS.auth.canEditProject(proj) : true;
    var canDetailWrite = canEdit || isAdminWrite;
    if (canEdit) {
      actions.appendChild(h("button.btn", { text: t("common.edit"), on: { click: function () { PMS.editors.openProjectEditor(proj, { onSaved: function () {} }); } } }));
    }
    if (isAdminWrite) {
      actions.appendChild(h("button.btn.btn-soft-danger", {
        text: t("common.delete"),
        on: { click: function () { deleteProject(proj); } }
      }));
    }
    if (canEdit) {
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("projects.addSubProject"), on: { click: function () { PMS.editors.openProjectEditor(null, { defaults: { parentId: proj.id }, onSaved: function () {} }); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    // hero: progress + meta
    var hero = h("div.project-hero");
    var main = h("div.ph-main.card");
    main.appendChild(h("div.card-body", [
      h("div.detail-list", [
        metaItem(t("projects.progress"), PMS.utils.pct(prog)),
        metaItem(t("projects.startDate"), PMS.utils.formatDate(proj.startDate, PMS.i18n)),
        metaItem(t("projects.endDate"), PMS.utils.formatDate(proj.endDate, PMS.i18n)),
        metaItem(t("projects.budget"), PMS.utils.money(proj.budget, (data().settings && data().settings.currency), PMS.i18n)),
        metaItem(t("projects.manager"), proj.managerId ? (PMS.repos.people.get(proj.managerId) || {}).name || "—" : "—"),
        metaItem(t("projects.members"), String((proj.memberIds || []).length))
      ]),
      h("div.section-title", [labelSpan(t("projects.progress"))]),
      PMS.vformat.progressChip(prog)
    ]));
    hero.appendChild(main);
    container.appendChild(hero);

    if (proj.description) container.appendChild(h("div.card", [h("div.card-body", [h("p", { text: proj.description })])]));

    if (proj.tags && proj.tags.length) {
      container.appendChild(h("div.section-title", [labelSpan(t("common.tags"))]));
      container.appendChild(h("div.u-flex", PMS.vformat.tagsChips(proj.tags)));
    }

    // sub projects
    if (children.length) {
      container.appendChild(h("div.section-title", [labelSpan(t("projects.subProjects"))]));
      var subs = h("div.card", [h("div.card-body", childRows(children))]);
      container.appendChild(subs);
    } else {
      container.appendChild(h("div.section-title", [labelSpan(t("projects.noSubProjects"))]));
    }

    // tasks
    container.appendChild(h("div.section-title", [labelSpan(t("projects.childTasks"))]));
    var taskWrap = h("div.card");
    taskWrap.appendChild(h("div.card-header", [h("div.card-title", { text: t("projects.tasks") + " (" + tasks.length + ")" })]));
    var taskBody = tasks.length
      ? taskRows(tasks)
      : [h("div.empty-state", [
        h("div", { text: t("projects.noTasks") })
      ])];
    if (tasks.length || PMS.auth ? (PMS.auth.can("tasks.write") || PMS.auth.canCreateTask(proj.id)) : true) {
      taskBody.push(h("button.btn.btn-primary", {
        text: "+ " + t("tasks.newTask"),
        on: { click: function () { PMS.editors.openTaskEditor(null, { defaults: { projectId: proj.id }, onSaved: function () {} }); } }
      }));
    }
    taskWrap.appendChild(h("div.card-body", taskBody));
    container.appendChild(taskWrap);

    // custom fields display
    var cfs = PMS.repos.fields.forEntity("project");
    if (cfs.length) {
      container.appendChild(h("div.section-title", [labelSpan(t("projects.customFields"))]));
      var cfWrap = h("div.card", [h("div.card-body.detail-list", cfs.map(function (f) {
        var val = (proj.customFields || {})[f.id];
        if (val === undefined || val === null || val === "") return null;
        var text = Array.isArray(val) ? val.join(", ") : (typeof val === "boolean" ? (val ? "✓" : "") : String(val));
        return metaItem(PMS.i18n.trilingual(f.label)(f.label), text);
      }).filter(Boolean))]);
      container.appendChild(cfWrap);
    }
  }

  function metaItem(label, value) {
    var d = h("div.detail-item");
    d.appendChild(h("div.dl-label", { text: label }));
    d.appendChild(h("div.dl-value", { text: value || "—" }));
    return d;
  }

  function labelSpan(s) { return s; }

  function childRows(children) {
    return children.map(function (p) {
      var prog = PMS.progress.projectProgress(data(), p.id, 0);
      var row = h("div.project-tree-row");
      row.style.cursor = "pointer";
      row.addEventListener("click", function () { PMS.router.navigate("/projects/" + p.id); });
      row.appendChild(h("span", { text: "🗀" }));
      row.appendChild(h("span.u-grow.u-ellipsis.u-bold", { text: p.name }));
      row.appendChild(PMS.vformat.statusBadge(p.status, "project"));
      var track = h("div.progress-track", { style: { width: "90px", height: "6px" } },
        [h("div.progress-fill", { style: { width: Math.round(prog) + "%" } })]);
      row.appendChild(track);
      row.appendChild(h("span.progress-label", { text: PMS.utils.pct(prog) }));
      return row;
    });
  }

  function taskRows(tasks) {
    return tasks.filter(function (tsk) { return !tsk.parentTaskId; }).map(function (tsk) {
      var row = h("div.project-tree-row");
      row.style.cursor = "pointer";
      row.addEventListener("click", function () { PMS.router.navigate("/tasks?highlight=" + tsk.id); });
      row.appendChild(h("span", { text: "☑" }));
      row.appendChild(h("span.u-grow.u-ellipsis", { text: tsk.title }));
      row.appendChild(PMS.vformat.statusBadge(tsk.status, "task"));
      row.appendChild(PMS.vformat.priorityBadge(tsk.priority));
      return row;
    });
  }

  function deleteProject(proj) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deleteProject", { name: proj.name }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.delete"), class: "btn-danger", onClick: function () { PMS.repos.projects.remove(proj.id); PMS.modal.close(); PMS.toast.show(t("common.delete") + " ✓", "success"); PMS.router.navigate("/projects"); } }
      ]
    });
  }

  var view = {
    id: "projects",
    path: "/projects",
    titleKey: "nav.projects",
    icon: "🗀",
    nav: true,
    render: function (container, params) {
      PMS.router.register("/projects", "projects");
      if (params.id) renderDetail(container, params.id);
      else renderList(container);
      var off = PMS.bus.on("store:changed", function () {
        var cur = PMS.router.current;
        if (cur.indexOf("/projects") === 0) {
          if (params.id) renderDetail(container, params.id);
          else renderList(container);
        }
      });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/projects", "projects");
  PMS.router.register("/projects/:id", "projects");
})(window.PMS);