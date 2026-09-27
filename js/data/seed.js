/* ==========================================================================
   PMS.seed - sample data generation for demo purposes.
   Loads or replaces the current store with a rich (tree + tasks + people)
   dataset so the whole UI can be exercised:
   - nested projects, multi-status workflows, dependencies, budgets
   - hours (estimated/actual), custom field values, tags, notes, comments
   - overdue tasks, tasks with only one date, tasks with no dates
   ========================================================================== */
(function (PMS) {
  "use strict";

  var U = PMS.utils;

  function build() {
    var data = PMS.schema.defaultData();
    var now = U.nowISO();
    var days = 86400000;
    var today = new Date(); today.setHours(0, 0, 0, 0);

    function iso(offsetDays) {
      return U.toISODate(new Date(today.getTime() + offsetDays * days));
    }

    // ------- custom fields (defined early so tasks can hold values) -------
    var cfStory = PMS.ids.uuid();
    var cfClient = PMS.ids.uuid();
    var cfTicket = PMS.ids.uuid();
    data.customFieldDefs = [
      { id: cfStory, entity: "task", label: { en: "Story points", ar: "نقاط القصة" }, type: "number", options: [], order: 1 },
      { id: cfClient, entity: "project", label: { en: "Client", ar: "العميل" }, type: "text", options: [], order: 1 },
      { id: cfTicket, entity: "task", label: { en: "Ticket ID", ar: "رقم التذكرة" }, type: "text", options: [], order: 2 }
    ];

    // ------- departments -------
    var deps = [
      { id: PMS.ids.uuid(), name: { en: "Engineering", ar: "الهندسة" }, description: { en: "Software & development", ar: "البرمجيات والتطوير" }, color: "#2563eb" },
      { id: PMS.ids.uuid(), name: { en: "Design", ar: "التصميم" }, description: { en: "UX / UI design", ar: "تصميم تجربة وسطح المستخدم" }, color: "#db2777" },
      { id: PMS.ids.uuid(), name: { en: "Marketing", ar: "التسويق" }, description: { en: "Marketing & growth", ar: "التسويق والنمو" }, color: "#ea580c" },
      { id: PMS.ids.uuid(), name: { en: "Operations", ar: "العمليات" }, description: { en: "Ops & logistics", ar: "العمليات واللوجستيات" }, color: "#0891b2" }
    ];
    data.departments = deps.map(function (d) { return Object.assign({ createdAt: now, updatedAt: now }, d); });

    // ------- people -------
    var people = [
      { name: "Sara Ahmed", jobTitle: "Tech Lead", dept: 0, email: "sara@example.com", phone: "+9623", status: "active" },
      { name: "Omar Khalil", jobTitle: "Frontend Dev", dept: 0, email: "omar@example.com", phone: "+9624", status: "active" },
      { name: "Lina Haddadin", jobTitle: "Backend Dev", dept: 0, email: "lina@example.com", phone: "+9625", status: "active" },
      { name: "Nour Salameh", jobTitle: "UX Designer", dept: 1, email: "nour@example.com", phone: "+9626", status: "active" },
      { name: "Rami Nasser", jobTitle: "Motion Designer", dept: 1, email: "rami@example.com", phone: "+9627", status: "active" },
      { name: "Khaled Mansour", jobTitle: "Product Manager", dept: 2, email: "khaled@example.com", phone: "+9628", status: "active" },
      { name: "Rania Barakat", jobTitle: "Growth Marketer", dept: 2, email: "rania@example.com", phone: "+9629", status: "active" },
      { name: "Ali Yousef", jobTitle: "QA Engineer", dept: 3, email: "ali@example.com", phone: "+9630", status: "active" },
      { name: "Dana Haddad", jobTitle: "Ops Coordinator", dept: 3, email: "dana@example.com", phone: "+9631", status: "inactive" }
    ];
    data.people = people.map(function (p, i) {
      return {
        id: PMS.ids.uuid(), name: p.name, jobTitle: p.jobTitle,
        departmentId: deps[p.dept].id, email: p.email, phone: p.phone,
        status: p.status, notes: "",
        createdAt: now, updatedAt: now
      };
    });
    function person(name) { return data.people.find(function (p) { return p.name === name; }); }

    // ------- projects (nested) -------
    function mapCf(cf) {
      var m = {};
      if (!cf) return m;
      if (cf.story !== undefined) m[cfStory] = cf.story;
      if (cf.ticket !== undefined) m[cfTicket] = cf.ticket;
      if (cf.client !== undefined) m[cfClient] = cf.client;
      Object.keys(cf).forEach(function (k) {
        if (k !== "story" && k !== "ticket" && k !== "client") m[k] = cf[k];
      });
      return m;
    }
    function makeProject(name, parent, opts) {
      var p = {
        id: PMS.ids.uuid(), parentId: parent ? parent.id : null, name: name,
        description: (opts.description || "Sample " + name + " project"),
        status: opts.status || "active", priority: opts.priority || "medium",
        managerId: opts.managerId || person("Sara Ahmed").id,
        memberIds: (opts.members || []).map(function (m) { return person(m).id; }),
        startDate: opts.start || iso(opts.startOffset !== undefined ? opts.startOffset : -10),
        endDate: opts.end || iso(opts.endOffset !== undefined ? opts.endOffset : 60),
        budget: opts.budget != null ? opts.budget : 50000,
        weight: opts.weight != null ? opts.weight : 1,
        tags: opts.tags || ["sample"], links: [], notes: "",
        customFields: mapCf(opts.cf || {}),
        createdAt: now, updatedAt: now
      };
      data.projects.push(p);
      return p;
    }

    var web = makeProject("Website Redesign", null, { status: "active", priority: "high", budget: 120000, weight: 3, members: ["Omar Khalil", "Nour Salameh", "Rania Barakat"], tags: ["web", "2026"], cf: { client: "Acme Corp" } });
    var mobile = makeProject("Mobile App", null, { status: "active", priority: "high", budget: 250000, weight: 2, members: ["Omar Khalil", "Lina Haddadin", "Nour Salameh"], tags: ["mobile"], cf: { client: "Nova Bank" } });
    makeProject("Mobile App / Backend", mobile, { status: "active", priority: "high", budget: 120000, members: ["Lina Haddadin", "Ali Yousef"], tags: ["backend"], cf: { client: "Nova Bank" } });
    makeProject("Mobile App / Frontend", mobile, { status: "active", priority: "medium", budget: 90000, members: ["Omar Khalil", "Nour Salameh"], tags: ["frontend"], cf: { client: "Nova Bank" } });
    var ops = makeProject("Operations Dashboard", null, { status: "active", priority: "urgent", budget: 60000, weight: 2.5, managerId: person("Ali Yousef").id, members: ["Ali Yousef", "Dana Haddad", "Rania Barakat"], tags: ["ops", "kpi"], cf: { client: "Internal" } });

    // ------- tasks -------
    function addTask(proj, title, o) {
      o = o || {};
      var t = {
        id: PMS.ids.uuid(), projectId: proj.id, parentTaskId: o.parentTaskId || null,
        title: title, description: o.desc || "Sample task",
        status: o.status || "todo", priority: o.priority || "medium",
        assignees: (o.assignees || []).map(function (n) { return person(n).id; }),
        startDate: o.noStart ? null : (o.startOffset !== undefined ? iso(o.startOffset) : iso(-5)),
        dueDate: o.noDue ? null : (o.dueOffset !== undefined ? iso(o.dueOffset) : iso(10)),
        estimatedHours: o.est !== undefined ? o.est : 8,
        actualHours: o.actual !== undefined ? o.actual : 0,
        progress: o.status === "done" ? 100 : (o.prog !== undefined ? o.prog : 30),
        tags: o.tags || ["sample"], checklist: [], comments: [], activity: [],
        dependencies: o.deps || [], customFields: mapCf(o.cf || {}),
        createdAt: now, updatedAt: now
      };
      data.tasks.push(t);
      return t;
    }

    // Website Redesign tasks
    var w1 = addTask(web, "Design new hero section", { status: "done", priority: "high", assignees: ["Nour Salameh"], est: 16, actual: 18, dueOffset: -2, tags: ["design"], cf: { story: 5, ticket: "WEB-1" } });
    var w2 = addTask(web, "Build design system", { status: "inprogress", priority: "high", assignees: ["Nour Salameh", "Omar Khalil"], est: 40, actual: 22, dueOffset: 8, tags: ["design", "ui"], cf: { story: 13, ticket: "WEB-2" } });
    addTask(web, "Dark mode tokens", { parentTaskId: w2.id, status: "inprogress", priority: "medium", assignees: ["Omar Khalil"], est: 12, dueOffset: 6, cf: { story: 5, ticket: "WEB-3" } });
    addTask(web, "Cards & typography", { parentTaskId: w2.id, status: "done", priority: "medium", assignees: ["Nour Salameh"], est: 20, actual: 24, dueOffset: -5, cf: { story: 8 } });
    var w3 = addTask(web, "Migrate CMS content", { status: "review", priority: "medium", assignees: ["Rania Barakat"], est: 24, actual: 20, dueOffset: 12, tags: ["content"], cf: { story: 8, ticket: "WEB-4" } });

    // Mobile App tasks
    var m1 = addTask(mobile, "Set up monorepo", { status: "done", priority: "high", assignees: ["Omar Khalil", "Lina Haddadin"], est: 16, actual: 12, dueOffset: -6, tags: ["infra"] });
    addTask(mobile, "API gateway", { parentTaskId: m1.id, status: "done", priority: "high", assignees: ["Lina Haddadin"], est: 24, actual: 28, dueOffset: -3, cf: { ticket: "APP-1" } });
    addTask(mobile, "Auth flows", { parentTaskId: m1.id, status: "inprogress", priority: "urgent", assignees: ["Lina Haddadin"], est: 32, actual: 14, dueOffset: 5, tags: ["security"] });
    var m2 = addTask(mobile, "Push notifications", { status: "todo", priority: "medium", assignees: ["Lina Haddadin", "Ali Yousef"], est: 20, dueOffset: 20 });
    addTask(mobile, "Sprint planning", { status: "done", priority: "low", assignees: ["Sara Ahmed"], est: 4, actual: 4, dueOffset: -10 });

    // Operations Dashboard tasks (varied edge cases)
    addTask(ops, "Deploy metrics pipeline", { status: "done", priority: "high", assignees: ["Ali Yousef"], est: 30, actual: 26, dueOffset: -9, tags: ["ops"] });
    var late1 = addTask(ops, "Alerting thresholds", { status: "todo", priority: "urgent", assignees: ["Ali Yousef"], est: 16, dueOffset: -3, tags: ["ops"], cf: { ticket: "OPS-1" } });
    var onTime = addTask(ops, "Dashboard UI", { status: "inprogress", priority: "medium", assignees: ["Dana Haddad", "Rami Nasser"], est: 24, actual: 6, dueOffset: 9, cf: { story: 8, ticket: "OPS-2" } });
    addTask(ops, "Docs pass", { status: "todo", priority: "low", assignees: ["Rania Barakat"], est: 6, noStart: true, noDue: true, tags: ["docs"] });
    addTask(ops, "License renewal", { status: "review", priority: "high", assignees: ["Sara Ahmed"], est: 4, noStart: true, dueOffset: 4 });
    addTask(ops, "Data retention backup", { parentTaskId: onTime.id, status: "todo", priority: "medium", assignees: ["Ali Yousef"], est: 8, dueOffset: 12 });

    // dependencies to visualize in gantt
    w3.dependencies = [w2.id];
    m2.dependencies = [m1.id];
    late1.dependencies = [w3.id];

    // a few comments + activity + checklist
    w2.comments = [{ id: PMS.ids.uuid(), authorId: person("Nour Salameh").id, text: "Tokens look great so far", createdAt: now }];
    w2.activity = [{ id: PMS.ids.uuid(), action: "created", at: now }];
    w2.checklist = [
      { id: PMS.ids.uuid(), text: "Color ramp", done: true },
      { id: PMS.ids.uuid(), text: "Type scale", done: true },
      { id: PMS.ids.uuid(), text: "Spacing grid", done: false }
    ];

    // ------- settings -------
    data.settings.lang = PMS.i18n.getLang() || "en";
    data.settings.theme = "light";
    data.meta.updatedAt = now;

    return data;
  }

  function load() {
    // ZMS-R16: demo data is a sensitive bulk action — requires a freshly
    // re-authenticated admin session (password) in production. Tests bypass
    // via window.__ZMS_TEST__. Keep existing accounts so seeding never locks
    // anyone out.
    if (!window.__ZMS_TEST__ && !(PMS.auth && PMS.auth.consumeFreshAdmin())) {
      if (PMS.toast && PMS.toast.show) PMS.toast.show(PMS.i18n.t("confirm.sensitiveRequired"), "error");
      return Promise.resolve(null);
    }
    var fresh = build();
    if (PMS.store.data && Array.isArray(PMS.store.data.users)) fresh.users = U.deepClone(PMS.store.data.users);
    PMS.store.setData(fresh);
    PMS.toast.show(PMS.i18n.t("settings.seedLoaded"), "success");
    return Promise.resolve(fresh);
  }

  PMS.seed = { build: build, load: load };
})(window.PMS);