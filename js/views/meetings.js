/* ==========================================================================
   Meetings view - meetings with attendees, agenda, linked pillars and the
   tasks that come out of them. Every task created from a meeting is a normal
   task: it lives in the Tasks tab too and carries a back-link to its meeting.
   Route: /meetings
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  // The list filter always starts (and resets) on "All" so every meeting is
  // visible until the user narrows it down.
  var state = { tab: "all", query: "" };

  /* ---------------- list ---------------- */

  function visibleMeetings() {
    var all = PMS.repos.meetings.all();
    if (state.tab === "upcoming") all = PMS.repos.meetings.upcoming();
    else if (state.tab === "past") all = PMS.repos.meetings.past();
    else all = all.slice().sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
    var q = (state.query || "").trim().toLowerCase();
    if (!q) return all;
    return all.filter(function (m) {
      var pillarNames = (m.projectIds || []).map(function (pid) {
        var p = PMS.repos.projects.get(pid);
        return p ? p.name : "";
      }).join(" ");
      var taskTitles = PMS.repos.meetings.tasksOf(m.id).map(function (tk) { return tk.title; }).join(" ");
      return String(m.title || "").toLowerCase().indexOf(q) !== -1 ||
        (m.agenda || []).join(" ").toLowerCase().indexOf(q) !== -1 ||
        (m.notes || "").toLowerCase().indexOf(q) !== -1 ||
        String(m.location || "").toLowerCase().indexOf(q) !== -1 ||
        pillarNames.toLowerCase().indexOf(q) !== -1 ||
        taskTitles.toLowerCase().indexOf(q) !== -1;
    });
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("meetings.title") }));
    var actions = h("div.actions");
    actions.appendChild(tabSwitcher());
    if (PMS.auth ? PMS.auth.canCreateMeeting() : true) {
      actions.appendChild(h("button.btn.btn-primary", {
        text: "+ " + t("meetings.newMeeting"),
        on: { click: function () { PMS.editors.openMeetingEditor(null, { onSaved: function () { PMS.router.handle(); } }); } }
      }));
    }
    header.appendChild(actions);
    container.appendChild(header);

    var search = h("input.input.search-inline", {
      value: state.query,
      placeholder: t("common.search"),
      on: { input: function (e) { state.query = e.target.value; paintList(); } }
    });
    container.appendChild(search);

    var listWrap = h("div.meeting-list");
    container.appendChild(listWrap);

    function paintList() {
      listWrap.innerHTML = "";
      var rows = visibleMeetings();
      if (!rows.length) {
        listWrap.appendChild(h("div.empty-state", [h("div", { text: t("meetings.empty") })]));
        return;
      }
      rows.forEach(function (m) { listWrap.appendChild(meetingCard(m)); });
    }
    paintList();
  }

  function tabSwitcher() {
    var wrap = h("div.segmented");
    [["all", t("meetings.all")], ["upcoming", t("meetings.upcoming")], ["past", t("meetings.past")]].forEach(function (m) {
      wrap.appendChild(h("button" + (state.tab === m[0] ? ".active" : ""), {
        text: m[1],
        on: { click: function () { state.tab = m[0]; PMS.router.handle(); } }
      }));
    });
    return wrap;
  }

  function meetingCard(m) {
    var card = h("div.card.meeting-card", { on: { click: function () { openDetail(m.id); } } });
    var body = h("div.card-body");
    var top = h("div.u-flex", { style: { gap: "10px", alignItems: "baseline" } });
    top.appendChild(h("span.meeting-date", { text: PMS.utils.formatDate(m.date, PMS.i18n) }));
    top.appendChild(h("span.u-bold", { text: m.title }));
    body.appendChild(top);
    if (m.time || m.location) {
      var sub = [];
      if (m.time) sub.push("🕐 " + m.time);
      if (m.location) sub.push("📍 " + m.location);
      body.appendChild(h("div.u-muted", { text: sub.join("  ·  "), style: { fontSize: "0.8rem" } }));
    }
    if (m.agenda && m.agenda.length) {
      var ag = h("div.u-muted", { text: "📋 " + m.agenda.slice(0, 3).join(" · ") + (m.agenda.length > 3 ? " …" : ""), style: { fontSize: "0.8rem" } });
      body.appendChild(ag);
    }

    // The tasks and pillars behind this meeting, listed compactly right on
    // the card (next to the info above) so nothing needs to be opened.
    var tasks = PMS.repos.meetings.tasksOf(m.id);
    var pillars = (m.projectIds || []).map(function (pid) { return PMS.repos.projects.get(pid); }).filter(Boolean);
    var linked = h("div.meeting-linked");
    if (tasks.length) {
      var tl = h("div.meeting-linked-row");
      tl.appendChild(h("span.meeting-linked-label", { text: "☑ " + t("meetings.tasks") }));
      var tlWrap = h("div.meeting-linked-items");
      tasks.slice(0, 4).forEach(function (task) {
        var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === task.status; });
        var chip = h("span.chip.meeting-task-chip", {
          text: task.title,
          attrs: { title: task.title + (s ? " · " + PMS.i18n.trilingual(s.name)(s.name) : "") }
        });
        chip.style.borderInlineStartColor = (s && s.color) || "transparent";
        chip.addEventListener("click", function (e) {
          e.stopPropagation();
          openDetailTask(task.id);
        });
        tlWrap.appendChild(chip);
      });
      if (tasks.length > 4) tlWrap.appendChild(h("span.chip", { text: "+" + (tasks.length - 4) }));
      tl.appendChild(tlWrap);
      linked.appendChild(tl);
    }
    if (pillars.length) {
      var pl = h("div.meeting-linked-row");
      pl.appendChild(h("span.meeting-linked-label", { text: "🗀 " + t("meetings.pillars") }));
      var plWrap = h("div.meeting-linked-items");
      pillars.forEach(function (p) {
        var chip = h("span.chip.meeting-pillar-chip", { text: p.name, attrs: { title: t("projects.openPillar", { name: p.name }) } });
        chip.addEventListener("click", function (e) {
          e.stopPropagation();
          PMS.router.navigate("/projects/" + p.id);
        });
        plWrap.appendChild(chip);
      });
      pl.appendChild(plWrap);
      linked.appendChild(pl);
    }
    if (linked.childNodes.length) body.appendChild(linked);

    var foot = h("div.u-flex", { style: { gap: "12px", alignItems: "center", marginBlockStart: "8px" } });
    foot.appendChild(h("span.chip", { text: "☑ " + t("meetings.tasksCount", { n: tasks.length }) }));
    foot.appendChild(h("span.chip", { text: t("meetings.pillars") + ": " + pillars.length }));
    var atts = (m.attendees || []).map(function (pid) { return PMS.repos.people.get(pid); }).filter(Boolean);
    if (atts.length) {
      var av = h("span.u-flex", { style: { gap: "2px" } });
      atts.slice(0, 6).forEach(function (p) { av.appendChild(PMS.vformat.avatar(p)); });
      foot.appendChild(av);
    }
    body.appendChild(foot);
    card.appendChild(body);
    return card;
  }

  // a task chip on a card opens the task itself, never the meeting behind it
  function openDetailTask(taskId) {
    if (PMS.taskDetail) {
      detailOpen = false;
      PMS.modal.close();
      PMS.taskDetail.open(taskId);
    }
  }

  /* ---------------- detail ---------------- */

  function openDetail(meetingId) {
    var m = PMS.repos.meetings.get(meetingId);
    if (!m) return;
    detailOpen = true;
    PMS.modal.open({
      title: m.title,
      size: "lg",
      content: function () { return detailBody(m); },
      footer: [
        { label: t("common.delete"), class: "btn-soft-danger", onClick: function () { confirmDelete(m); } },
        {
          label: "+ " + t("meetings.newTask"), class: "btn-primary",
          onClick: function () { newTaskFromMeeting(m); }
        },
        { label: t("common.close"), onClick: function () { detailOpen = false; PMS.modal.close(); } }
      ]
    });
  }

  var detailOpen = false;
  // keeps the detail modal in sync with edits made from the list. The body
  // class check makes sure we never re-open it over ANOTHER dialog (the modal
  // API replaces the open dialog instead of stacking).
  PMS.bus.on("store:changed", function () {
    if (!PMS.modal.isOpen || !detailOpen) return;
    if (!PMS.modal.body || !PMS.modal.body.querySelector(".meeting-detail-body")) { detailOpen = false; return; }
    var m = PMS.repos.meetings.get(currentId);
    if (m) { PMS.modal.close(); openDetail(currentId); }
    else detailOpen = false;
  });
  var currentId = null;

  function detailBody(m) {
    currentId = m.id;
    var node = h("div.stack.meeting-detail-body");

    // meta
    var meta = h("div.detail-list");
    meta.appendChild(detailItem(t("meetings.date"), PMS.utils.formatDate(m.date, PMS.i18n)));
    if (m.time) meta.appendChild(detailItem(t("meetings.time"), m.time));
    if (m.location) meta.appendChild(detailItem(t("meetings.location"), m.location));
    var u = m.createdBy ? PMS.auth.userById(m.createdBy) : null;
    meta.appendChild(detailItem(t("meetings.createdBy"), u ? (u.name || u.username) : "—"));
    node.appendChild(meta);

    // attendees
    node.appendChild(h("div.section-title", [h("span", { text: t("meetings.attendees") })]));
    var atts = (m.attendees || []).map(function (pid) { return PMS.repos.people.get(pid); }).filter(Boolean);
    if (!atts.length) node.appendChild(h("div.u-muted", { text: t("meetings.noAttendees") }));
    else {
      var arow = h("div.u-flex", { style: { gap: "6px", flexWrap: "wrap" } });
      atts.forEach(function (p) { arow.appendChild(PMS.vformat.personChip(p.id)); });
      node.appendChild(arow);
    }

    // agenda
    node.appendChild(h("div.section-title", [h("span", { text: t("meetings.agenda") })]));
    if (!m.agenda || !m.agenda.length) node.appendChild(h("div.u-muted", { text: "—" }));
    else {
      var ag = h("ol.meeting-agenda");
      m.agenda.forEach(function (item) { ag.appendChild(h("li", { text: item })); });
      node.appendChild(ag);
    }

    if (m.notes) node.appendChild(h("div.card", [h("div.card-body", [h("p", { text: m.notes })])]));

    // pillars
    node.appendChild(h("div.section-title", [h("span", { text: t("meetings.pillars") })]));
    var pids = m.projectIds || [];
    if (!pids.length) node.appendChild(h("div.u-muted", { text: t("meetings.noPillars") }));
    else {
      var prow = h("div.u-flex", { style: { gap: "6px", flexWrap: "wrap" } });
      pids.forEach(function (pid) {
        var p = PMS.repos.projects.get(pid);
        if (!p) return;
        var chip = h("span.chip", { text: p.name, attrs: { title: t("tasks.title") } });
        chip.addEventListener("click", function () {
          detailOpen = false;
          PMS.modal.close();
          PMS.router.navigate("/projects/" + p.id);
        });
        prow.appendChild(chip);
      });
      node.appendChild(prow);
    }

    // tasks
    node.appendChild(h("div.section-title", [h("span", { text: t("meetings.tasks") })]));
    var tasks = PMS.repos.meetings.tasksOf(m.id);
    if (!tasks.length) node.appendChild(h("div.u-muted", { text: t("meetings.noTasks") }));
    var trow = h("div.stack");
    tasks.forEach(function (task) { trow.appendChild(meetingTaskRow(task)); });
    node.appendChild(trow);
    var addRow = h("div.u-flex", { style: { gap: "6px" } });
    if (PMS.auth ? PMS.auth.canCreateTask() : true) {
      addRow.appendChild(h("button.btn.btn-sm", { text: "+ " + t("meetings.newTask"), on: { click: function () { newTaskFromMeeting(m); } } }));
    }
    var linkBtn = h("button.btn.btn-sm", { text: "+ " + t("meetings.linkExistingTask") });
    linkBtn.addEventListener("click", function () { linkExistingTask(m, linkBtn); });
    addRow.appendChild(linkBtn);
    node.appendChild(addRow);

    var footRow = h("div.u-flex", { style: { gap: "6px", marginBlockStart: "12px" } });
    if (PMS.auth ? PMS.auth.canEditMeeting(m) : true) {
      footRow.appendChild(h("button.btn.btn-sm", {
        text: t("common.edit"),
        on: { click: function () {
          detailOpen = false;
          PMS.modal.close();
          PMS.editors.openMeetingEditor(m, { onSaved: function () { openDetail(m.id); } });
        } }
      }));
    }
    node.appendChild(footRow);

    return node;
  }

  function detailItem(label, value) {
    var d = h("div.detail-item");
    d.appendChild(h("div.dl-label", { text: label }));
    d.appendChild(h("div.dl-value", { text: value || "—" }));
    return d;
  }

  function meetingTaskRow(task) {
    var row = h("div.project-tree-row", { style: { cursor: "pointer" } });
    row.appendChild(PMS.vformat.statusBadge(task.status, "task"));
    row.appendChild(h("span.u-grow.u-ellipsis", { text: task.title }));
    var p = PMS.repos.projects.get(task.projectId);
    row.appendChild(h("span.u-muted", { text: p ? p.name : "—" }));
    (task.assignees || []).forEach(function (pid) {
      var person = PMS.repos.people.get(pid);
      if (person) row.appendChild(PMS.vformat.avatar(person));
    });
    row.addEventListener("click", function () {
      detailOpen = false;
      if (PMS.taskDetail) PMS.taskDetail.markClosed();
      PMS.modal.close();
      PMS.taskDetail.open(task.id);
    });
    return row;
  }

  /* ---------------- actions ---------------- */

  // A task created from a meeting is a NORMAL task: it gets the meeting id, the
  // first linked pillar (when the user did not pick one) and shows up in the
  // Tasks tab with a back-link to this meeting.
  function newTaskFromMeeting(m) {
    var defaults = { meetingId: m.id };
    if (m.projectIds && m.projectIds.length) defaults.projectId = m.projectIds[0];
    if (m.date) defaults.startDate = m.date;
    detailOpen = false;
    PMS.modal.close();
    PMS.editors.openTaskEditor(null, {
      defaults: defaults,
      onSaved: function () {
        PMS.toast.show(t("meetings.taskCreated"), "success");
        if (PMS.router.current === "/meetings") PMS.router.handle();
      }
    });
  }

  function linkExistingTask(m, trigger) {
    var items = PMS.repos.tasks.all().filter(function (x) { return x.meetingId !== m.id; })
      .slice(0, 60).map(function (x) {
        var p = PMS.repos.projects.get(x.projectId);
        return {
          label: x.title + (p ? "  ·  " + p.name : ""),
          onClick: function () {
            PMS.repos.tasks.update(x.id, { meetingId: m.id });
            PMS.toast.show(t("meetings.taskLinked"), "success");
          }
        };
      });
    if (!items.length) items.push({ separator: true, header: t("common.noResults") });
    PMS.dropdown.attach(trigger, items, { alignEnd: true });
  }

  function confirmDelete(m) {
    if (PMS.auth && PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    var tasks = PMS.repos.meetings.tasksOf(m.id);
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: tasks.length ? t("confirm.deleteMeeting", { title: m.title }) : t("meetings.deleteIfEmpty") }),
      footer: [
        { label: t("common.cancel"), onClick: function () { detailOpen = false; PMS.modal.close(); } },
        {
          label: t("common.delete"), class: "btn-danger",
          onClick: function () {
            PMS.repos.meetings.remove(m.id);
            detailOpen = false;
            PMS.modal.close();
            PMS.toast.show(t("common.delete") + " ✓", "success");
          }
        }
      ]
    });
  }

  var view = {
    id: "meetings",
    path: "/meetings",
    titleKey: "nav.meetings",
    icon: "🗓",
    nav: true,
    render: function (container) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/meetings") render(container); });
      return function () { off(); };
    }
  };

  PMS.meetings = { openDetail: openDetail, view: view };
  PMS.registry.registerView(view);
  PMS.router.register("/meetings", "meetings");
})(window.PMS);
