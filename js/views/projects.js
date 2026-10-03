/* ==========================================================================
   Projects view - collapsible tree of projects + project detail page.
   Routes: "/projects", "/projects/:id"
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };
  // scoped: progress percentages must not count work the reader may not see
  var data = function () { return PMS.repos.scopedData(); };

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
    // The chip is a shortcut into the person editor, so it is only clickable
    // for someone allowed to edit that person: otherwise a plain click on a
    // name would answer with a "forbidden" toast.
    var canEditOwner = owner && (!PMS.auth || !PMS.auth.canEditPerson || PMS.auth.canEditPerson(owner));
    if (canEditOwner) wrap.style.cursor = "pointer";
    if (canEditOwner) {
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

    // Program level: the tool itself is the program, so its progress is the
    // weight-normalized roll-up of every pillar (spec 2).
    var PP0 = PMS.programProgress;
    container.appendChild(h("div.card", { style: { marginBlockEnd: "14px" } }, [h("div.card-body", [
      h("div.detail-list", [
        metaItem(t("common.progress"), PMS.utils.pct(PP0.programProgress(data()))),
        metaItem(t("projects.totalRawWeight"), String(Math.round(PP0.totalRawWeight(data())))),
        metaItem(t("projects.pillarCount"), String((data().projects || []).length))
      ])
    ])]));

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
    // Deletion is narrower than write access: an admin always, and a manager
    // only for a pillar they created themselves.
    var canDeletePillar = PMS.auth ? PMS.auth.canDeleteRecord(proj) : true;
    if (canEdit) {
      actions.appendChild(h("button.btn", { text: t("common.edit"), on: { click: function () { PMS.editors.openProjectEditor(proj, { onSaved: function () {} }); } } }));
    }
    if (canDeletePillar) {
      actions.appendChild(h("button.btn.btn-soft-danger", {
        text: t("common.delete"),
        on: { click: function () { deleteProject(proj); } }
      }));
    } else if (PMS.auth && PMS.auth.deleteBlockedHint) {
      // no delete for a pillar the manager did not create: say so, otherwise
      // the missing button looks like a bug
      actions.appendChild(h("span.u-muted", {
        text: PMS.auth.deleteBlockedHint(proj),
        style: { fontSize: "0.78rem", maxWidth: "320px" }
      }));
    }
    if (canEdit) {
      actions.appendChild(h("button.btn", { text: t("projects.addSubProject"), on: { click: function () { PMS.editors.openProjectEditor(null, { defaults: { parentId: proj.id }, onSaved: function () {} }); } } }));
    }
    // Pillar closure is a scope decision, so it is narrower than edit access:
    // an admin, or the manager who owns this pillar, and nobody else (spec 22).
    var canMarkCompleted = ownsPillar(proj);
    if (canMarkCompleted && proj.status !== "completed") {
      actions.appendChild(h("button.btn", { text: t("projects.markAsCompleted"), on: { click: function () { markCompleted(proj, allData); } } }));
    }
    header.appendChild(actions);
    container.appendChild(header);

// hero: progress + meta
    var hero = h("div.project-hero");
    var main = h("div.ph-main.card");
    var PP = PMS.programProgress;
    var scope = PP.pillarScope(allData, proj.id);
    main.appendChild(h("div.card-body", [
      h("div.detail-list", [
        metaItem(t("projects.progress"), PMS.utils.pct(prog)),
        metaItem(t("projects.rawWeight"), String(scope.plannedTasks >= 0 ? PP.pillarRawWeight(proj) : 1)),
        metaItem(t("projects.programShare"), PMS.utils.pct(PP.normalizedWeight(allData, proj.id))),
        metaItem(t("projects.plannedCount"), String(scope.plannedTasks)),
        metaItem(t("projects.actualTasks"), String(scope.actualTasks)),
        metaItem(t("projects.completedTasks"), String(scope.completedTasks)),
        metaItem(t("projects.remainingTasks"), String(scope.remainingTasks)),
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

    // Scope closure: never hidden. While planned scope is still open the user
    // sees exactly what closing would write off (spec 24 / 25).
    if (proj.status === "completed" && proj.closureSnapshot) {
      container.appendChild(h("div.card", [h("div.card-body", [
        h("div.section-title", [labelSpan(t("projects.closureInfo"))]),
        h("div.detail-list", [
          metaItem(t("projects.plannedCount"), String(proj.closureSnapshot.plannedTasks)),
          metaItem(t("projects.actualTasks"), String(proj.closureSnapshot.actualTasks)),
          metaItem(t("projects.completedTasks"), String(proj.closureSnapshot.completedTasks)),
          metaItem(t("projects.remainingTasks"), String(proj.closureSnapshot.remainingTasks)),
          metaItem(t("projects.unusedScope"), String(proj.closureSnapshot.unusedPlannedCapacity)),
          metaItem(t("projects.closedAt"), PMS.utils.formatDate(proj.closedAt, PMS.i18n)),
          metaItem(t("projects.closedBy"), proj.closedBy || "—")
        ]),
        proj.closureNote ? h("p.u-muted", { text: proj.closureNote }) : null
      ])]));
    } else if (scope.remainingTasks > 0) {
      container.appendChild(h("div.card", [h("div.card-body", [
        h("p.u-muted", {
          text: t("projects.scopeOpenHint", {
            actual: scope.actualTasks,
            planned: scope.plannedTasks,
            done: scope.completedTasks,
            remaining: scope.remainingTasks
          })
        })
      ])]));
    }

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
      row.appendChild(h("span.u-muted", {
        text: t("projects.rawWeight") + " " + PMS.programProgress.pillarRawWeight(p) +
              " · " + t("projects.programShare") + " " + PMS.utils.pct(PMS.programProgress.normalizedWeight(PMS.store.data, p.id)),
        style: { fontSize: "0.75rem" }
      }));
      row.appendChild(PMS.vformat.statusBadge(p.status, "project"));
      var track = h("div.progress-track", { style: { width: "90px", height: "6px" } },
        [h("div.progress-fill", { style: { width: Math.round(prog) + "%" } })]);
      row.appendChild(track);
      row.appendChild(h("span.progress-label", { text: PMS.utils.pct(prog) }));
      return row;
    });
  }

  // Program > Pillar > Task > Sub-task: clicking a pillar lists its tasks with
  // their sub-tasks nested underneath, each carrying its weight and progress.
  function taskRows(tasks) {
    var PP = PMS.programProgress;
    var data = PMS.store.data;
    var out = [];
    tasks.filter(function (tsk) { return !tsk.parentTaskId; }).forEach(function (tsk) {
      var row = h("div.project-tree-row");
      row.style.cursor = "pointer";
      row.addEventListener("click", function () { PMS.router.navigate("/tasks?highlight=" + tsk.id); });
      row.appendChild(h("span", { text: "☑" }));
      row.appendChild(h("span.u-grow.u-ellipsis", { text: tsk.title }));
      row.appendChild(h("span.u-muted", {
        text: t("projects.taskWeight") + " " + PP.taskWeight(data, tsk),
        style: { fontSize: "0.75rem" }
      }));
      row.appendChild(PMS.vformat.statusBadge(tsk.status, "task"));
      row.appendChild(h("span.progress-label", { text: PMS.utils.pct(PP.taskProgress(data, tsk)) }));
      row.appendChild(PMS.vformat.priorityBadge(tsk.priority));
      out.push(row);

      PP.subtasksOf(data, tsk.id).forEach(function (sub) {
        var done = sub.status === "done" || Number(sub.progress) >= 100;
        var subRow = h("div.project-tree-row", { style: { paddingLeft: "28px" } });
        subRow.appendChild(h("span", { text: done ? "☑" : "☐" }));
        subRow.appendChild(h("span.u-grow.u-ellipsis.u-muted", { text: sub.title }));
        subRow.appendChild(PMS.vformat.statusBadge(sub.status, "task"));
        out.push(subRow);
      });
    });
    return out;
  }

  // Pillar closure is a scope decision, not a status flip: it asks WHY the
  // unused planned scope is being written off, and keeps that reason (spec 15/16).
  // Authorization is re-checked here so the action cannot be reached by
  // calling the handler directly.
  function ownsPillar(proj) {
    if (!PMS.auth) return true;
    if (PMS.auth.isAdmin && PMS.auth.isAdmin()) return true;
    var u = PMS.auth.currentUser ? PMS.auth.currentUser() : null;
    if (!u) return false;
    return !!(proj.managerId && (proj.managerId === u.personId || proj.managerId === u.id));
  }

  function markCompleted(proj, allData) {
    if (!ownsPillar(proj)) {
      PMS.toast.show(t("projects.closureNotAllowed"), "error");
      return;
    }
    var PP = PMS.programProgress;
    var scope = PP.pillarScope(allData, proj.id);
    var remaining = scope.remainingTasks;

    function doIt(note) {
      var res = PP.closePillar(allData, proj.id, note, PMS.auth && PMS.auth.currentUser ? PMS.auth.currentUser() : null);
      if (!res.ok) return;
      PMS.repos.projects.update(proj.id, {
        status: "completed",
        progress: 100,
        closedAt: res.pillar.closedAt,
        closedBy: res.pillar.closedBy,
        closureNote: res.pillar.closureNote,
        closureSnapshot: res.pillar.closureSnapshot
      });
      PMS.modal.close();
      PMS.toast.show(t("projects.closedScopeClosed", { n: remaining, tasks: remaining === 1 ? t("projects.tasksSingular") : t("projects.tasksPlural") }), "success");
    }

    var noteInput = null;
    var errLine = h("p.form-error", { text: "", style: { display: "none" } });
    var body = h("div", [
      h("p", {
        text: t("projects.markCompletedConfirm", {
          n: remaining,
          planned: scope.plannedTasks,
          tasks: remaining === 1 ? t("projects.tasksSingular") : t("projects.tasksPlural")
        })
      }),
      h("div.detail-list", [
        metaItem(t("projects.plannedCount"), String(scope.plannedTasks)),
        metaItem(t("projects.actualTasks"), String(scope.actualTasks)),
        metaItem(t("projects.completedTasks"), String(scope.completedTasks)),
        metaItem(t("projects.remainingTasks"), String(scope.remainingTasks))
      ]),
      h("label.field", [
        h("span", { text: t("projects.closureNote") }),
        noteInput = h("textarea", { rows: "3", placeholder: t("projects.closureNoteHint") })
      ]),
      errLine
    ]);

    PMS.modal.open({
      title: t("projects.markCompletedTitle"),
      content: body,
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.confirm"),
          class: "btn-primary",
          onClick: function () {
            var check = PP.validateClosureNote(noteInput.value);
            if (!check.ok) {
              errLine.textContent = check.reason === "required"
                ? t("projects.closureNoteRequired")
                : t("projects.closureNoteTooShort", { min: check.min });
              errLine.style.display = "";
              return;
            }
            doIt(check.note);
          }
        }
      ]
    });
  }

  function deleteProject(proj) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete(proj)) return;
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