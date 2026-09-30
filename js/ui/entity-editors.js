/* ==========================================================================
   PMS.editors - shared modal editors for Department / Person / Project / Task.
   Reused by projects, tasks, kanban, calendar, people views.
   Renders custom fields automatically from registered field types.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k) { return PMS.i18n.t(k); };
  var tf = function (k) { return PMS.i18n.t(k); };

  function fieldOptions(entity) {
    // returns schema for entity
    if (entity === "task") return taskSchema();
    if (entity === "project") return projectSchema();
    if (entity === "person") return personSchema();
    if (entity === "department") return departmentSchema();
    if (entity === "meeting") return meetingSchema();
    return [];
  }

  // Permission gates. Local auth is UI-level protection (accepted design).
  function deny() {
    PMS.toast.show(PMS.i18n.t("auth.forbidden"), "error");
    return false;
  }

  function canOpenProject(project) {
    if (!PMS.auth) return true;
    return PMS.auth.canEditProject(project) ? true : deny();
  }

  function canOpenPerson() {
    if (!PMS.auth) return true;
    return PMS.auth.can("people.write") ? true : deny();
  }

  function canOpenDepartment() {
    if (!PMS.auth) return true;
    return PMS.auth.can("people.write") ? true : deny();
  }

  function canOpenTask(task, opts) {
    if (!PMS.auth) return true;
    if (PMS.auth.canEditTask(task)) return true;
    // managers may open a task/subtask of their own projects to change its
    // status (a status-only editor is offered for these)
    if (PMS.auth.canChangeStatus(task)) return true;
    // creating a new task is a separate permission (admins: any project,
    // managers: only their own projects)
    if (!task && PMS.auth.canCreateTask(opts && opts.defaults && opts.defaults.projectId)) return true;
    return deny();
  }

  // Without full edit rights on a task, only its status may be changed
  // (dates, estimates, assignees, ... stay locked). Members only reach the
  // status-only editor on assigned tasks; managers also on every task of a
  // project they manage.
  function statusOnlyTaskEditor() {
    var statuses = (PMS.store.data.taskStatuses || []).map(function (s) {
      return { label: PMS.i18n.trilingual(s.name)(s.name), value: s.key };
    });
    return [
      { key: "status", label: t("common.status"), type: "select", options: statuses }
    ];
  }

  function departmentSchema() {
    return [
      { key: "nameEn", label: t("common.name") + " (EN)", type: "text", required: true },
      { key: "nameAr", label: t("common.name") + " (AR)", type: "text", required: false },
      { key: "descriptionEn", label: t("common.description") + " (EN)", type: "textarea", full: true },
      { key: "descriptionAr", label: t("common.description") + " (AR)", type: "textarea", full: true },
      { key: "color", label: t("common.color"), type: "select", options: [
        { label: "Blue", value: "#2563eb" }, { label: "Purple", value: "#7c3aed" },
        { label: "Pink", value: "#db2777" }, { label: "Orange", value: "#ea580c" },
        { label: "Green", value: "#16a34a" }, { label: "Cyan", value: "#0891b2" },
        { label: "Yellow", value: "#ca8a04" }
      ] }
    ];
  }

  function personSchema() {
    var depts = (PMS.repos.departments.all() || []).map(function (d) {
      return { label: PMS.i18n.trilingual(d.name)(d.name), value: d.id };
    });
    return [
      { key: "name", label: t("people.name"), type: "text", required: true },
      { key: "jobTitle", label: t("people.jobTitle"), type: "text" },
      { key: "departmentId", label: t("people.department"), type: "select", options: depts },
      { key: "email", label: t("people.email"), type: "email", required: true },
      { key: "phone", label: t("people.phone"), type: "text" },
      { key: "status", label: t("common.status"), type: "select", options: [
        { label: t("people.active"), value: "active" },
        { label: t("people.inactive"), value: "inactive" }
      ] },
      { key: "notes", label: t("people.notes"), type: "textarea", full: true }
    ];
  }

  // For a manager the editor only lists the projects they manage (parents
  // to attach under) and keeps the manager field locked to themselves.
  function projectSchema(managedOnly, isEdit) {
    var people = PMS.repos.people.active();
    var projects = PMS.repos.projects.all();
    var statuses = (PMS.store.data.projectStatuses || []).map(function (s) {
      return { label: PMS.i18n.trilingual(s.name)(s.name), value: s.key };
    });
    var prios = (PMS.store.data.priorities || []).map(function (p) {
      return { label: PMS.i18n.trilingual(p.name)(p.name), value: p.key };
    });
    var parentOpts;
    var managerOpts;
    if (managedOnly) {
      var me = PMS.auth ? PMS.auth.currentUser() : null;
      parentOpts = projects.filter(function (p) { return PMS.auth.managesProject(p); }).map(function (p) {
        return { label: p.name, value: p.id };
      });
      managerOpts = people.filter(function (p) { return me && p.id === me.personId; }).map(function (p) {
        return { label: p.name, value: p.id };
      });
    } else {
      parentOpts = projects.map(function (p) {
        return { label: p.name, value: p.id };
      });
      managerOpts = people.map(function (p) { return { label: p.name, value: p.id }; });
    }
    return [
      { key: "name", label: t("projects.name"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea", full: true },
      { key: "parentId", label: t("projects.parent"), type: "select", options: parentOpts },
      { key: "status", label: t("projects.status"), type: "select", options: statuses },
      { key: "priority", label: t("projects.priority"), type: "select", options: prios },
      // "Owner" — create a person on the fly if they are not in the system yet
      { key: "managerId", label: t("projects.manager"), type: "select", options: managerOpts, allowCreatePerson: !managedOnly, hint: managedOnly ? "" : t("projects.managerHint") },
      { key: "memberIds", label: t("projects.members"), type: "multiselect", options: people.map(function (p) { return { label: p.name, value: p.id }; }), allowCreatePerson: true },
      { key: "startDate", label: t("projects.startDate"), type: "date" },
      { key: "endDate", label: t("projects.endDate"), type: "date" },
      { key: "budget", label: t("projects.budget"), type: "number" },
      { key: "weight", label: t("projects.weight"), type: "number", hint: t("projects.weightHint") },
      { key: "tags", label: t("common.tags"), type: "tags", full: true },
      { key: "links", label: t("projects.links"), type: "text", hint: t("common.typeHere") },
      { key: "notes", label: t("common.notes"), type: "textarea", full: true }
    ];
  }

  function taskSchema(projectFilter, taskId) {
    var projects = PMS.repos.projects.all().filter(function (p) {
      return !projectFilter || projectFilter.indexOf(p.id) !== -1;
    });
    var people = PMS.repos.people.active();
    var tasks = PMS.repos.tasks.all();
    var statuses = (PMS.store.data.taskStatuses || []).map(function (s) {
      return { label: PMS.i18n.trilingual(s.name)(s.name), value: s.key };
    });
    var prios = (PMS.store.data.priorities || []).map(function (p) {
      return { label: PMS.i18n.trilingual(p.name)(p.name), value: p.key };
    });
    return [
      { key: "title", label: t("tasks.title"), type: "text", required: true },
      { key: "description", label: t("common.description"), type: "textarea", full: true },
      { key: "projectId", label: t("tasks.project"), type: "select", options: projects.map(function (p) { return { label: p.name, value: p.id }; }, { value: "" }) },
      { key: "parentTaskId", label: t("tasks.parentTask"), type: "select", options: tasks.map(function (tk) { return { label: tk.title, value: tk.id }; }) },
      { key: "status", label: t("common.status"), type: "select", options: statuses },
      { key: "priority", label: t("common.priority"), type: "select", options: prios },
      // "+ person" popup: assign somebody who is not in the system yet
      { key: "assignees", label: t("tasks.assignees"), type: "multiselect", options: people.map(function (p) { return { label: p.name, value: p.id }; }), allowCreatePerson: true },
      { key: "startDate", label: t("tasks.startDate"), type: "date" },
      { key: "dueDate", label: t("tasks.dueDate"), type: "date" },
      { key: "estimatedHours", label: t("tasks.estimated"), type: "number" },
      { key: "actualHours", label: t("tasks.actual"), type: "number" },
      { key: "linkedTaskIds", label: t("tasks.linkedTasks"), type: "linkedTask", excludeId: taskId || null, full: true, hint: t("tasks.linkedTasksHint") },
      { key: "tags", label: t("common.tags"), type: "tags", full: true }
    ];
  }

  // ---------------- meetings ----------------
  function meetingSchema() {
    var people = PMS.repos.people.active();
    var projects = PMS.repos.projects.all();
    return [
      { key: "title", label: t("meetings.meetingTitle"), type: "text", required: true, full: true },
      { key: "date", label: t("meetings.date"), type: "date" },
      { key: "time", label: t("meetings.time"), type: "time" },
      { key: "location", label: t("meetings.location"), type: "text" },
      { key: "attendees", label: t("meetings.attendees"), type: "multiselect", options: people.map(function (p) { return { label: p.name, value: p.id }; }), allowCreatePerson: true, full: true },
      { key: "agenda", label: t("meetings.agenda"), type: "tags", placeholder: t("meetings.agendaPlaceholder"), full: true },
      { key: "projectIds", label: t("meetings.pillars"), type: "multiselect", options: projects.map(function (p) { return { label: p.name, value: p.id }; }), full: true },
      { key: "attachments", label: t("meetings.attachments"), type: "attachments", full: true, hint: t("meetings.attachmentsHint") },
      { key: "notes", label: t("meetings.notes"), type: "textarea", full: true }
    ];
  }

  function canOpenMeeting(meeting) {
    if (!PMS.auth) return true;
    return PMS.auth.canEditMeeting ? PMS.auth.canEditMeeting(meeting) : true;
  }

  /* ---------- open editors ---------- */

  function openDepartmentEditor(dept, onSaved) {
    if (!canOpenDepartment()) return;
    var isEdit = !!dept;
    PMS.modal.open({
      title: isEdit ? t("people.editDepartment") : t("people.addDepartment"),
      size: "sm",
      content: function () {
        var sch = departmentSchema();
        var vals = dept ? {
          nameEn: dept.name && dept.name.en, nameAr: dept.name && dept.name.ar,
          descriptionEn: dept.description && dept.description.en,
          descriptionAr: dept.description && dept.description.ar,
          color: dept.color
        } : { color: "#2563eb" };
        return PMS.forms.build(sch, vals);
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (m, body) {
            var form = body.querySelector("form");
            var v = form._getValues();
            var payload = {
              name: { en: v.nameEn, ar: v.nameAr },
              description: { en: v.descriptionEn, ar: v.descriptionAr },
              color: v.color
            };
            if (isEdit) PMS.repos.departments.update(dept.id, payload);
            else PMS.repos.departments.add(payload);
            PMS.modal.close();
            if (onSaved) onSaved();
          }
        }
      ]
    });
  }

  function openPersonEditor(person, onSaved) {
    if (!canOpenPerson()) return;
    var isEdit = !!person;
    var isAdmin = PMS.auth && PMS.auth.isAdmin ? PMS.auth.isAdmin() : false;
    PMS.modal.open({
      title: isEdit ? t("people.editPerson") : t("people.addPerson"),
      size: "sm",
      content: function () {
        var wrap = PMS.forms.build(personSchema(), person || { status: "active" });
        // The admin only creates login accounts (account creation sends a
        // password-reset email / needs an existing admin session).
        if (!isEdit && !isAdmin && PMS.auth) {
          var note = h("p.u-muted", { text: t("people.onlyAdminCreatesAccount"), style: { marginBlockStart: "10px", fontSize: "0.78rem" } });
          wrap.appendChild(note);
        }
        return wrap;
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var form = body.querySelector("form");
            var v = form._getValues();
            var payload = {
              name: v.name, jobTitle: v.jobTitle, departmentId: v.departmentId || null,
              email: v.email, phone: v.phone, status: v.status || "active", notes: v.notes
            };
            var check = PMS.validation.check("person", payload);
            if (!check.valid) return toastFirstError(form, check.errors, personSchema());
            var prev = isEdit ? PMS.repos.people.get(person.id) : null;
            var saved;
            if (isEdit) { PMS.repos.people.update(person.id, payload); saved = PMS.repos.people.get(person.id); }
            else { saved = PMS.repos.people.add(payload); }
            if (isAdmin) syncPersonAccount(saved, prev);
            PMS.modal.close();
            if (onSaved) onSaved();
          }
        }
      ]
    });
  }

  // Every person must be able to sign in: saving a person (admin only) ensures
  // a login account exists for their email and keeps it in sync with the
  // person's active status. Cloud accounts are created through the trusted
  // backend callable so the caller's own browser session is never hijacked.
  function syncPersonAccount(person, prev) {
    if (!person || !person.id) return;
    var email = String(person.email || "").trim().toLowerCase();
    var acc = PMS.auth.userByPersonId(person.id) || (email ? PMS.auth.byUsername(email) : null);
    if (acc) {
      var uPatch = { personId: person.id };
      if (email && acc.username !== email) uPatch.username = email;
      if (person.status === "inactive" && acc.active !== false) uPatch.active = false;
      if (person.status !== "inactive" && acc.active === false) uPatch.active = true;
      if (person.name && acc.name !== person.name) uPatch.name = person.name;
      PMS.auth.updateUser(acc.id, uPatch);
      if (acc.cloudUid) {
        if (acc.personId !== person.id && PMS.cloudsync && PMS.cloudsync.setCloudPersonId) {
          PMS.cloudsync.setCloudPersonId(acc.cloudUid, person.id).catch(function () {});
        }
        if (uPatch.username) {
          PMS.cloudsync.setCloudEmail(acc.cloudUid, email).catch(function () {
            PMS.auth.updateUser(acc.id, { username: prev && prev.email ? String(prev.email).trim().toLowerCase() : acc.username });
            // keep lockstep: the person's profile email IS the sign-in email,
            // so on a failed cloud change roll the profile email back too —
            // never leave a half-applied edit behind (free plan => no callable)
            if (prev && prev.email && PMS.repos && PMS.repos.people) {
              var lp = PMS.repos.people.get(person.id);
              if (lp) PMS.repos.people.update(person.id, { email: String(prev.email).trim().toLowerCase() });
            }
            if (PMS.router) PMS.router.handle();
            PMS.toast.show(t("people.emailSyncFail"), "error");
          });
        }
        if (uPatch.active !== undefined && PMS.cloudsync && PMS.cloudsync.setCloudActive) {
          PMS.cloudsync.setCloudActive(acc.cloudUid, person.status !== "inactive").catch(function () {});
        }
      }
      return;
    }
    createPersonAccount(person);
  }

  function createPersonAccount(person) {
    var email = String(person.email || "").trim().toLowerCase();
    if (!email) { PMS.toast.show(t("people.accountNeedsEmail"), "error"); return; }
    if (PMS.auth.byUsername(email)) { PMS.toast.show(t("auth.duplicateEmail"), "error"); return; }
    if (PMS.cloudsync && PMS.cloudsync.isEnabled && PMS.cloudsync.isEnabled() && PMS.cloudsync.createMemberAccount) {
      PMS.cloudsync.createMemberAccount({ email: email, name: person.name, personId: person.id, active: person.status !== "inactive" })
        .then(function () {
          if (PMS.cloudsync.resetPassword) PMS.cloudsync.resetPassword(email).then(function () {
            PMS.toast.show(t("people.accountInviteSent", { email: email }), "success");
          }, function () {
            PMS.toast.show(t("people.accountCreatedNoMail"), "error");
          });
        })
        .catch(function (err) {
          if (err && err.userCode === "backendRequired") { createLocalAccount(person, email); return; }
          if (err && err.message === "EMAIL_IN_USE") { PMS.toast.show(t("auth.duplicateEmail"), "error"); return; }
          if (err && err.message === "NOT_AN_ADMIN") { PMS.toast.show(t("auth.forbidden"), "error"); return; }
          PMS.toast.show(PMS.authUI ? PMS.authUI.errorMessage("generic") : t("auth.forbidden"), "error");
        });
      return;
    }
    createLocalAccount(person, email);
  }

  function createLocalAccount(person, email) {
    if (PMS.auth.byUsername(email)) { PMS.toast.show(t("auth.duplicateEmail"), "error"); return; }
    var pw = Math.random().toString(36).slice(2, 10) + "Z1!";
    var res = PMS.auth.createUser({ username: email, password: pw, name: person.name, personId: person.id, active: person.status !== "inactive" });
    if (res && res.error) { PMS.toast.show(PMS.authUI ? PMS.authUI.errorMessage(res.error) : t("auth.forbidden"), "error"); return; }
    // Best effort: send the password-reset link straight from the browser SDK when
    // Firebase Auth is configured — no cloud function and no paid plan required.
    // (Succeeds when a matching cloud account already exists.)
    if (PMS.cloudsync && PMS.cloudsync.isEnabled && PMS.cloudsync.isEnabled() && PMS.cloudsync.resetPassword) {
      PMS.cloudsync.resetPassword(email).then(function () {
        PMS.toast.show(t("people.accountInviteSent", { email: email }), "success");
      }, function () {
        showLocalPassword(email, pw);
      });
      return;
    }
    showLocalPassword(email, pw);
  }

  function showLocalPassword(email, pw) {
    var code = h("code.local-pw-block", {
      text: pw,
      style: { display: "block", fontSize: "1.4em", padding: "8px", borderRadius: "8px", marginTop: "8px", textAlign: "center", background: "var(--bg-subtle)", border: "1px dashed var(--border)", userSelect: "all" }
    });
    PMS.modal.open({
      title: t("people.accountTempTitle"),
      content: h("div", [
        h("p", { text: t("people.accountTempIntro", { email: email }) }),
        h("p.u-bold", { text: t("people.accountTempPass") }),
        code
      ]),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("people.accountTempCopy"), class: "btn-primary", onClick: function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(pw).then(function () {
              PMS.toast.show(t("people.accountTempCopied"), "success"); PMS.modal.close();
            }, function () { PMS.modal.close(); });
          } else {
            var range = document.createRange(); range.selectNodeContents(code);
            var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            PMS.modal.close();
          }
        } }
      ]
    });
  }

  function openProjectEditor(project, opts) {
    if (!canOpenProject(project)) return;
    opts = opts || {};
    var isEdit = !!project;
    var manager = PMS.auth && PMS.auth.currentUser() ? PMS.auth.currentUser() : null;
    var isManager = manager && manager.role === "manager";
    PMS.modal.open({
      title: isEdit ? t("projects.editProject") : t("projects.newProject"),
      size: "lg",
      content: function () {
        return buildFormSafely(function () {
          var sch = projectSchema(isManager, isEdit);
          // merge custom fields into schema
          PMS.repos.fields.forEntity("project").forEach(function (f) {
            sch.push({ key: "cf_" + f.id, label: PMS.i18n.trilingual(f.label)(f.label), fieldType: f.type, options: f.options, full: true });
          });
          var vals = PMS.utils.deepClone(project || {});
          // managers become the manager of any new project they create
          if (!isEdit && isManager && (!vals.managerId)) vals.managerId = manager.personId || "";
          if (project) Object.keys(project.customFields || {}).forEach(function (k) { vals["cf_" + k] = project.customFields[k]; });
          return PMS.forms.build(sch, vals);
        });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            if (isEdit && PMS.auth && PMS.auth.canEditProject && !PMS.auth.canEditProject(project)) { deny(); return; }
            var form = body.querySelector("form");
            var v = form._getValues();
            // strip cf_ into customFields
            var cf = {};
            Object.keys(v).forEach(function (k) { if (k.indexOf("cf_") === 0) cf[k.slice(3)] = v[k]; });
            var payload = {
              name: v.name, description: v.description, parentId: v.parentId || null,
              status: v.status || "planned", priority: v.priority || "medium",
              managerId: v.managerId || null, memberIds: v.memberIds || [],
              startDate: v.startDate, endDate: v.endDate, budget: v.budget,
              weight: v.weight === "" || v.weight === undefined || v.weight === null ? 1 : Number(v.weight),
              tags: v.tags || [], links: parseLinks(v.links), notes: v.notes, customFields: cf
            };
            var check = PMS.validation.check("project", payload);
            if (!check.valid) return toastFirstError(form, check.errors, projectSchema());
            if (isEdit) PMS.repos.projects.update(project.id, payload);
            else PMS.repos.projects.add(payload);
            PMS.modal.close();
            if (opts.onSaved) opts.onSaved(payload);
          }
        }
      ]
    });
  }

  function openTaskEditor(task, opts) {
    if (!canOpenTask(task, opts)) return;
    opts = opts || {};
    var isEdit = !!task;
    // Full edits need the write permission AND edit rights on this very task
    // (admins: every task; managers/members: their assigned tasks).
    var canFull = PMS.auth ? (!!PMS.auth.can("tasks.write") && !!PMS.auth.canEditTask(task)) : true;
    // Status-only editor for everyone who lacks full edit rights on this task:
    // members on assigned tasks, managers on tasks inside their own projects.
    var restricted = isEdit && !canFull;
    // Managers own every pillar now, so no project list restriction is needed.
    var allowedProjects = null;
    if (!PMS.auth) { /* no auth: full access */ }
    PMS.modal.open({
      title: isEdit ? t("tasks.editTask") : t("tasks.newTask"),
      size: "lg",
      content: function () {
        return buildFormSafely(function () {
          var sch = restricted ? statusOnlyTaskEditor() : taskSchema(allowedProjects, task && task.id);
          PMS.repos.fields.forEntity("task").forEach(function (f) {
            sch.push({ key: "cf_" + f.id, label: PMS.i18n.trilingual(f.label)(f.label), fieldType: f.type, options: f.options, full: true });
          });
          var vals = PMS.utils.deepClone(task || {});
          if (opts.defaults) Object.assign(vals, opts.defaults);
          if (task) Object.keys(task.customFields || {}).forEach(function (k) { vals["cf_" + k] = task.customFields[k]; });
          return PMS.forms.build(sch, vals);
        });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var form = body.querySelector("form");
            var v = form._getValues();
            if (!v.title && !restricted) {
              var firstInput = form.querySelectorAll(".field")[0].querySelector("input");
              if (firstInput) firstInput.classList.add("invalid");
              PMS.toast.show(t("validation.titleRequired"), "error");
              return;
            }
            var payload;
            if (restricted) {
              // status-only: never touch anything else
              payload = { status: v.status || task.status || "todo" };
            } else {
              var cf = {};
              Object.keys(v).forEach(function (k) { if (k.indexOf("cf_") === 0) cf[k.slice(3)] = v[k]; });
              // a task created from a meeting keeps the back-link (there is no
              // meeting field in the editor, so it is carried over as-is)
              var meetingId = (opts.defaults && opts.defaults.meetingId) || (task && task.meetingId) || null;
              payload = {
                title: v.title, description: v.description, projectId: v.projectId || null,
                parentTaskId: v.parentTaskId || null, status: v.status || "todo",
                priority: v.priority || "medium", assignees: v.assignees || [],
                startDate: v.startDate, dueDate: v.dueDate,
                estimatedHours: v.estimatedHours || 0, actualHours: v.actualHours || 0,
                tags: v.tags || [], customFields: cf, meetingId: meetingId
              };
            }
            if (isEdit) {
              if (restricted) {
                // status-only path: gate with the status permission
                if (PMS.auth && !PMS.auth.canChangeStatus(task)) { deny(); return; }
                PMS.repos.tasks.update(task.id, payload);
              } else {
                if (!PMS.auth || PMS.auth.canEditTask(task)) PMS.repos.tasks.update(task.id, payload);
                else { deny(); return; }
                // task-to-task links are stored on BOTH sides, so apply the diff
                applyLinkDiff(task, v.linkedTaskIds || []);
              }
            } else {
              if (!PMS.auth || PMS.auth.canCreateTask(payload.projectId)) {
                var created = PMS.repos.tasks.add(payload);
                (v.linkedTaskIds || []).forEach(function (id) { PMS.repos.tasks.link(created.id, id); });
              } else { deny(); return; }
            }
            PMS.modal.close();
            if (opts.onSaved) opts.onSaved(payload);
          }
        }
      ]
    });
  }

  // Keeps both sides of a task-to-task link in step after the editor saved
  // the picked list (added links are mirrored, removed links are dropped).
  function applyLinkDiff(task, nextIds) {
    var prev = (task.linkedTaskIds || []).slice();
    var next = nextIds.filter(function (id, i) { return id && id !== task.id && nextIds.indexOf(id) === i; });
    next.forEach(function (id) {
      if (prev.indexOf(id) === -1) PMS.repos.tasks.link(task.id, id);
    });
    prev.forEach(function (id) {
      if (next.indexOf(id) === -1) PMS.repos.tasks.unlink(task.id, id);
    });
  }

  function openMeetingEditor(meeting, opts) {
    if (!canOpenMeeting(meeting)) { if (PMS.auth) deny(); return; }
    opts = opts || {};
    var isEdit = !!meeting;
    PMS.modal.open({
      title: isEdit ? t("meetings.editMeeting") : t("meetings.newMeeting"),
      size: "lg",
      content: function () {
        return buildFormSafely(function () {
          var vals = PMS.utils.deepClone(meeting || {});
          if (opts.defaults) Object.assign(vals, opts.defaults);
          if (!vals.date) vals.date = PMS.utils.todayISO();
          return PMS.forms.build(meetingSchema(), vals);
        });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var form = body.querySelector("form");
            var v = form._getValues();
            if (!v.title) {
              var firstInput = form.querySelectorAll(".field")[0].querySelector("input");
              if (firstInput) firstInput.classList.add("invalid");
              PMS.toast.show(t("validation.titleRequired"), "error");
              return;
            }
            var payload = {
              title: v.title, date: v.date || null, time: v.time || null, location: v.location || null,
              attendees: v.attendees || [], agenda: v.agenda || [], projectIds: v.projectIds || [],
              attachments: v.attachments || [],
              notes: v.notes || ""
            };
            var saved;
            if (isEdit) { PMS.repos.meetings.update(meeting.id, payload); saved = PMS.repos.meetings.get(meeting.id); }
            else saved = PMS.repos.meetings.add(payload);
            PMS.modal.close();
            if (opts.onSaved) opts.onSaved(saved, payload);
          }
        }
      ]
    });
  }

  function parseLinks(str) {    if (Array.isArray(str)) return str;
    return (str || "").split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (url) {
      return /^https?:\/\//.test(url) ? url : "https://" + url;
    });
  }

  // Build a modal form defensively: a bad row of data must never leave the
  // editor silently empty ("nothing happens"). Surface the error instead.
  function buildFormSafely(fn) {
    try {
      return fn();
    } catch (e) {
      var msg = (e && e.message) || String(e);
      PMS.toast.show(msg, "error");
      return h("div.empty-state", [h("div", { text: msg })]);
    }
  }

  function toastFirstError(form, errors, schema) {
    // highlight fields with data-key matching error, then toast
    PMS.modal.body.querySelectorAll(".field-wrap input, .field-wrap select, .field-wrap textarea").forEach(function (el) { el.classList.remove("invalid"); });
    errors.forEach(function (err) {
      var wrap = form.querySelector('.field[data-key="' + err + '"]');
      if (wrap) wrap.querySelectorAll("input,select,textarea").forEach(function (el) { el.classList.add("invalid"); });
    });
    PMS.toast.show(t("errors.generic"), "error");
  }

  PMS.accounts = {
    createForPerson: createPersonAccount,
    setActiveForPerson: function (person) {
      if (!person || !PMS.auth || !PMS.auth.isAdmin || !PMS.auth.isAdmin()) return;
      var acc = PMS.auth.userByPersonId(person.id);
      if (!acc) return;
      var active = person.status !== "inactive";
      PMS.auth.updateUser(acc.id, { active: active });
      if (acc.cloudUid && PMS.cloudsync && PMS.cloudsync.setCloudActive) {
        PMS.cloudsync.setCloudActive(acc.cloudUid, active).catch(function () {});
      }
    }
  };

  PMS.editors = {
    fieldOptions: fieldOptions,
    canOpenTask: canOpenTask,
    canOpenPerson: canOpenPerson,
    canOpenProject: canOpenProject,
    canOpenDepartment: canOpenDepartment,
    canOpenMeeting: canOpenMeeting,
    loadSampleData: function () {
      if (PMS.seed && PMS.seed.load) return PMS.seed.load();
      return Promise.resolve();
    },
    openDepartmentEditor: openDepartmentEditor,
    openPersonEditor: openPersonEditor,
    openProjectEditor: openProjectEditor,
    openTaskEditor: openTaskEditor,
    openMeetingEditor: openMeetingEditor,
    parseLinks: parseLinks,
    fieldSchema: function (entity) {
      if (entity === "task") return taskSchema();
      if (entity === "project") return projectSchema();
      if (entity === "person") return personSchema();
      if (entity === "meeting") return meetingSchema();
      return [];
    }
  };
})(window.PMS);