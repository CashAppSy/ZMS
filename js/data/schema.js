/* ==========================================================================
   PMS.schema - data model defaults & schema version.
   Seed projects/tasks are produced here so they are valid per the schema.
   Fields: text, number, date, select, multiselect, link, checkbox.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var ids = PMS.ids;

  function stub() {
    return {
      todo: { id: "status-task-todo", key: "todo", color: "#6b7280", pct: 0, order: 1 },
      inprogress: { id: "status-task-inprogress", key: "inprogress", color: "#3b82f6", pct: 45, order: 2 },
      review: { id: "status-task-review", key: "review", color: "#8b5cf6", pct: 75, order: 3 },
      done: { id: "status-task-done", key: "done", color: "#22c55e", pct: 100, order: 4 }
    };
  }

  function defaultData() {
    return {
      schemaVersion: PMS.schema.VERSION,
      departments: [],
      people: [],
      projects: [],
      tasks: [],
      meetings: [],
      users: [],
      customFieldDefs: [],
      activities: [],
      taskStatuses: [
        { id: "status-task-todo", key: "todo", name: { en: "To do", ar: "قيد الانتظار" }, color: "#6b7280", pct: 0, order: 1 },
        { id: "status-task-inprogress", key: "inprogress", name: { en: "In progress", ar: "قيد التنفيذ" }, color: "#3b82f6", pct: 45, order: 2 },
        { id: "status-task-review", key: "review", name: { en: "In review", ar: "قيد المراجعة" }, color: "#8b5cf6", pct: 75, order: 3 },
        { id: "status-task-done", key: "done", name: { en: "Done", ar: "منجزة" }, color: "#22c55e", pct: 100, order: 4 }
      ],
      projectStatuses: [
        { id: "status-project-planned", key: "planned", name: { en: "Planned", ar: "مخطط" }, color: "#64748b", order: 1 },
        { id: "status-project-active", key: "active", name: { en: "Active", ar: "نشط" }, color: "#3b82f6", order: 2 },
        { id: "status-project-onhold", key: "onhold", name: { en: "On hold", ar: "متوقف" }, color: "#f59e0b", order: 3 },
        { id: "status-project-completed", key: "completed", name: { en: "Completed", ar: "مكتمل" }, color: "#22c55e", order: 4 },
        { id: "status-project-cancelled", key: "cancelled", name: { en: "Cancelled", ar: "ملغي" }, color: "#ef4444", order: 5 }
      ],
      priorities: [
        { id: "prio-low", key: "low", name: { en: "Low", ar: "منخفضة" }, color: "#16a34a", order: 1 },
        { id: "prio-medium", key: "medium", name: { en: "Medium", ar: "متوسطة" }, color: "#f59e0b", order: 2 },
        { id: "prio-high", key: "high", name: { en: "High", ar: "عالية" }, color: "#f97316", order: 3 },
        { id: "prio-urgent", key: "urgent", name: { en: "Urgent", ar: "عاجلة" }, color: "#ef4444", order: 4 }
      ],
      settings: {
        lang: "en",
        theme: "light",
        currency: "USD",
        weightByTime: false,
        autoBackupEnabled: true,
        autoBackupEveryMin: 30,
        maxBackups: 5,
        autoSync: true
      },
      savedFilters: [],
      meta: { updatedAt: null }
    };
  }

  PMS.schema = { VERSION: 2, defaultData: defaultData, stub: stub };
})(window.PMS);