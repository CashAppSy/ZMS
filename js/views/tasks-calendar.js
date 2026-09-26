/* ==========================================================================
   Tasks Calendar view - month & week modes.
   Route: /tasks/calendar
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var mode = "month";
  var cursor = new Date(); // first of current displayed day (week mode) or month
  cursor.setHours(0, 0, 0, 0);

  var DAY = 24 * 60 * 60 * 1000;

  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

  function startOfWeek(d) {
    var day = d.getDay();
    var diff = day === 0 ? -6 : 1 - day; // week starts Monday
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("tasks.viewCalendar") }));
    var actions = h("div.actions");
    actions.appendChild(PMS.taskModeSwitcher("calendar"));
    header.appendChild(actions);
    container.appendChild(header);

    // toolbar
    var tb = h("div.calendar-toolbar");
    tb.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("calendar.month"), on: { click: function () { mode = "month"; cursor = firstOfMonth(new Date()); render(container); } } }));
    tb.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("calendar.week"), on: { click: function () { mode = "week"; cursor = new Date(); render(container); } } }));
    tb.appendChild(h("span.grow"));
    tb.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.prev"), on: { click: function () { moveCursor(-1); render(container); } } }));
    tb.appendChild(h("button.btn.btn-sm", { text: t("common.today"), on: { click: function () { cursor = new Date(); render(container); } } }));
    tb.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.next"), on: { click: function () { moveCursor(1); render(container); } } }));
    tb.appendChild(h("span.u-bold", { text: PMS.utils.formatDate(PMS.utils.toISODate(cursor), PMS.i18n, { year: "numeric", month: "long" }) }));
    container.appendChild(tb);

    var tasks = PMS.repos.tasks.all();
    if (mode === "month") renderMonth(container, cursor, tasks);
    else renderWeek(container, cursor, tasks);
  }

  function moveCursor(dir) {
    if (mode === "month") cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
    else cursor = new Date(cursor.getTime() + dir * 7 * DAY);
  }

  function taskForDay(tasks, iso) {
    return tasks.filter(function (tsk) {
      var s = tsk.startDate, e = tsk.dueDate;
      if (!s && !e) return false;
      s = s || e; e = e || s;
      return s <= iso && iso <= e;
    });
  }

  function renderMonth(container, base, tasks) {
    var first = firstOfMonth(base);
    var offset = first.getDay() === 0 ? 6 : first.getDay() - 1; // Mon-first

    // weekday labels
    var labels = PMS.i18n.lang === "ar"
      ? ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    var wd = h("div.cal-weekdays");
    labels.forEach(function (l) { wd.appendChild(h("div", { text: l })); });
    container.appendChild(wd);

    var daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    var start = new Date(first.getTime() - offset * DAY);
    var grid = h("div.cal-grid");

    for (var cell = 0; cell < 42; cell++) {
      var day = new Date(start.getTime() + cell * DAY);
      var iso = PMS.utils.toISODate(day);
      var outside = day.getMonth() !== base.getMonth();
      var dayEl = h("div.cal-day" + (iso === PMS.utils.todayISO() ? ".today" : "") + (outside ? ".outside" : ""));
      dayEl.appendChild(h("div.cal-day-num", { text: String(day.getDate()) }));
      var dayTasks = taskForDay(tasks, iso).slice(0, 3);
      dayTasks.forEach(function (tsk) {
        var c = statusColorOf(tsk.status);
        var chip = h("span.cal-task", {
          text: tsk.title,
          style: { background: c },
          on: { click: function () { PMS.taskDetail.open(tsk.id); } }
        });
        dayEl.appendChild(chip);
      });
      if (taskForDay(tasks, iso).length > 3) dayEl.appendChild(h("div.u-muted", { text: "+" + (taskForDay(tasks, iso).length - 3), style: { fontSize: "0.7rem" } }));
      grid.appendChild(dayEl);
    }
    container.appendChild(grid);
  }

  function renderWeek(container, base, tasks) {
    var start = startOfWeek(base);
    var wd = h("div.cal-weekdays");
    var labels = PMS.i18n.lang === "ar"
      ? ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    labels.forEach(function (l) { wd.appendChild(h("div", { text: l })); });
    container.appendChild(wd);

    var grid = h("div.cal-grid");
    for (var i = 0; i < 7; i++) {
      var day = new Date(start.getTime() + i * DAY);
      var iso = PMS.utils.toISODate(day);
      var dayEl = h("div.cal-day" + (iso === PMS.utils.todayISO() ? ".today" : ""));
      dayEl.appendChild(h("div.cal-day-num", { text: day.getDate() + " · " + labels[i] }));
      taskForDay(tasks, iso).forEach(function (tsk) {
        dayEl.appendChild(h("span.cal-task", {
          text: tsk.title,
          style: { background: statusColorOf(tsk.status) },
          on: { click: function () { PMS.taskDetail.open(tsk.id); } }
        }));
      });
      grid.appendChild(dayEl);
    }
    container.appendChild(grid);
  }

  function statusColorOf(key) {
    var s = (PMS.store.data.taskStatuses || []).find(function (x) { return x.key === key; });
    return s ? s.color : "#3b82f6";
  }

  var view = {
    id: "tasks-calendar",
    titleKey: "tasks.viewCalendar",
    icon: "▦",
    nav: false,
    render: function (container, params) {
      render(container);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/tasks/calendar") render(container); });
      return function () { off(); };
    }
  };

  PMS.registry.registerView(view);
  PMS.router.register("/tasks/calendar", "tasks-calendar");
})(window.PMS);