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
  var activeDept = "all";

  // A department is a name (possibly bilingual) plus a colour. Reading it is
  // needed on almost every card, so it is resolved in one place.
  function deptName(dept) {
    if (!dept) return "";
    if (typeof dept.name === "string") return dept.name;
    return PMS.i18n.trilingual(dept.name)(dept.name);
  }
  function deptOf(person) {
    return person && person.departmentId ? PMS.repos.departments.get(person.departmentId) : null;
  }

  // A clickable phone/email line: dialing and writing must be one tap.
  function contactLink(icon, value, href) {
    if (!value) return null;
    var a = h("a.contact-line", { text: icon + " " + value, attrs: { href: href } });
    a.addEventListener("click", function (e) { e.stopPropagation(); });
    return a;
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("people.title") }));
    var canWrite = PMS.auth ? PMS.auth.can("people.write") : true;
    // Sections are read-only for a manager: they can see how work is grouped
    // and pick people from them, but only the admin restructures the org.
    var isAdmin = PMS.auth ? PMS.auth.isAdmin() : true;
    ensureDirectory();
    if (canWrite) {
      var actions = h("div.actions");
      if (isAdmin) actions.appendChild(h("button.btn", { text: "+ " + t("people.addDepartment"), on: { click: function () { PMS.editors.openDepartmentEditor(null, function () { activeSection = "depts"; render(container); }); } } }));
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
    var depts = PMS.repos.departments.all();

    var bar = h("div.people-toolbar");
    var search = h("input.input.search-inline", {
      placeholder: t("search.placeholder"),
      on: { input: function (e) { redraw(e.target.value, activeDept); } }
    });
    bar.appendChild(search);

    // Sections: everyone, or one department at a time. A person with no
    // department gets its own group instead of disappearing from the list.
    var unassigned = people.filter(function (p) { return !deptOf(p); }).length;
    var chips = h("div.people-filters");
    chips.appendChild(filterChip("all", t("people.allSections") + " (" + people.length + ")", function () { activeDept = "all"; }));
    depts.forEach(function (d) {
      var n = people.filter(function (p) { return p.departmentId === d.id; }).length;
      chips.appendChild(filterChip(d.id, deptName(d) + " (" + n + ")", function () { activeDept = d.id; }, d.color));
    });
    if (unassigned) chips.appendChild(filterChip("none", t("people.noDepartment") + " (" + unassigned + ")", function () { activeDept = "none"; }));
    bar.appendChild(chips);
    container.appendChild(bar);

    var grid = h("div.grid-3");
    container.appendChild(grid);

    function filterChip(id, label, onClick, color) {
      var chip = h("button.chip.filter-chip" + (activeDept === id ? ".is-active" : ""), { text: label, type: "button" });
      if (color) chip.style.borderInlineStartColor = color;
      chip.addEventListener("click", function () {
        activeDept = id;
        chips.querySelectorAll(".filter-chip").forEach(function (c) { c.classList.remove("is-active"); });
        chip.classList.add("is-active");
        redraw(search.value, activeDept);
      });
      return chip;
    }

    function matches(p, q) {
      if (!q) return true;
      if (p.name.toLowerCase().indexOf(q) !== -1) return true;
      if ((p.jobTitle || "").toLowerCase().indexOf(q) !== -1) return true;
      if ((p.email || "").toLowerCase().indexOf(q) !== -1) return true;
      if ((p.phone || "").indexOf(q) !== -1) return true;
      if (deptName(deptOf(p)).toLowerCase().indexOf(q) !== -1) return true;
      return false;
    }

    function redraw(q, deptId) {
      PMS.dom.clear(grid);
      q = (q || "").toLowerCase().trim();
      var rows = people.filter(function (p) {
        if (deptId === "all") return true;
        if (deptId === "none") return !deptOf(p);
        return p.departmentId === deptId;
      }).filter(function (p) { return matches(p, q); });
      if (!rows.length) {
        grid.appendChild(h("div.empty-state", [h("div", { text: t("common.noResults") })]));
        return;
      }
      rows.forEach(function (p) { grid.appendChild(personCard(p)); });
    }
    redraw("", activeDept);
  }

  function personCard(person) {
    var card = h("div.card.person-card");
    card.style.cursor = "pointer";

    var top = h("div.pc-top");
    top.appendChild(PMS.vformat.avatar(person, "lg"));
    var names = h("div", { style: { minWidth: 0 } });
    names.appendChild(h("div.pc-name.u-ellipsis", { text: person.name }));
    names.appendChild(h("div.u-muted.u-ellipsis", { text: person.jobTitle || "—" }));
    top.appendChild(names);
    top.appendChild(h("span.badge" + (person.status === "inactive" ? "" : ""), {
      text: PMS.i18n.t("people." + (person.status || "active")),
      style: person.status === "inactive" ? { background: "var(--bg-subtle)", color: "var(--text-faint)" } : { background: "var(--success-soft)", color: "var(--success)" }
    }));
    card.appendChild(top);

    // The fields a person is identified by in the list: department, email and
    // phone — so somebody added from any screen is fully readable, and both
    // contact details are one tap away.
    var dept = deptOf(person);
    if (dept) {
      var dchip = h("span.chip.dept-chip.u-ellipsis", { text: "🏢 " + deptName(dept) });
      dchip.style.borderInlineStartColor = dept.color || "var(--primary)";
      card.appendChild(dchip);
    }
    var mail = contactLink("✉", person.email, "mailto:" + person.email);
    var tel = contactLink("☎", person.phone, "tel:" + String(person.phone || "").replace(/[^\d+]/g, ""));
    if (mail || tel) {
      var contact = h("div.pc-contact");
      if (mail) contact.appendChild(mail);
      if (tel) contact.appendChild(tel);
      card.appendChild(contact);
    }

    // tasks summary
    var tasks = PMS.repos.tasks.all().filter(function (tsk) { return (tsk.assignees || []).indexOf(person.id) !== -1; });
    var doneKey = (PMS.store.data.taskStatuses || []).find(function (s) { return s.key === "done"; });
    var done = tasks.filter(function (tsk) { return tsk.status === (doneKey ? "done" : "done"); }).length;
    var open = tasks.length - done;
    var today = PMS.utils.todayISO();
    var late = tasks.filter(function (tsk) { return tsk.dueDate && tsk.dueDate < today && tsk.status !== (doneKey ? "done" : ""); }).length;
    var load = tasks.reduce(function (s, tsk) { return s + (Number(tsk.estimatedHours) || 0); }, 0);

    // A load bar reads faster than four chips: how much of this person's work
    // is finished, and how much of it is late.
    var bar = h("div.pc-load");
    var track = h("div.pc-load-track");
    var pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    var fill = h("div.pc-load-fill", { style: { width: pct + "%" } });
    track.appendChild(fill);
    bar.appendChild(track);
    var row = h("div.u-flex", { style: { fontSize: "0.8rem", gap: "8px", marginBlockStart: "6px" } });
    row.appendChild(h("span.chip", { text: t("people.openTasks") + " " + open }));
    row.appendChild(h("span.chip", { text: t("people.doneTasks") + " " + done }));
    if (late > 0) row.appendChild(h("span.chip", { text: late + " " + t("people.lateTasks"), style: { background: "var(--danger-soft)", color: "var(--danger)" } }));
    row.appendChild(h("span.chip", { text: t("people.loadInHours", { n: Math.round(load) }) }));
    bar.appendChild(row);
    card.appendChild(bar);

    // actions
    var canWrite = PMS.auth ? PMS.auth.can("people.write") : true;
    var isAdmin = PMS.auth ? PMS.auth.isAdmin() : false;
    // A manager may correct their OWN record only (canEditPerson), even though
    // they may add new people to the org.
    var canEditThis = PMS.auth ? PMS.auth.canEditPerson(person) : true;
    var acc = isAdmin ? personAccount(person) : null;
    if (canWrite) {
      var actions = h("div.u-flex", { style: { marginTop: "8px" } });
      if (canEditThis) {
        actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function (e) { e.stopPropagation(); PMS.editors.openPersonEditor(person, function () { render(document.getElementById("view-root")); }); } } }));
      }
      if (isAdmin) {
        if (acc) {
          actions.appendChild(h("span.chip", { text: "🔑 " + t("people.hasAccount"), style: acc.cloudUid ? { background: "var(--info-soft)", color: "var(--info)" } : { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
          actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("people.resetPasswordMail"), on: { click: function (e) { e.stopPropagation(); resetPersonPassword(person, acc); } } }));
        } else {
          actions.appendChild(h("span.chip", { text: t("people.noAccount"), style: { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
          actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("people.createAccount"), on: { click: function (e) { e.stopPropagation(); createPersonAccountDialog(person); } } }));
        }
      }
      // Archiving hides somebody from every active list, so it is the admin's
      // alone. It used to be offered to any manager and then refused at the
      // confirm step, which read as a broken button.
      if (isAdmin) {
        if (person.status !== "inactive") {
          actions.appendChild(h("button.btn.btn-sm.btn-soft-danger", { text: t("common.archive"), on: { click: function (e) { e.stopPropagation(); archivePerson(person); } } }));
        } else {
          actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.restore"), on: { click: function (e) { e.stopPropagation(); PMS.repos.people.update(person.id, { status: "active" }); if (PMS.accounts && PMS.accounts.setActiveForPerson) PMS.accounts.setActiveForPerson(PMS.repos.people.get(person.id)); render(document.getElementById("view-root")); } } }));
        }
      }
      if (actions.childNodes.length) card.appendChild(actions);
    }
    card.addEventListener("click", function () { openPersonDetail(person); });
    return card;
  }

  // Read the account through the merged view (local records + the cloud
  // directory), so a colleague who signed in on another device is not reported as
  // having no login account just because this browser never adopted their record.
  function personAccount(person) {
    if (!person || !PMS.auth || !PMS.auth.accountForPerson) return null;
    return PMS.auth.accountForPerson(person.id) || null;
  }

  // The People screen asks "who can sign in", which is a question about Firebase
  // Auth, not about this browser. On a device that has never opened Settings ->
  // Accounts the directory has never been fetched, so the answer would be
  // "nobody but me". Fetch it once when an admin lands here, then repaint.
  var dirAsked = false;
  function ensureDirectory() {
    if (dirAsked) return;
    if (!PMS.cloudsync || !PMS.cloudsync.cloudAccounts || !PMS.cloudsync.isConfigured()) return;
    if (!PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return;
    dirAsked = true;
    var root = document.getElementById("view-root");
    PMS.cloudsync.cloudAccounts(false).then(function () {
      if (PMS.router && PMS.router.current === "/people" && root) render(root);
    })["catch"](function () { dirAsked = false; });
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
        var meetings = PMS.repos.meetings.forPerson(person.id);
        var wrap = h("div.stack");
        var dept = deptOf(person);

        // header: who this is, and how to reach them
        var head = h("div.person-detail-head");
        head.appendChild(PMS.vformat.avatar(person, "lg"));
        var hi = h("div", { style: { minWidth: 0 } });
        hi.appendChild(h("div.pc-name", { text: person.name }));
        hi.appendChild(h("div.u-muted", { text: person.jobTitle || "—" }));
        if (dept) {
          var dchip = h("span.chip.dept-chip", { text: "🏢 " + deptName(dept) });
          dchip.style.borderInlineStartColor = dept.color || "var(--primary)";
          hi.appendChild(dchip);
        }
        head.appendChild(hi);
        wrap.appendChild(head);

        var contact = h("div.person-contact");
        var mail = contactLink("✉", person.email, "mailto:" + person.email);
        var tel = contactLink("☎", person.phone, "tel:" + String(person.phone || "").replace(/[^\d+]/g, ""));
        if (mail) contact.appendChild(mail);
        if (tel) contact.appendChild(tel);
        if (!person.email && !person.phone) contact.appendChild(h("span.u-muted", { text: t("people.noContact") }));
        wrap.appendChild(contact);

        var meta = h("div.detail-list");
        meta.appendChild(dl(t("people.jobTitle"), person.jobTitle || "—"));
        meta.appendChild(dl(t("people.department"), dept ? deptName(dept) : "—"));
        meta.appendChild(dl(t("people.email"), person.email || "—"));
        meta.appendChild(dl(t("people.phone"), person.phone || "—"));
        var acc = personAccount(person);
        if (acc) {
          meta.appendChild(dl(t("people.account"), t("auth.role." + (acc.role || "member"))));
        }
        if (person.notes) meta.appendChild(dl(t("people.notes"), person.notes));
        wrap.appendChild(meta);

        // workload at a glance
        var doneKey = (PMS.store.data.taskStatuses || []).find(function (s) { return s.key === "done"; });
        var done = tasks.filter(function (tsk) { return tsk.status === (doneKey ? doneKey.key : "done"); }).length;
        var load = tasks.reduce(function (s, tsk) { return s + (Number(tsk.estimatedHours) || 0); }, 0);
        var stats = h("div.u-flex", { style: { gap: "8px", flexWrap: "wrap" } });
        stats.appendChild(h("span.chip", { text: t("people.openTasks") + " " + (tasks.length - done) }));
        stats.appendChild(h("span.chip", { text: t("people.doneTasks") + " " + done }));
        stats.appendChild(h("span.chip", { text: t("people.loadInHours", { n: Math.round(load) }) }));
        stats.appendChild(h("span.chip", { text: t("people.meetingsCount", { n: meetings.length }) }));
        wrap.appendChild(stats);

        wrap.appendChild(h("div.section-title", [txt(t("people.tasksCount", { n: tasks.length }))]));
        if (!tasks.length) wrap.appendChild(h("div.u-muted", { text: t("people.noTasks") }));
        var list = h("div.stack");
        tasks.slice(0, 15).forEach(function (tsk) {
          var row = h("div.project-tree-row");
          row.style.cursor = "pointer";
          row.appendChild(h("span", { text: tsk.status === (doneKey ? doneKey.key : "done") ? "✓" : "○" }));
          var proj = PMS.repos.projects.get(tsk.projectId);
          row.appendChild(h("span.u-grow.u-ellipsis", { text: tsk.title + (proj ? " · " + proj.name : "") }));
          row.appendChild(PMS.vformat.statusBadge(tsk.status, "task"));
          row.appendChild(PMS.vformat.priorityBadge(tsk.priority));
          row.addEventListener("click", function () {
            PMS.modal.close();
            if (PMS.taskDetail) PMS.taskDetail.open(tsk.id);
          });
          list.appendChild(row);
        });
        wrap.appendChild(list);

        // the meetings this person attended, newest first
        wrap.appendChild(h("div.section-title", [txt(t("people.meetingsTitle", { n: meetings.length }))]));
        if (!meetings.length) wrap.appendChild(h("div.u-muted", { text: t("people.noMeetings") }));
        var mlist = h("div.stack");
        meetings.slice(0, 10).forEach(function (m) {
          var row = h("div.project-tree-row", { style: { cursor: "pointer" } });
          row.appendChild(h("span.u-muted", { text: PMS.utils.formatDate(m.date, PMS.i18n) }));
          row.appendChild(h("span.u-grow.u-ellipsis", { text: m.title }));
          if ((m.attachments || []).length) row.appendChild(h("span.chip", { text: "📎 " + (m.attachments || []).length }));
          row.addEventListener("click", function () {
            PMS.modal.close();
            if (PMS.meetings) PMS.meetings.openDetail(m.id);
          });
          mlist.appendChild(row);
        });
        wrap.appendChild(mlist);

        if (PMS.auth ? PMS.auth.canEditPerson(person) : true) {
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
    var everyone = PMS.repos.people.all();

    // Whoever is not in a department is a section of their own: nobody should
    // vanish from this tab because a department was never picked.
    var unassigned = everyone.filter(function (p) { return !deptOf(p); });
    if (!depts.length && !unassigned.length) {
      container.appendChild(h("div.empty-state", [h("div", { text: t("people.departments") + " — " + t("common.noResults") })]));
      return;
    }

    var summary = h("div.people-toolbar");
    summary.appendChild(h("div.u-muted", {
      text: t("people.sectionsSummary", { depts: depts.length, people: everyone.length })
    }));
    if (PMS.auth ? PMS.auth.isAdmin() : true) {
      summary.appendChild(h("button.btn.btn-sm", {
        text: "+ " + t("people.addDepartment"),
        on: { click: function () { PMS.editors.openDepartmentEditor(null, function () { render(document.getElementById("view-root")); }); } }
      }));
    }
    container.appendChild(summary);

    depts.forEach(function (dept) { container.appendChild(deptCard(dept, deptMembers(dept))); });
    if (unassigned.length) {
      var loose = h("div.card", { style: { marginBlockEnd: "12px" } });
      var lhead = h("div.card-header");
      lhead.appendChild(h("span.badge-dot", { style: { background: "var(--text-faint)", width: "12px", height: "12px", borderRadius: "3px" } }));
      lhead.appendChild(h("div.u-grow", {}, [
        h("div.card-title", { text: t("people.noDepartment") }),
        h("div.u-muted", { text: personSummary(unassigned) })
      ]));
      loose.appendChild(lhead);
      loose.appendChild(peopleBody(unassigned));
      container.appendChild(loose);
    }
  }

  function deptMembers(dept) {
    return PMS.repos.people.all().filter(function (p) { return p.departmentId === dept.id; });
  }

  function deptCard(dept, people) {
    var card = h("div.card", { style: { marginBlockEnd: "12px" } });
    var head = h("div.card-header");
    head.appendChild(h("span.badge-dot", { style: { background: dept.color || "#2563eb", width: "12px", height: "12px", borderRadius: "3px" } }));
    var open = tasksOf(people);
    head.appendChild(h("div.u-grow", {}, [
      h("div.card-title", { text: deptName(dept) }),
      h("div.u-muted", {
        text: personSummary(people) + "  ·  " +
          t("people.sectionLoad", { open: open.total - open.done, done: open.done, hours: Math.round(open.hours) })
      })
    ]));
    // Sections are read-only for a manager: renaming or deleting one restructures
    // the whole org. requireDelete() refuses the delete anyway; showing a
    // button that only ever answers with an error toast read as a bug.
    if (PMS.auth ? PMS.auth.isAdmin() : true) {
      head.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function () { PMS.editors.openDepartmentEditor(dept, function () { render(document.getElementById("view-root")); }); } } }));
      head.appendChild(h("button.btn.btn-sm.btn-soft-danger", { text: t("common.delete"), on: { click: function () { deleteDept(dept); } } }));
    }
    card.appendChild(head);
    // a thin bar: how much of the section's work is finished
    if (open.total) {
      var track = h("div.pc-load-track", { style: { margin: "0 var(--space-4)" } });
      track.appendChild(h("div.pc-load-fill", { style: { width: Math.round((open.done / open.total) * 100) + "%" } }));
      card.appendChild(track);
    }
    if (people.length) card.appendChild(peopleBody(people));
    return card;
  }

  // One row per person inside a section: avatar, name, title and a way to
  // reach them - the same details the card shows, only in a list.
  function peopleBody(people) {
    var body = h("div.card-body.people-rows");
    people.forEach(function (p) {
      var row = h("div.people-row", { style: { cursor: "pointer" } });
      row.appendChild(PMS.vformat.avatar(p));
      var info = h("div", { style: { minWidth: 0, flex: "1 1 auto" } });
      info.appendChild(h("div.u-ellipsis", { text: p.name, style: { fontWeight: 600 } }));
      var sub = [];
      if (p.jobTitle) sub.push(p.jobTitle);
      if (p.email) sub.push(p.email);
      if (p.phone) sub.push(p.phone);
      if (sub.length) info.appendChild(h("div.u-muted.u-ellipsis", { text: sub.join(" · "), style: { fontSize: "0.78rem" } }));
      row.appendChild(info);
      if (p.status === "inactive") {
        row.appendChild(h("span.badge", { text: t("people.inactive"), style: { background: "var(--bg-subtle)", color: "var(--text-faint)" } }));
      }
      row.addEventListener("click", function () { openPersonDetail(p); });
      body.appendChild(row);
    });
    return body;
  }

  // How much work a group of people carries: open / done / estimated hours.
  function tasksOf(people) {
    var ids = people.map(function (p) { return p.id; });
    var doneKey = (PMS.store.data.taskStatuses || []).find(function (s) { return s.key === "done"; });
    var out = { total: 0, done: 0, hours: 0 };
    PMS.repos.tasks.all().forEach(function (tsk) {
      if (!(tsk.assignees || []).some(function (id) { return ids.indexOf(id) !== -1; })) return;
      out.total++;
      if (tsk.status === (doneKey ? doneKey.key : "done")) out.done++;
      out.hours += Number(tsk.estimatedHours) || 0;
    });
    return out;
  }

  function personSummary(people) {
    var active = people.filter(function (p) { return p.status !== "inactive"; }).length;
    return t("dashboard.nMembers", { n: active }) + " / " + people.length;
  }

  function deleteDept(dept) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deleteDept", { name: deptName(dept) }) }),
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
  PMS.people = { openDetail: openPersonDetail, view: view };
  PMS.registry.registerView(view);
  PMS.router.register("/people", "people");
})(window.PMS);