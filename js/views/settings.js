/* ==========================================================================
   Settings view - language, theme, statuses/priorities editors, custom field
   definitions, backups, file binding, JSON import/export, seed data, about.
   Route: /settings
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };

  var section = "general";

  function cloudReady() {
    return !!(PMS.cloudsync && PMS.cloudsync.isConfigured && PMS.cloudsync.isConfigured());
  }

  function render(container) {
    container.innerHTML = "";
    var header = h("div.page-header");
    header.appendChild(h("h1", { text: t("settings.title") }));
    container.appendChild(header);

    var layout = h("div.settings-layout");
    var nav = h("div.settings-nav");
    var sections = [
      ["general", t("settings.general")],
      ["accounts", t("auth.accounts")],
      ["statuses", t("settings.statuses")],
      ["fields", t("settings.fields")],
      ["cloud", t("settings.cloud")],
      ["backup", t("settings.backup")],
      ["file", t("settings.fileBinding")],
      ["about", t("settings.about")]
    ];
    sections.forEach(function (s) {
      var btn = h("button.nav-item" + (section === s[0] ? ".active" : ""), {
        text: s[1],
        on: { click: function () { section = s[0]; render(container); } }
      });
      nav.appendChild(btn);
    });
    layout.appendChild(nav);

    var body = h("div.settings-body");
    switch (section) {
      case "general": renderGeneral(body); break;
      case "accounts": renderAccounts(body); break;
      case "statuses": renderStatuses(body); break;
      case "fields": renderFields(body); break;
      case "cloud": renderCloud(body); break;
      case "backup": renderBackup(body); break;
      case "file": renderFile(body); break;
      case "about": renderAbout(body); break;
    }
    layout.appendChild(body);
    container.appendChild(layout);
  }

  /* ---------------- General ---------------- */
  function renderGeneral(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: t("settings.general") })]));
    var b = h("div.card-body");

    // language
    var langRow = h("div.setting-row");
    var langBlock = h("div");
    langBlock.appendChild(h("div.u-bold", { text: t("settings.language") }));
    langBlock.appendChild(h("div.u-muted", { text: t("common.language") }));
    var langSel = h("select.select", { style: { width: "200px" }, on: { change: function (e) {
      var l = e.target.value;
      PMS.i18n.setLang(l);
      PMS.repos.settings.update({ lang: l });
      PMS.app.applyLocale();
      render(document.getElementById("view-root"));
    } } });
    ["ar", "en"].forEach(function (lg) {
      langSel.appendChild(h("option", { value: lg, text: t("lang." + lg) }));
    });
    langSel.value = PMS.i18n.getLang();
    langRow.appendChild(langBlock);
    langRow.appendChild(langSel);
    b.appendChild(langRow);

    // theme
    var themeRow = h("div.setting-row");
    var themeBlock = h("div");
    themeBlock.appendChild(h("div.u-bold", { text: t("settings.theme") }));
    themeBlock.appendChild(h("div.u-muted", { text: PMS.store.data.settings.theme === "dark" ? t("settings.dark") : t("settings.light") }));
    var themeSel = h("select.select", { style: { width: "200px" }, on: { change: function (e) {
      PMS.repos.settings.update({ theme: e.target.value });
      PMS.app.applyTheme(e.target.value);
    } } });
    themeSel.appendChild(h("option", { value: "light", text: t("settings.light") }));
    themeSel.appendChild(h("option", { value: "dark", text: t("settings.dark") }));
    themeSel.value = PMS.store.data.settings.theme || "light";
    themeRow.appendChild(themeBlock);
    themeRow.appendChild(themeSel);
    b.appendChild(themeRow);

    // weight by time
    var weightRow = h("div.setting-row");
    var weightBlock = h("div");
    weightBlock.appendChild(h("div.u-bold", { text: t("settings.weightByTime") }));
    weightBlock.appendChild(h("div.u-muted", { text: t("settings.general") }));
    var wSwitch = h("label.switch");
    var wInput = h("input", { type: "checkbox", checked: !!PMS.store.data.settings.weightByTime, on: { change: function (e) { PMS.repos.settings.update({ weightByTime: e.target.checked }); } } });
    wSwitch.appendChild(wInput);
    wSwitch.appendChild(h("span.slider"));
    weightRow.appendChild(weightBlock);
    weightRow.appendChild(wSwitch);
    b.appendChild(weightRow);

    // auto-sync from bound file
    var syncRow = h("div.setting-row");
    var syncBlock = h("div");
    syncBlock.appendChild(h("div.u-bold", { text: t("settings.autoSync") }));
    syncBlock.appendChild(h("div.u-muted", { text: t("settings.autoSyncHint") }));
    var isSyncOn = PMS.store.data.settings.autoSync !== false && PMS.fileStorage.status() === "bound";
    var isBounded = PMS.fileStorage.status() === "bound";
    var syncSwitch = h("label.switch");
    var syncInput = h("input", { type: "checkbox", checked: isSyncOn, disabled: !isBounded, on: { change: function (e) {
      PMS.repos.settings.update({ autoSync: e.target.checked });
      if (e.target.checked) { if (PMS.sync) PMS.sync.start(); } else if (PMS.sync) PMS.sync.stop();
    } } });
    syncSwitch.appendChild(syncInput);
    syncSwitch.appendChild(h("span.slider"));
    syncRow.appendChild(syncBlock);
    syncRow.appendChild(syncSwitch);
    b.appendChild(syncRow);

    // keyboard shortcuts hint
    var kb = h("div.setting-row");
    kb.appendChild(h("div", {}, [
      h("div.u-bold", { text: t("settings.keyboardShortcuts") }),
      h("div.u-muted", { text: t("settings.shortcuts.newTask") + " · " + t("settings.shortcuts.newProject") + " · " + t("settings.shortcuts.focusSearch") + " · " + t("settings.shortcuts.undo") + " · " + t("settings.shortcuts.redo") })
    ]));
    b.appendChild(kb);

    card.appendChild(b);
    body.appendChild(card);
  }

  /* ---------------- Statuses & priorities ---------------- */
  function statusListEditor(body, title, list, onSave, isStatus, defaults) {
    var card = h("div.card", { style: { marginBlockEnd: "16px" } });
    card.appendChild(h("div.card-header", [
      h("div.u-grow.card-title", { text: title }),
      h("button.btn.btn-sm", { text: "+", on: { click: function () {
        var key = prompt(isStatus ? "key (e.g. status" + (list.length + 1) + "):" : "key:");
        if (!key) return;
        var en = prompt("English name:");
        var ar = prompt("Arabic name:");
        var color = prompt("Color (hex):", PMS.utils.colorForSeed(key));
        var entry = { id: PMS.ids.uuid(), key: key, name: { en: en || key, ar: ar || key }, color: color || "#6b7280", order: list.length + 1 };
        onSave(list.concat([entry]));
        render(document.getElementById("view-root"));
      } } })
    ]));
    var b = h("div.card-body");
    if (!list.length) {
      b.appendChild(h("p.u-muted", { text: t("settings.noStatuses"), style: { margin: "0 0 8px" } }));
      if (defaults && defaults.length) {
        b.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("settings.restoreDefaults"), on: { click: function () {
          onSave(PMS.utils.deepClone(defaults));
          render(document.getElementById("view-root"));
        } } }));
      }
    }
    list.forEach(function (item) {
      var row = h("div.setting-row");
      var left = h("div.u-flex", { style: { gap: "8px" } });
      left.appendChild(h("span.badge-dot", { style: { background: item.color, width: "14px", height: "14px", borderRadius: "4px" } }));
      left.appendChild(h("span.u-bold", { text: PMS.i18n.trilingual(item.name)(item.name) }));
      left.appendChild(h("span.u-muted", { text: " (" + item.key + ") · EN: " + (item.name.en || "") + " · AR: " + (item.name.ar || "") }));
      row.appendChild(left);
      var right = h("div.u-flex");
      right.appendChild(h("button.btn.btn-sm.btn-icon", { text: "✎", on: { click: function () { editStatusItem(item, list, onSave); } } }));
      right.appendChild(h("button.btn.btn-sm.btn-icon.btn-soft-danger", { text: "✕", on: { click: function () {
        onSave(list.filter(function (x) { return x.id !== item.id; }));
        render(document.getElementById("view-root"));
      } } }));
      row.appendChild(right);
      b.appendChild(row);
    });
    card.appendChild(b);
    body.appendChild(card);
  }

  function editStatusItem(item, list, onSave) {
    PMS.modal.open({
      title: t("common.edit"),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "key", label: "Key", type: "text", required: true },
          { key: "nameEn", label: "English name", type: "text", required: true },
          { key: "nameAr", label: "Arabic name", type: "text" },
          { key: "color", label: "Color", type: "input", placeholder: "#2563eb" }
        ], { key: item.key, nameEn: item.name.en, nameAr: item.name.ar || "", color: item.color });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.save"), class: "btn-primary", onClick: function (m, body) {
          var v = body.querySelector("form")._getValues();
          var updated = list.map(function (x) {
            return x.id === item.id ? Object.assign({}, x, { key: v.key, name: { en: v.nameEn, ar: v.nameAr }, color: v.color || x.color }) : x;
          });
          onSave(updated);
          PMS.modal.close();
          render(document.getElementById("view-root"));
        } }
      ]
    });
  }

  function renderStatuses(body) {
    var defs = PMS.schema.defaultData();
    statusListEditor(body, t("settings.taskStatuses"), PMS.store.data.taskStatuses || [], function (l) { PMS.repos.statuses.setTask(l); }, true, defs.taskStatuses);
    statusListEditor(body, t("settings.projectStatuses"), PMS.store.data.projectStatuses || [], function (l) { PMS.repos.statuses.setProject(l); }, true, defs.projectStatuses);
    statusListEditor(body, t("settings.priorities"), PMS.store.data.priorities || [], function (l) { PMS.repos.priorities.set(l); }, false, defs.priorities);
  }

  /* ---------------- Custom fields ---------------- */
  function renderFields(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [
      h("div.u-grow.card-title", { text: t("settings.customFields") }),
      h("button.btn.btn-primary.btn-sm", { text: "+ " + t("settings.addField"), on: { click: function () { editField(null); } } })
    ]));
    var b = h("div.card-body");
    var fields = PMS.repos.fields.all();
    if (!fields.length) b.appendChild(h("div.u-muted", { text: t("common.noResults") }));
    fields.forEach(function (f) {
      var row = h("div.setting-row");
      var left = h("div", {}, [
        h("div.u-bold", { text: PMS.i18n.trilingual(f.label)(f.label) }),
        h("div.u-muted", { text: t("settings.fieldTypes." + f.type) + " · " + (f.entity === "task" ? t("settings.entityTask") : t("settings.entityProject")) + (f.options && f.options.length ? " · " + f.options.join(", ") : "") })
      ]);
      row.appendChild(left);
      var right = h("div.u-flex");
      right.appendChild(h("button.btn.btn-sm.btn-icon", { text: "✎", on: { click: function () { editField(f); } } }));
      right.appendChild(h("button.btn.btn-sm.btn-icon.btn-soft-danger", { text: "✕", on: { click: function () { deleteField(f); } } }));
      row.appendChild(right);
      b.appendChild(row);
    });
    card.appendChild(b);
    body.appendChild(card);
  }

  function editField(field) {
    var isEdit = !!field;
    PMS.modal.open({
      title: isEdit ? t("common.edit") + " " + t("settings.customFields") : t("settings.addField"),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "labelEn", label: t("settings.fieldLabel") + " (EN)", type: "text", required: true },
          { key: "labelAr", label: t("settings.fieldLabel") + " (AR)", type: "text" },
          { key: "entity", label: t("settings.entity"), type: "select", options: [{ label: t("settings.entityTask"), value: "task" }, { label: t("settings.entityProject"), value: "project" }] },
          { key: "type", label: t("settings.fieldType"), type: "select", options: PMS.registry.allFieldTypes().map(function (ft) { return { label: t("settings.fieldTypes." + ft.key), value: ft.key }; }) },
          { key: "options", label: "Options (comma separated)", type: "text", placeholder: "opt1, opt2, opt3" }
        ], {
          labelEn: field ? PMS.i18n.trilingual(field.label)(field.label) : "",
          labelAr: field && field.label.ar ? field.label.ar : "",
          entity: field ? field.entity : "task",
          type: field ? field.type : "text",
          options: (field.options || []).join(", ")
        });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.save"), class: "btn-primary", onClick: function (_, body) {
          var v = body.querySelector("form")._getValues();
          var opts = v.options ? v.options.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
          var fd = {
            entity: v.entity,
            label: { en: v.labelEn, ar: v.labelAr },
            type: v.type,
            options: opts,
            order: field ? field.order : (PMS.repos.fields.all().length + 1)
          };
          if (isEdit) PMS.repos.fields.update(field.id, fd);
          else PMS.repos.fields.add(fd);
          PMS.modal.close();
          render(document.getElementById("view-root"));
        } }
      ]
    });
  }

  function deleteField(field) {
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.deleteField") }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("common.delete"), class: "btn-danger", onClick: function () { PMS.repos.fields.remove(field.id); PMS.modal.close(); render(document.getElementById("view-root")); } }
      ]
    });
  }

  /* ---------------- Cloud sync (Firebase Firestore) ---------------- */
  function renderCloud(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: t("settings.cloud") })]));
    var b = h("div.card-body");
    b.appendChild(h("p.u-muted", { text: t("cloud.intro"), style: { marginBlockEnd: "8px" } }));

    var st = PMS.cloudsync.status();
    var row = h("div.setting-row");
    var embedded = PMS.cloudsync.embedded() && PMS.cloudsync.embedded().projectId;
    var blk = h("div", {}, [
      h("div.u-bold", { text: st.enabled ? t("cloud.connected") : (embedded ? t("cloud.embedded") : (st.projectId ? t("cloud.disconnected") : t("cloud.notConfigured"))) }),
      h("div.u-muted", { text: (st.projectId ? t("cloud.projectId") + ": " + st.projectId : "") + (st.lastSyncAt ? " · " + t("cloud.lastSync") + ": " + PMS.utils.formatDate(new Date(st.lastSyncAt).toISOString(), PMS.i18n) : "") })
    ]);
    row.appendChild(blk);
    var sw = h("label.switch");
    var inp = h("input", { type: "checkbox", checked: !!st.enabled, on: { change: function (e) {
      if (e.target.checked) {
        if (!PMS.cloudsync.isConfigured()) { configModal(); render(document.getElementById("view-root")); return; }
        PMS.cloudsync.enable().then(function () {
          PMS.toast.show(t("cloud.connected"), "success");
          render(document.getElementById("view-root"));
        }).catch(function (err) {
          PMS.toast.show(t("cloud.connectFail") + (err && err.message ? " (" + err.message + ")" : ""), "error");
          render(document.getElementById("view-root"));
        });
      } else {
        PMS.cloudsync.disable().then(function () { render(document.getElementById("view-root")); });
      }
    } } });
    sw.appendChild(inp);
    sw.appendChild(h("span.slider"));
    row.appendChild(sw);
    b.appendChild(row);

    var actions = h("div.u-flex", { style: { gap: "8px", marginTop: "12px" } });
    actions.appendChild(h("button.btn.btn-sm", { text: t("cloud.configure"), on: { click: function () { configModal(); } } }));
    actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("cloud.pushNow"), on: { click: function () {
      PMS.cloudsync.push().then(function (ok) {
        if (ok) PMS.toast.show(t("cloud.pushDone"), "success");
        else PMS.toast.show(t("cloud.pushFail"), "error");
      });
    } } }));
    actions.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("cloud.pullNow"), on: { click: function () { pullModal(); } } }));
    b.appendChild(actions);

    b.appendChild(h("div.section-title", [txt(t("cloud.helpTitle"))]));
    var steps = [1, 2, 3, 4, 5, 6].map(function (i) {
      return h("li", { text: t("cloud.step" + i) });
    });
    b.appendChild(h("details.help-box", {}, [
      h("summary", { text: t("cloud.showHelp") }),
      h("ol", { style: { margin: "6px 0", paddingInlineStart: "18px" } }, steps),
      h("div.u-bold", { text: t("cloud.rulesTitle"), style: { marginTop: "8px" } }),
      h("pre.code", { text: t("cloud.rulesSnippet") })
    ]));

    card.appendChild(b);
    body.appendChild(card);
  }

  function configModal() {
    PMS.modal.open({
      title: t("cloud.configTitle"),
      size: "md",
      content: function () {
        var current = PMS.cloudsync.config() || {};
        return PMS.forms.build([
          { key: "cfg", label: t("cloud.configLabel"), type: "textarea", required: true, full: true }
        ], { cfg: Object.keys(current).length ? JSON.stringify(current, null, 2) : "" });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            var parsed;
            try { parsed = JSON.parse(v.cfg); } catch (e) { PMS.toast.show(t("cloud.configInvalid"), "error"); return; }
            if (!parsed || !parsed.projectId) { PMS.toast.show(t("cloud.configInvalid"), "error"); return; }
            PMS.cloudsync.saveConfig(parsed);
            PMS.modal.close();
            PMS.cloudsync.enable().then(function () {
              PMS.toast.show(t("cloud.connected"), "success");
              render(document.getElementById("view-root"));
            }).catch(function (err) {
              PMS.toast.show(t("cloud.connectFail") + (err && err.message ? " (" + err.message + ")" : ""), "error");
              render(document.getElementById("view-root"));
            });
          }
        }
      ]
    });
  }

  function pullModal() {
    PMS.modal.open({
      title: t("cloud.pullConfirm"),
      content: h("p", { text: t("cloud.pullNow") + "?" }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("cloud.pullMerge"), onClick: function () { doPull("merge"); } },
        { label: t("cloud.pullReplace"), class: "btn-danger", onClick: function () { doPull("replace"); } }
      ]
    });
  }

  function doPull(mode) {
    PMS.cloudsync.pull(mode).then(function (changed) {
      PMS.modal.close();
      if (changed) PMS.toast.show(mode === "replace" ? t("cloud.replaceDone") : t("cloud.mergeDone"), "success");
      render(document.getElementById("view-root"));
    });
  }

  /* ---------------- Backup ---------------- */
  function renderBackup(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: t("settings.backup") })]));
    var b = h("div.card-body");

    // auto backup toggle
    var row = h("div.setting-row");
    var autoBlock = h("div", {}, [
      h("div.u-bold", { text: t("settings.autoBackup") }),
      h("div.u-muted", { text: t("settings.autoBackupEvery") + " " + (PMS.store.data.settings.autoBackupEveryMin || 30) + " " + t("settings.minutes") })
    ]);
    var aSwitch = h("label.switch");
    var aInput = h("input", { type: "checkbox", checked: !!PMS.store.data.settings.autoBackupEnabled, on: { change: function (e) { PMS.repos.settings.update({ autoBackupEnabled: e.target.checked }); } } });
    aSwitch.appendChild(aInput);
    aSwitch.appendChild(h("span.slider"));
    row.appendChild(autoBlock);
    row.appendChild(aSwitch);
    b.appendChild(row);

    var btnRow = h("div.u-flex", { style: { marginTop: "12px" } });
    btnRow.appendChild(h("button.btn.btn-primary", { text: "🗘 " + t("settings.backupNow"), on: { click: function () { PMS.backup.create(); PMS.toast.show(t("settings.backupCreated"), "success"); render(document.getElementById("view-root")); } } }));
    b.appendChild(btnRow);

    // list backups
    var backups = PMS.backup.list();
    b.appendChild(h("div.section-title", [txt(t("settings.backups"))]));
    if (!backups.length) b.appendChild(h("div.u-muted", { text: t("settings.noBackups") }));
    backups.forEach(function (bk) {
      var r = h("div.setting-row");
      r.appendChild(h("span", { text: "🗄" }));
      r.appendChild(h("span.u-grow.u-bold", { text: PMS.utils.formatDate(bk.createdAt, PMS.i18n, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) }));
      r.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("settings.restore"), on: { click: function () { restoreBackup(bk); } } }));
      r.appendChild(h("button.btn.btn-sm.btn-icon.btn-soft-danger", { text: "✕", on: { click: function () { PMS.backup.remove(bk.id); render(document.getElementById("view-root")); } } }));
      b.appendChild(r);
    });

    // export/import
    b.appendChild(h("div.section-title", [txt(t("settings.exportAllJson"))]));
    b.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("reports.exportJson"), on: { click: PMS.exportService.exportAllJSON } }));
    var importTitle = h("div.section-title", [txt(t("settings.importJson"))]);
    b.appendChild(importTitle);
    b.appendChild(importControls(body));

    card.appendChild(b);
    body.appendChild(card);
  }

  function importControls() {
    var row = h("div.u-flex", { style: { gap: "10px" } });
    var fileInput = h("input", { type: "file", accept: ".json,.pms" });
    row.appendChild(h("button.btn.btn-sm", { text: t("settings.importJson"), on: { click: function () { fileInput.click(); } } }));
    row.appendChild(fileInput);
    fileInput.addEventListener("change", function () {
      var f = fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { doImport(reader.result); };
      reader.readAsText(f);
    });
    return row;
  }

  function doImport(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { PMS.toast.show(t("export.importInvalid"), "error"); return; }
    var check = PMS.exportService.validateImport(obj);
    if (!check.valid) { PMS.toast.show(t("export.importInvalid"), "error"); return; }

    PMS.modal.open({
      title: t("settings.importTitle"),
      size: "sm",
      content: h("p", { text: t("settings.importMode") }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("settings.merge"), onClick: function () { PMS.exportService.importJSON(obj, "merge"); PMS.modal.close(); } },
        { label: t("settings.replace"), class: "btn-danger", onClick: function () { PMS.exportService.importJSON(obj, "replace"); PMS.modal.close(); } }
      ]
    });
  }

  function restoreBackup(bk) {
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("confirm.restoreBackup", { date: PMS.utils.formatDate(bk.createdAt, PMS.i18n) }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("settings.restore"), class: "btn-primary", onClick: function () {
          PMS.backup.restore(bk.id).then(function () {
            PMS.modal.close();
            PMS.toast.show(t("settings.restore") + " ✓", "success");
            render(document.getElementById("view-root"));
          });
        } }
      ]
    });
  }

  /* ---------------- File binding ---------------- */
  function renderFile(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: t("settings.fileBinding") })]));
    var b = h("div.card-body");

    var status = PMS.fileStorage.status();
    var row = h("div.setting-row");
    row.appendChild(h("div", {}, [
      h("div.u-bold", { text: t("settings.fileStatus", { status: fileStatusLabel(status) }) }),
      h("div.u-muted", { text: status === "bound" ? t("settings.fileBound") : (status === "unsupported" ? t("settings.fsNotSupported") : t("settings.fileLocal")) })
    ]));
    var right = h("div.u-flex");
    right.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("settings.openFile"), on: { click: openFile } }));
    if (status === "bound") {
      right.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("settings.saveToFile"), on: { click: function () { PMS.store.flush(); } } }));
      right.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("settings.unbind"), on: { click: function () { PMS.fileStorage.unbind().then(function () { render(document.getElementById("view-root")); }); } } }));
    } else if (status !== "unsupported") {
      right.appendChild(h("button.btn.btn-sm.btn-primary", { text: t("settings.bindFile"), on: { click: bindFile } }));
    }
    row.appendChild(right);
    b.appendChild(row);

    // seed & clear
    var seedRow = h("div.setting-row");
    seedRow.appendChild(h("div", {}, [h("div.u-bold", { text: t("settings.seedData") }), h("div.u-muted", { text: t("settings.seedData") })]));
    seedRow.appendChild(h("button.btn.btn-sm", { text: t("settings.seedData"), on: { click: loadSeed } }));
    b.appendChild(seedRow);

    var clearRow = h("div.setting-row");
    clearRow.appendChild(h("div", {}, [h("div.u-bold", { text: t("settings.clearAll") }), h("div.u-muted", { text: t("settings.clearAll") })]));
    clearRow.appendChild(h("button.btn.btn-sm.btn-soft-danger", { text: t("settings.clearAll"), on: { click: clearAllData } }));
    b.appendChild(clearRow);

    card.appendChild(b);
    body.appendChild(card);
  }

  function fileStatusLabel(s) {
    switch (s) {
      case "bound": return t("settings.fileBound");
      case "unbound": return t("settings.fileLocal");
      case "unsupported": return t("settings.fsNotSupported");
      default: return s;
    }
  }

  function bindFile() {
    PMS.fileStorage.bind().then(function () {
      PMS.toast.show(t("settings.fileBound"), "success");
      render(document.getElementById("view-root"));
    }).catch(function (e) {
      PMS.toast.show(t("settings.bindFail") + " (" + (e && e.message ? e.message : e) + ")", "error");
    });
  }

  // Open an existing PMS JSON file and import its data (merge or replace).
  // Uses the File System Access picker when supported, otherwise falls back to
  // a plain <input type="file"> so it works in every browser (Firefox, Safari,
  // private mode). The file is bound only after the user confirms, so a
  // cancelled import never silently overwrites the chosen file.
  function openFile() {
    pickJSONText().then(function (res) {
      if (!res || !res.text) { PMS.toast.show(t("export.importInvalid"), "error"); return; }
      var obj;
      try { obj = JSON.parse(res.text); } catch (e) { PMS.toast.show(t("export.importInvalid"), "error"); return; }
      var check = PMS.exportService.validateImport(obj);
      if (!check.valid) { PMS.toast.show(t("export.importInvalid"), "error"); return; }

      PMS.modal.open({
        title: t("settings.importTitle"),
        size: "sm",
        content: h("p", { text: t("settings.fileImportConfirm") }),
        footer: [
          { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
          { label: t("settings.merge"), onClick: function () { doOpenImport(res.handle, obj, "merge"); } },
          { label: t("settings.replace"), class: "btn-danger", onClick: function () { doOpenImport(res.handle, obj, "replace"); } }
        ]
      });
    }).catch(function (e) {
      if (e && (e.name === "AbortError" || e.code === 20)) return; // user cancelled picker
      PMS.toast.show(t("settings.openFileFail") + (e && e.message ? " (" + e.message + ")" : ""), "error");
    });
  }

  // Returns Promise<{ handle, text }>. handle is non-null only when the
  // File System Access API was used (so the file can be adopted/bound).
  function pickJSONText() {
    if (PMS.fileStorage.supported) {
      return PMS.fileStorage.open().catch(function (e) {
        if (e && (e.name === "AbortError" || e.code === 20)) throw e; // keep cancel silent
        return inputFileRead(); // any FS failure (permission, unsupported) -> file input
      });
    }
    return inputFileRead();
  }

  function inputFileRead() {
    return new Promise(function (resolve, reject) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.pms";
      input.addEventListener("change", function () {
        var f = input.files && input.files[0];
        if (!f) return reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
        var reader = new FileReader();
        reader.onload = function () { resolve({ handle: null, text: reader.result }); };
        reader.onerror = function () { reject(reader.error || new Error("read failed")); };
        reader.readAsText(f);
      });
      input.addEventListener("cancel", function () {
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      });
      input.click();
    });
  }

  function doOpenImport(handle, obj, mode) {
    if (handle) PMS.fileStorage.adopt(handle);
    PMS.exportService.importJSON(obj, mode);
    PMS.modal.close();
    PMS.store.flush(); // persist locally (and mirror to the newly bound file, if any)
    render(document.getElementById("view-root"));
  }

  function loadSeed() {
    PMS.editors.loadSampleData();
  }

  function clearAllData() {
    PMS.modal.open({
      title: t("confirm.title"),
      content: h("p", { text: t("settings.clearAll") + "?" }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        { label: t("settings.clearAll"), class: "btn-danger", onClick: function () {
          var fresh = PMS.schema.defaultData();
          // keep accounts so the admin is not locked out
          if (PMS.store.data.users) fresh.users = PMS.utils.deepClone(PMS.store.data.users);
          PMS.store.setData(fresh);
          PMS.modal.close();
          PMS.toast.show(t("settings.dataErased"), "success");
          render(document.getElementById("view-root"));
        } }
      ]
    });
  }

  /* ---------------- Accounts ---------------- */
  function renderAccounts(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [
      h("div.u-grow.card-title", { text: t("auth.accounts") }),
      h("button.btn.btn-primary.btn-sm", { text: "+ " + t("auth.addAccount"), on: { click: function () { editAccount(null); } } }),
      cloudReady() ? h("button.btn.btn-ghost.btn-sm", { text: "+ " + t("auth.addCloudAccount"), on: { click: function () { addCloudAccount(); } } }) : null
    ]));
    var b = h("div.card-body");
    b.appendChild(h("p.u-muted", { text: t("auth.accountsHint"), style: { marginBlockEnd: "8px" } }));
    var list = PMS.auth.users();
    if (!list.length) b.appendChild(h("div.u-muted", { text: t("common.noResults") }));
    list.forEach(function (u) {
      var row = h("div.account-row");
      row.appendChild(PMS.vformat.avatar({ id: u.id, name: PMS.authUI.displayName(u) }));

      var main = h("div.ar-main");
      var nameLine = h("div.ar-name", [
        h("span.u-ellipsis", { text: PMS.authUI.displayName(u) }),
        h("span.role-badge." + u.role, { text: t("auth.role." + u.role) })
      ]);
      if (PMS.auth.currentUser() && PMS.auth.currentUser().id === u.id) {
        nameLine.appendChild(h("span.chip", { text: t("auth.you") }));
      }
      if (u.cloudUid) nameLine.appendChild(h("span.chip", { text: t("auth.cloudBadge") }));
      if (u.active === false) nameLine.appendChild(h("span.chip", { text: t("auth.inactiveFlag") }));
      main.appendChild(nameLine);
      var metaLine = h("div.ar-meta");
      metaLine.appendChild(h("span", { text: "@" + u.username }));
      if (u.personId) {
        var p = PMS.repos.people.get(u.personId);
        if (p) {
          var pd = PMS.repos.departments.get(p.departmentId);
          if (pd) metaLine.appendChild(h("span", { text: " · " + PMS.i18n.trilingual(pd.name)(pd.name) }));
        }
      }
      if (u.lastLoginAt) metaLine.appendChild(h("span", { text: " · " + t("auth.lastLogin") + ": " + PMS.utils.formatDate(u.lastLoginAt, PMS.i18n) }));
      main.appendChild(metaLine);
      row.appendChild(main);

      // active toggle
      var toggle = h("label.switch", { attrs: { title: t("auth.activeToggle") } });
      var chk = h("input", { type: "checkbox", checked: u.active !== false, on: { change: function (e) {
        var res = PMS.auth.updateUser(u.id, { active: e.target.checked });
        if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); render(document.getElementById("view-root")); return; }
        PMS.store.flush();
      } } });
      toggle.appendChild(chk);
      toggle.appendChild(h("span.slider"));
      row.appendChild(toggle);

      row.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function () { editAccount(u); } } }));
      row.appendChild(h("button.btn.btn-sm.btn-icon", { text: "🔑", attrs: { title: t("auth.resetPassword") }, on: { click: function () { if (u.cloudUid) cloudResetPassword(u); else resetPasswordAccount(u); } } }));
      if (!u.cloudUid) row.appendChild(h("button.btn.btn-sm.btn-icon.btn-soft-danger", { text: "✕", attrs: { title: t("common.delete") }, on: { click: function () { deleteAccount(u); } } }));
      b.appendChild(row);
    });
    if (list.some(function (x) { return x.cloudUid; })) {
      b.appendChild(h("p.u-muted", { text: t("auth.cloudAccountsNote"), style: { marginBlockStart: "10px", fontSize: "0.78rem" } }));
    }
    card.appendChild(b);
    body.appendChild(card);
  }

  function accountOptions() {
    return PMS.auth.roles.map(function (r) { return { label: PMS.i18n.t("auth.role." + r), value: r }; });
  }

  function editAccount(user) {
    var isEdit = !!user;
    var people = PMS.repos.people.all().filter(function (p) { return p.status !== "inactive"; });
    var personOptions = [{ label: t("auth.noPerson"), value: "" }].concat(people.map(function (p) { return { label: p.name, value: p.id }; }));
    var fields = [
      { key: "personId", label: t("auth.linkPerson"), type: "select", options: personOptions },
      { key: "username", label: t("auth.username"), type: "text", required: true },
      { key: "role", label: t("auth.roleLabel"), type: "select", options: accountOptions() }
    ];
    if (!isEdit) {
      fields.push({ key: "password", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true });
      fields.push({ key: "confirm", label: t("auth.confirmPassword"), type: "password", required: true });
    }
    PMS.modal.open({
      title: isEdit ? t("common.edit") + " " + t("auth.account") : t("auth.addAccount"),
      size: "sm",
      content: function () {
        return PMS.forms.build(fields, {
          personId: user ? user.personId || "" : "",
          username: user ? user.username : "",
          role: user ? user.role : "member"
        });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (!isEdit && v.password !== v.confirm) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            var res;
            if (isEdit) res = PMS.auth.updateUser(user.id, { username: v.username, role: v.role, personId: v.personId || null });
            else res = PMS.auth.createUser({ username: v.username, password: v.password, role: v.role, personId: v.personId || null });
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            // keep the shared cloud role in sync so other devices see it
            if (isEdit && user.cloudUid && PMS.cloudsync && PMS.cloudsync.setCloudRole) {
              PMS.cloudsync.setCloudRole(user.cloudUid, v.role);
            }
            PMS.modal.close();
            PMS.store.flush();
            render(document.getElementById("view-root"));
          }
        }
      ]
    });
  }

  function addCloudAccount() {
    var people = PMS.repos.people.all().filter(function (p) { return p.status !== "inactive"; });
    var personOptions = [{ label: t("auth.noPerson"), value: "" }].concat(people.map(function (p) { return { label: p.name, value: p.id }; }));
    PMS.modal.open({
      title: t("auth.addCloudAccount"),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "personId", label: t("auth.linkPerson"), type: "select", options: personOptions },
          { key: "email", label: t("auth.cloudEmail"), type: "text", required: true },
          { key: "name", label: t("auth.name"), type: "text" },
          { key: "role", label: t("auth.roleLabel"), type: "select", options: accountOptions(), value: "member" },
          { key: "password", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true },
          { key: "confirm", label: t("auth.confirmPassword"), type: "password", required: true }
        ], { role: "member" });
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (v.password !== v.confirm) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            if (!PMS.cloudsync || !PMS.cloudsync.signUpWithPassword) return;
            PMS.cloudsync.signUpWithPassword({
              email: v.email, password: v.password, name: v.name || "", role: v.role, personId: v.personId || null
            }).then(function (res) {
              PMS.auth.registerCloudUser({ username: res.email, cloudUid: res.uid, role: res.role, name: res.displayName || v.name || "", personId: v.personId || null });
              PMS.modal.close();
              PMS.store.flush();
              PMS.toast.show(t("auth.cloudAccountCreated"), "success");
              render(document.getElementById("view-root"));
            }).catch(function (err) {
              PMS.toast.show(PMS.authUI.errorMessage((err && err.userCode) || "generic"), "error");
              console.error("[zms] create cloud account failed:", err && err.code || err, err);
            });
          }
        }
      ]
    });
  }

  function resetPasswordAccount(user) {
    PMS.modal.open({
      title: t("auth.resetPassword") + " — " + (user.username || ""),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "pw", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true },
          { key: "pw2", label: t("auth.confirmPassword"), type: "password", required: true }
        ], {});
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("auth.resetPassword"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (v.pw !== v.pw2) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            var res = PMS.auth.resetPassword(user.id, v.pw);
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            PMS.modal.close();
            PMS.toast.show(t("auth.passwordReset"), "success");
            PMS.store.flush();
          }
        }
      ]
    });
  }

  function cloudResetPassword(user) {
    PMS.modal.open({
      title: t("auth.resetPassword") + " — " + (user.username || ""),
      size: "sm",
      content: h("p", { text: t("auth.cloudResetConfirm", { email: user.username }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("auth.cloudReset"), class: "btn-primary",
          onClick: function () {
            if (!PMS.cloudsync || !PMS.cloudsync.resetPassword) return;
            PMS.cloudsync.resetPassword(user.username).then(function () {
              PMS.modal.close();
              PMS.toast.show(t("auth.cloudResetSent"), "success");
            }).catch(function () {
              PMS.modal.close();
              PMS.toast.show(t("auth.network"), "error");
            });
          }
        }
      ]
    });
  }

  function deleteAccount(user) {
    PMS.modal.open({
      title: t("auth.deleteAccount"),
      content: h("p", { text: t("auth.deleteAccountConfirm", { name: user.username }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.delete"), class: "btn-danger",
          onClick: function () {
            var res = PMS.auth.removeUser(user.id);
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            PMS.modal.close();
            PMS.store.flush();
            render(document.getElementById("view-root"));
          }
        }
      ]
    });
  }

  /* ---------------- About ---------------- */
  function renderAbout(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [h("div.card-title", { text: t("settings.about") })]));
    var b = h("div.card-body");
    b.appendChild(h("p", { text: t("app.name") + " v" + PMS.version }));
    b.appendChild(h("p.u-muted", { text: t("settings.appVersion") + ": " + PMS.version }));
    b.appendChild(h("p.u-muted", { text: t("settings.schemaVersion") + ": " + PMS.schema.VERSION }));
    card.appendChild(b);
    body.appendChild(card);
  }

  function txt(s) { return s; }

  var view = {
    id: "settings",
    path: "/settings",
    titleKey: "nav.settings",
    icon: "⚙",
    nav: true,
    adminOnly: true,
    render: function (container, params) {
      render(container, params);
      var off = PMS.bus.on("store:changed", function () { if (PMS.router.current === "/settings") render(container, params); });
      return function () { off(); };
    }
  };
  PMS.registry.registerView(view);
  PMS.router.register("/settings", "settings");
})(window.PMS);