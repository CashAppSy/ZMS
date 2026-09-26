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
    // creating a new task is a separate permission (admins: any project,
    // managers: only their own projects)
    if (!task && PMS.auth.canCreateTask(opts && opts.defaults && opts.defaults.projectId)) return true;
    return deny();
  }

  // When a member/manager edits an assigned task they may ONLY change its
  // status (dates, estimates, assignees, ... stay locked).
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
      { key: "email", label: t("people.email"), type: "email" },
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
      { key: "managerId", label: t("projects.manager"), type: "select", options: managerOpts },
      { key: "memberIds", label: t("projects.members"), type: "multiselect", options: people.map(function (p) { return { label: p.name, value: p.id }; }) },
      { key: "startDate", label: t("projects.startDate"), type: "date" },
      { key: "endDate", label: t("projects.endDate"), type: "date" },
      { key: "budget", label: t("projects.budget"), type: "number" },
      { key: "tags", label: t("common.tags"), type: "tags", full: true },
      { key: "links", label: t("projects.links"), type: "text", hint: t("common.typeHere") },
      { key: "notes", label: t("common.notes"), type: "textarea", full: true }
    ];
  }

  function taskSchema(projectFilter) {
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
      { key: "assignees", label: t("tasks.assignees"), type: "multiselect", options: people.map(function (p) { return { label: p.name, value: p.id }; }) },
      { key: "startDate", label: t("tasks.startDate"), type: "date" },
      { key: "dueDate", label: t("tasks.dueDate"), type: "date" },
      { key: "estimatedHours", label: t("tasks.estimated"), type: "number" },
      { key: "actualHours", label: t("tasks.actual"), type: "number" },
      { key: "tags", label: t("common.tags"), type: "tags", full: true }
    ];
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
    PMS.modal.open({
      title: isEdit ? t("people.editPerson") : t("people.addPerson"),
      size: "sm",
      content: function () {
        return PMS.forms.build(personSchema(), person || { status: "active" });
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
            if (isEdit) PMS.repos.people.update(person.id, payload);
            else PMS.repos.people.add(payload);
            PMS.modal.close();
            if (onSaved) onSaved();
          }
        }
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
    var canFull = PMS.auth ? PMS.auth.can("tasks.write") : true;
    // members & managers editing their assigned task -> status-only editor
    var restricted = isEdit && !canFull;
    var allowedProjects = null;
    if (!PMS.auth) { /* no auth: full access */ }
    else if (PMS.auth.currentUser() && PMS.auth.currentUser().role === "manager" && !isEdit) {
      allowedProjects = (PMS.store.data.projects || [])
        .filter(function (p) { return PMS.auth.managesProject(p); })
        .map(function (p) { return p.id; });
    }
    PMS.modal.open({
      title: isEdit ? t("tasks.editTask") : t("tasks.newTask"),
      size: "lg",
      content: function () {
        return buildFormSafely(function () {
          var sch = restricted ? statusOnlyTaskEditor() : taskSchema(allowedProjects);
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
            if (!v.title && !restricted) { form.querySelectorAll(".field")[0].querySelector("input").classList.add("invalid"); return; }
            var payload;
            if (restricted) {
              // status-only: never touch anything else
              payload = { status: v.status || task.status || "todo" };
            } else {
              var cf = {};
              Object.keys(v).forEach(function (k) { if (k.indexOf("cf_") === 0) cf[k.slice(3)] = v[k]; });
              payload = {
                title: v.title, description: v.description, projectId: v.projectId || null,
                parentTaskId: v.parentTaskId || null, status: v.status || "todo",
                priority: v.priority || "medium", assignees: v.assignees || [],
                startDate: v.startDate, dueDate: v.dueDate,
                estimatedHours: v.estimatedHours || 0, actualHours: v.actualHours || 0,
                tags: v.tags || [], customFields: cf
              };
            }
            if (isEdit) {
              if (!PMS.auth || PMS.auth.canEditTask(task)) PMS.repos.tasks.update(task.id, payload);
              else { deny(); return; }
            } else {
              if (!PMS.auth || PMS.auth.canCreateTask(payload.projectId)) PMS.repos.tasks.add(payload);
              else { deny(); return; }
            }
            PMS.modal.close();
            if (opts.onSaved) opts.onSaved(payload);
          }
        }
      ]
    });
  }

  function parseLinks(str) {
    if (Array.isArray(str)) return str;
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

  PMS.editors = {
    fieldOptions: fieldOptions,
    canOpenTask: canOpenTask,
    canOpenPerson: canOpenPerson,
    canOpenProject: canOpenProject,
    canOpenDepartment: canOpenDepartment,
    loadSampleData: function () {
      if (PMS.seed && PMS.seed.load) return PMS.seed.load();
      return Promise.resolve();
    },
    openDepartmentEditor: openDepartmentEditor,
    openPersonEditor: openPersonEditor,
    openProjectEditor: openProjectEditor,
    openTaskEditor: openTaskEditor,
    parseLinks: parseLinks,
    fieldSchema: function (entity) {
      if (entity === "task") return taskSchema();
      if (entity === "project") return projectSchema();
      if (entity === "person") return personSchema();
      return [];
    }
  };
})(window.PMS);