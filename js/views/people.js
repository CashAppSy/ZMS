/* ==========================================================================
   People & Departments view - people grid, department management,
   per-person tasks + workload.
   Route: /people
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var activeSection = "people";

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("people.title") }));
    var canWrite = PMS.auth ? PMS.auth.can("people.write") : true;
    if (canWrite) {
      var actions = h("div.actions");
      actions.appendChild(h("button.btn", { text: "+ " + t("people.addDepartment"), on: { click: function () { PMS.editors.openDepartmentEditor(null, function () { activeSection = "depts"; render(container); }); } } }));
      actions.appendChild(h("button.btn.btn-primary", { text: "+ " + t("people.addPerson"), on: { click: function () { PMS.editors.openPersonEditor(null, function () { activeSection = "people"; render(container); }); } } }));
      header.appendChild(actions);
    }
    container.appendChild(header);

    // Tabs
    var wrap = h("div");
    var tabs = h("div.tabs");
    var tabPeople = h("button.tab" + (activeSection === "people" ? ".active" : ""), { text: t("people.people"), on: { click: function () { show("people"); } } });
    var tabDepts = h("button.tab" + (activeSection === "depts" ? ".active" : ""), { text: t("people.departments"), on: { click: function () { show("depts"); } } });
    tabs.appendChild(tabPeople);
    tabs.appendChild(tabDepts);
    wrap.appendChild(tabs);

    var content = h("div", { style: { marginTop: "16px" } });
    wrap.appendChild(content);
    container.appendChild(wrap);

    function show(section) {
      activeSection = section;
      tabPeople.classList.toggle("active", section === "people");
      tabDepts.classList.toggle("active", section === "depts");
      PMS.dom.clear(content);
      if (section === "people") renderPeople(content);
      else renderDepts(content);
    }

    show(activeSection);
  }

  function renderPeople(container) {
    var people = PMS.repos.people.all();
    var search = h("input.input", { placeholder: t("search.placeholder"), on: { input: function (e) { redraw(e.target.value); } } });
    search.style.maxWidth = "260px";
    container.appendChild(search);

    var grid = h("div.grid-3");
    container.appendChild(grid);

    function redraw(q) {
      PMS.dom.clear(grid);
      q = (q || "").toLowerCase();
      people.forEach(function (p) {
        if (q && p.name.toLowerCase().indexOf(q) === -1 && (p.jobTitle || "").toLowerCase().indexOf(q) === -1 && (p.email || "").toLowerCase().indexOf(q) === -1 && (p.phone || "").indexOf(q) === -1) return;
        grid.appendChild(personCard(p));
      });
    }
    redraw("");
  }

  function personCard(person) {
    var card = h("div.card.person-card");
    card.style.cursor = "pointer";

    var top = h("div.pc-top");
    top.appendChild(PMS.vformat.avatar(person, "lg"));
    var names = h("div", { style: { minWidth: 0 } });
    names.appendChild(h("div.pc-name.u-ellipsis", { text: person.name }));
    names.appendChild(h("div.u-muted", { text: person.jobTitle || "—" }));
    top.appendChild(names);
    top.appendChild(h("span.badge" + (person.status === "inactive" ? "" : ""), {
      text: PMS.i18n.t("people." + (person.status || "active")),
      style: person.status === "inactive" ? { background: "var(--bg-subtle)", color: "var(--text-faint)" } : { background: "var(--success-soft)", color: "var(--success)" }
    }));
    card.appendChild(top);

    // The fields a person is identified by in the list: job title, department,
    // email and phone — so somebody added from any screen is fully readable.
    var dept = PMS.repos.departments.get(person.departmentId);
    if (dept || person.email || person.phone) {
      var meta = h("div.u-muted", { style: { fontSize: "0.78rem" } });
      if (dept) meta.appendChild(h("div", { text: "🏢 " + PMS.i18n.trilingual(dept.name)(dept.name) }));
      if (person.email) meta.appendChild(h("div", { text: "✉ " + person.email }));
      if (person.phone) meta.appendChild(h("div", { text: "☎ " + person.phone }));
      card.appendChild(meta);
    }

    // tasks summary
    var tasks = PMS.repos.tasks.all().filter(function (tsk) { return (tsk.assignees || []).indexOf(person.id) !== -1; });
    var doneKey = (PMS.store.data.taskStatuses || []).find(function (s) { return s.key === "done"; });
    var done = tasks.filter(function (tsk) { return tsk.status === (doneKey ? "done" : "done"); }).length;
    var open = tasks.length - done;
    var today = PMS.utils.todayISO();
    var late = tasks.filter(function (tsk) { return tsk.dueDate && tsk.dueDate < today && tsk.status !== (doneKey ? "done" : ""); }).length;
    var load = tasks.reduce(function (s, tsk) { return s + (Number(tsk.estimatedHours) || 0); }, 0);

    var row = h("div.u-flex", { style: { fontSize: "0.8rem", gap: "8px", marginTop: "6px" } });
    row.appendChild(h("span.chip", { text: t("people.openTasks") + " " + open }));
    row.appendChild(h("span.chip", { text: t("people.doneTasks") + " " + done }));
    if (late > 0) row.appendChild(h("span.chip", { text: late + " " + t("people.lateTasks"), style: { background: "var(--danger-soft)", color: "var(--danger)" } }));
    row.appendChild(h("span.chip", { text: t("people.loadInHours", { n: Math.round(load) }) }));
    card.appendChild(row);

    // actions
    var canWrite = PMS.auth ? PMS.auth.can("people.write") : true;
    var isAdmin = PMS.auth ? PMS.auth.isAdmin() : false;
    var acc = isAdmin ? personAccount(person) : null;
    if (canWrite) {
      var actions = h("div.u-flex", { style: { marginTop: "8px" } });
      actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function (e) { e.stopPropagation(); PMS.editors.openPersonEditor(person, function () { render(document.getElementById("view-root")); }); } } }));
      if (isAdmin) {
        if (acc) {
          actions.appendChild(h("span.chip", { text: "🔑 " + t("people.hasAccount"), style: acc.cloudUid ? { background: "var(--info-soft)", color: "var(--info)" } : { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
          actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("people.resetPasswordMail"), on: { click: function (e) { e.stopPropagation(); resetPersonPassword(person, acc); } } }));
        } else {
          actions.appendChild(h("span.chip", { text: t("people.noAccount"), style: { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
          actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("people.createAccount"), on: { click: function (e) { e.stopPropagation(); createPersonAccountDialog(person); } } }));
        }
      }
      if (person.status !== "inactive") {
        actions.appendChild(h("button.btn.btn-sm.btn-soft-danger", { text: t("common.archive"), on: { click: function (e) { e.stopPropagation(); archivePerson(person); } } }));
      } else {
        actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.restore"), on: { click: function (e) { e.stopPropagation(); PMS.repos.people.update(person.id, { status: "active" }); if (PMS.accounts && PMS.accounts.setActiveForPerson) PMS.accounts.setActiveForPerson(PMS.repos.people.get(person.id)); render(document.getElementById("view-root")); } } }));
      }
      card.appendChild(actions);
    }
    card.addEventListener("click", function () { openPersonDetail(person); });
    return card;
  }

  function personAccount(person) {
    if (!person || !PMS.auth || !PMS.auth.userByPersonId) return null;
    return PMS.auth.userByPersonId(person.id) || null;
  }

  function resetPersonPassword(person, acc) {
    var email = String(person.email || acc.username || "").trim().toLowerCase();
    if (acc.cloudUid && PMS.cloudsync && PMS.cloudsync.resetPassword) {
      PMS.modal.open({
        title: t("auth.resetPassword") + " — " + person.name,
        content: h("p", { text: t("auth.cloudResetConfirm", { email: email }) }),
        footer: [
          { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
          { label: t("auth.cloudReset"), class: "btn-primary", onClick: function () {
            PMS.cloudsync.resetPassword(email).then(function () {
              PMS.modal.close();
              PMS.toast.show(t("auth.cloudResetSent"), "success");
            });
          } }
        ]
      });
      return;
    }
    PMS.modal.open({
      title: t("auth.resetPassword") + " — " + person.name,
      content: function () {
        return PMS.forms.build([{ key: "pw", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true }]);
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("auth.resetPassword"), class: "btn-primary", onClick: function (_, body) {
          var form = body.querySelector("form");
          var v = form._getValues();
          var res = PMS.auth.resetPassword(acc.id, v.pw);
          if (res && res.error) { PMS.toast.show(t("auth.invalidCredentials"), "error"); return; }
          PMS.modal.close();
          PMS.toast.show(t("auth.passwordReset") + " ✓", "success");
        } }
      ]
    });
  }

  function createPersonAccountDialog(person) {
    if (!person.email) { PMS.toast.show(t("people.accountNeedsEmail"), "error"); return; }
    PMS.modal.open({
      title: t("people.createAccount"),
      content: h("p", { text: t("people.createAccountConfirm", { name: person.name, email: person.email }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("people.createAccount"), class: "btn-primary", onClick: function () {
          PMS.modal.close();
          if (PMS.accounts && PMS.accounts.createForPerson) PMS.accounts.createForPerson(person);
          else PMS.toast.show(t("auth.forbidden"), "error");
          render(document.getElementById("view-root"));
        } }
      ]
    });
  }

  function archivePerson(person) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deletePerson", { name: person.name }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.archive"), class: "btn-danger", onClick: function () {
          PMS.repos.people.archive(person.id);
          if (PMS.accounts && PMS.accounts.setActiveForPerson) PMS.accounts.setActiveForPerson(PMS.repos.people.get(person.id));
          PMS.modal.close();
          PMS.toast.show(t("common.archive") + " ✓", "success");
          render(document.getElementById("view-root"));
        } }
      ]
    });
  }

  function openPersonDetail(person) {
    PMS.modal.open({
      title: person.name,
      size: "lg",
      content: function () {
        var tasks = PMS.repos.tasks.all().filter(function (tsk) { return (tsk.assignees || []).indexOf(person.id) !== -1; });
        var wrap = h("div.stack");
        var dept = PMS.repos.departments.get(person.departmentId);
        var meta = h("div.detail-list");
        meta.appendChild(dl(t("people.jobTitle"), person.jobTitle || "—"));
        meta.appendChild(dl(t("people.department"), dept ? PMS.i18n.trilingual(dept.name)(dept.name) : "—"));
        meta.appendChild(dl(t("people.email"), person.email || "—"));
        meta.appendChild(dl(t("people.phone"), person.phone || "—"));
        if (person.notes) meta.appendChild(dl(t("people.notes"), person.notes));
        wrap.appendChild(meta);

        wrap.appendChild(h("div.section-title", [txt(t("people.tasksCount", { n: tasks.length }))]));
        var list = h("div.stack");
        tasks.slice(0, 15).forEach(function (tsk) {
          var row = h("div.project-tree-row");
          row.style.cursor = "pointer";
          row.appendChild(h("span", { text: tsk.status === "done" ? "✓" : "○" }));
          var proj = PMS.repos.projects.get(tsk.projectId);
          row.appendChild(h("span.u-grow.u-ellipsis", { text: tsk.title + (proj ? " · " + proj.name : "") }));
          row.appendChild(PMS.vformat.statusBadge(tsk.status, "task"));
          row.appendChild(PMS.vformat.priorityBadge(tsk.priority));
          list.appendChild(row);
        });
        wrap.appendChild(list);
        if (PMS.auth ? PMS.auth.can("people.write") : true) {
          var openBtn = h("button.btn.btn-sm", { text: t("common.edit"), on: { click: function () { PMS.modal.close(); PMS.editors.openPersonEditor(person, function () {}); } } });
          wrap.appendChild(openBtn);
        }
        return wrap;
      },
      footer: [{ label: t("common.close"), onClick: function () { PMS.modal.close(); } }]
    });
  }

  function renderDepts(container) {
    var depts = PMS.repos.departments.all();
    if (!depts.length) {
      container.appendChild(h("div.empty-state", [h("div", { text: t("people.departments") + " — " + t("common.noResults") })]));
      return;
    }
    depts.forEach(function (dept) {
      var people = PMS.repos.people.all().filter(function (p) { return p.departmentId === dept.id; });
      var card = h("div.card", { style: { marginBlockEnd: "12px" } });
      var head = h("div.card-header");
      head.appendChild(h("span.badge-dot", { style: { background: dept.color || "#2563eb", width: "12px", height: "12px", borderRadius: "3px" } }));
      head.appendChild(h("div.u-grow", {}, [
        h("div.card-title", { text: PMS.i18n.trilingual(dept.name)(dept.name) }),
        h("div.u-muted", { text: personSummary(people) })
      ]));
      if (PMS.auth ? PMS.auth.can("people.write") : true) {
        head.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function () { PMS.editors.openDepartmentEditor(dept, function () { render(document.getElementById("view-root")); }); } } }));
        head.appendChild(h("button.btn.btn-sm.btn-soft-danger", { text: t("common.delete"), on: { click: function () { deleteDept(dept); } } }));
      }
      card.appendChild(head);
      if (people.length) {
        var body = h("div.card-body");
        people.forEach(function (p) { body.appendChild(h("div.u-flex", [PMS.vformat.avatar(p), h("span.u-grow", { text: p.name })])); });
        card.appendChild(body);
      }
      container.appendChild(card);
    });
  }

  function personSummary(people) {
    var active = people.filter(function (p) { return p.status !== "inactive"; }).length;
    return t("dashboard.nMembers", { n: active }) + " / " + people.length;
  }

  function deleteDept(dept) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deleteDept", { name: PMS.i18n.trilingual(dept.name)(dept.name) }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.delete"), class: "btn-danger", onClick: function () { PMS.repos.departments.remove(dept.id); PMS.modal.close(); render(document.getElementById("view-root")); } }
      ]
    });
  }

  function dl(label, value) {
    var d = h("div.detail-item");
    d.appendChild(h("div.dl-label", { text: label }));
    d.appendChild(h("div.dl-value", { text: value || "—" }));
    return d;
  }
  function txt(s) { return s; }

  var view = {
    id: "people",
    path: "/people",
    titleKey: "nav.people",
    icon: "👥",
    nav: true,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/people") render(container); });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/people", "people");
})(window.PMS);