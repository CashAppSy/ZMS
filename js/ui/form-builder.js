/* ==========================================================================
   PMS.forms - dynamic form builder.
   build(schema, values) -> form element
   schema: [{key, label, type, options, required, optionsFrom, entity}]
   Supports: text, textarea, number, date, select, multiselect, checkbox,
   tags, link, custom fields (rendered from PMS.registry field types).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k) { return PMS.i18n.t(k); };

  function build(schema, values) {
    values = values || {};
    var form = h("form.form-grid", { on: { submit: function (e) { e.preventDefault(); } } });
    var byKey = {};

    schema.forEach(function (field) {
      var control = buildControl(field, values[field.key]);
      byKey[field.key] = control;
      var wrap = h("div.field" + (field.full ? ".field-full" : ""), { dataset: { key: field.key } });
      if (field.label) wrap.appendChild(h("label", { text: field.label }));
      wrap.appendChild(control.el);
      if (field.hint) wrap.appendChild(h("div.hint", { text: field.hint }));
      wrap.classList.add("field-wrap");
      form.appendChild(wrap);
    });

    form._getValues = function () {
      var out = {};
      schema.forEach(function (field) {
        var c = byKey[field.key];
        if (!c) return;
        out[field.key] = c.getValue();
      });
      return out;
    };
    return form;
  }

  function buildControl(field, value) {
    var self = {};
    var props = { value: value !== undefined ? value : (field.default || "") };
    if (field.placeholder) props.placeholder = field.placeholder;
    if (field.required) props.required = true;

    switch (field.type) {
      case "textarea":
        self.el = h("textarea.textarea" + (field.required ? ".required" : ""), props);
        self.getValue = function () { return self.el.value.trim(); };
        break;

      case "number":
        self.el = h("input.input", Object.assign({ type: "number", step: "any" }, props));
        self.getValue = function () {
          var v = self.el.value;
          return v === "" ? null : Number(v);
        };
        break;

      case "date":
        self.el = h("input.input", Object.assign({ type: "date" }, props));
        self.getValue = function () { return self.el.value || null; };
        break;

      case "select":
        var selEl = h("select.select");
        selEl.appendChild(h("option", { value: "", text: "— " + t("common.none") + " —" }));
        (field.options || []).forEach(function (o) {
          selEl.appendChild(h("option", { value: o.value || o, text: o.label || o }));
        });
        // set AFTER appending options so the current value is selected (and
        // so saving an edit cannot silently reset the field to the first option)
        selEl.value = value !== undefined && value !== null ? String(value) : "";
        if (field.allowCreatePerson) {
          // "+ person" popup: create somebody who does not exist yet and
          // select them right away (assigning to a person not in the system)
          self.el = h("div.control-with-create");
          self.el.appendChild(selEl);
          self.el.appendChild(personCreator(function (person) {
            selEl.appendChild(h("option", { value: person.id, text: person.name }));
            selEl.value = person.id;
          }).el);
        } else {
          self.el = selEl;
        }
        self.getValue = function () { return selEl.value || null; };
        break;

      case "multiselect":
        var listEl = h("div");
        (field.options || []).forEach(function (o) {
          var val = o.value || o, lab = o.label || o;
          var box = h("label.checkbox-row", { style: { marginBlock: "2px" } });
          var cb = h("input", { type: "checkbox", value: val, checked: (value || []).indexOf(val) !== -1 });
          box.appendChild(cb);
          box.appendChild(h("span", { text: lab }));
          listEl.appendChild(box);
        });
        if (field.allowCreatePerson) {
          self.el = h("div.control-with-create");
          self.el.appendChild(listEl);
          self.el.appendChild(personCreator(function (person) {
            var box = h("label.checkbox-row", { style: { marginBlock: "2px" } });
            var cb = h("input", { type: "checkbox", value: person.id, checked: true });
            box.appendChild(cb);
            box.appendChild(h("span", { text: person.name }));
            listEl.appendChild(box);
          }).el);
        } else {
          self.el = listEl;
        }
        self.getValue = function () {
          var out = [];
          self.el.querySelectorAll("input:checked").forEach(function (c) { out.push(c.value); });
          return out;
        };
        break;

      case "linkedTask":
        // task <-> task links: search + chips instead of a long checkbox list
        self.el = h("div.link-picker");
        (function () {
          var exclude = field.excludeId || null;
          var chips = h("div.u-flex", { style: { gap: "4px", flexWrap: "wrap" } });
          var results = h("div.link-results");
          var search = h("input.input.input-sm", { placeholder: t("search.placeholderTasks") || "Search..." });
          var selected = Array.isArray(value) ? value.slice() : [];

          function paintChips() {
            PMS.dom.clear(chips);
            selected.forEach(function (id) {
              var task = PMS.repos.tasks.get(id);
              if (!task) return;
              var chip = h("span.chip.removable", { dataset: { val: id } });
              chip.appendChild(h("span", { text: task.title }));
              chip.appendChild(h("span.chip-x", { text: "✕", on: { click: function () {
                selected = selected.filter(function (x) { return x !== id; });
                paintChips();
              } } }));
              chips.appendChild(chip);
            });
          }
          function paintResults() {
            PMS.dom.clear(results);
            var q = (search.value || "").trim().toLowerCase();
            if (!q) return;
            PMS.repos.tasks.all().filter(function (x) {
              if (x.id === exclude) return false;
              if (selected.indexOf(x.id) !== -1) return false;
              return String(x.title || "").toLowerCase().indexOf(q) !== -1;
            }).slice(0, 8).forEach(function (x) {
              var p = PMS.repos.projects.get(x.projectId);
              var row = h("div.link-result", {
                on: { click: function () {
                  selected.push(x.id);
                  search.value = "";
                  paintChips(); paintResults();
                } }
              });
              row.appendChild(h("span.u-ellipsis", { text: x.title }));
              row.appendChild(h("span.u-muted", { text: p ? p.name : "" }));
              results.appendChild(row);
            });
          }
          search.addEventListener("input", paintResults);
          self.el.appendChild(chips);
          self.el.appendChild(search);
          self.el.appendChild(results);
          paintChips();
          self.getValue = function () { return selected.slice(); };
        })();
        break;

      case "checkbox":
        self.el = h("label.checkbox-row");
        var cbx = h("input", { type: "checkbox", checked: !!value });
        self.el.appendChild(cbx);
        self.el.appendChild(h("span", { text: field.boxLabel || field.label || "" }));
        self.getValue = function () { return cbx.checked; };
        break;

      case "tags":
        self.el = h("div.tag-input");
        self.el.appendChild(buildTagInput(self.el, value || [], field.placeholder));
        self.getValue = function () {
          var out = [];
          self.el.querySelectorAll(".tag-input .chip").forEach(function (ch) {
            out.push(ch.dataset.val);
          });
          return out;
        };
        break;

      case "link":
        self.el = h("input.input", Object.assign({ type: "url" }, props));
        self.getValue = function () { return self.el.value.trim() || null; };
        break;

      case "email":
        self.el = h("input.input", Object.assign({ type: "email" }, props));
        self.getValue = function () { return self.el.value.trim(); };
        break;

      case "hidden":
        self.el = h("input", { type: "hidden", value: value || "" });
        self.getValue = function () { return self.el.value; };
        break;

      case "password":
        self.el = h("input.input" + (field.required ? ".required" : ""), Object.assign({ type: "password", autocomplete: "new-password" }, props));
        self.getValue = function () { return self.el.value.trim(); };
        break;

      default:
        self.el = h("input.input" + (field.required ? ".required" : ""), Object.assign({ type: "text" }, props));
        self.getValue = function () { return self.el.value.trim(); };
    }

    // Custom fields have richer types
    if (field.fieldType && PMS.registry.getFieldType(field.fieldType)) {
      var custom = buildCustomField(field, value);
      self.el = custom.el;
      self.getValue = custom.getValue;
    }

    if (self.el.addEventListener) {
      self.el.addEventListener("input", function () {
        if (self.el.classList) self.el.classList.remove("invalid");
      });
    }
    return self;
  }

  // Render control for a registered custom field definition
  function buildCustomField(field, value) {
    var ft = PMS.registry.getFieldType(field.fieldType);
    return ft.render(field, value, h);
  }

  function buildTagInput(container, initial, placeholder) {
    var input = h("input", { placeholder: placeholder || t("common.placeholderTag") || "" });
    container.appendChild(input); // must be a child before chips are inserted before it
    initial.forEach(function (tag) { container.insertBefore(mkTagger(tag, container), input); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        var v = input.value.trim();
        if (v) { container.insertBefore(mkTagger(v, container), input); input.value = ""; }
      } else if (e.key === "Backspace" && !input.value) {
        var ch = container.querySelectorAll(".chip");
        if (ch.length) ch[ch.length - 1].remove();
      }
    });
    input.addEventListener("blur", function () {
      var v = input.value.trim();
      if (v) { container.insertBefore(mkTagger(v, container), input); input.value = ""; }
    });
    return input;
  }

  function mkTagger(text, container) {
    var chip = h("span.chip.removable", { dataset: { val: text } });
    chip.appendChild(h("span", { text: text }));
    chip.appendChild(h("span.chip-x", { text: "✕", on: { click: function () { chip.remove(); } } }));
    return chip;
  }

  /* ---------------- create-a-person popup (inline, no nested modal) ----------
     Used by every "assign / owner / members" control: when the person being
     assigned does not exist yet, create them from the same screen instead of
     opening the People page in another tab. A modal cannot be stacked (the
     modal API replaces the open one), so the popup is an inline panel. */
  function personCreator(onCreated) {
    var wrap = h("div.person-create");
    var panel = h("div.person-create-panel", { style: { display: "none" } });

    var btn = h("button.btn.btn-sm.btn-ghost", {
      type: "button",
      text: "+ " + t("people.addPerson"),
      on: { click: function () {
        var open = panel.style.display === "none";
        panel.style.display = open ? "block" : "none";
        if (open) setTimeout(function () { nameInput.focus(); }, 20);
      } }
    });
    wrap.appendChild(btn);

    var nameInput = h("input.input", { placeholder: t("people.name"), required: true });
    var emailInput = h("input.input", { type: "email", placeholder: t("people.email") });
    var deptSel = h("select.select");
    deptSel.appendChild(h("option", { value: "", text: "— " + t("common.none") + " —" }));
    PMS.repos.departments.all().forEach(function (d) {
      deptSel.appendChild(h("option", { value: d.id, text: d.name }));
    });

    var err = h("div.hint.person-create-error", { style: { color: "var(--danger)", display: "none" } });
    function showError(msg) { err.textContent = msg; err.style.display = "block"; }
    function clearError() { err.textContent = ""; err.style.display = "none"; }

    [nameInput, emailInput].forEach(function (el) {
      el.addEventListener("input", clearError);
    });

    var saveBtn = h("button.btn.btn-sm.btn-primary", {
      type: "button",
      text: t("common.add"),
      on: { click: function () {
        var name = nameInput.value.trim();
        var email = emailInput.value.trim();
        if (!name) { showError(t("validation.required")); nameInput.classList.add("invalid"); return; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError(t("validation.invalidEmail")); return; }
        var person = PMS.repos.people.add({
          name: name,
          email: email,
          departmentId: deptSel.value || null,
          jobTitle: "",
          phone: "",
          notes: "",
          status: "active"
        });
        if (onCreated) onCreated(person);
        nameInput.value = ""; emailInput.value = "";
        panel.style.display = "none";
        clearError();
        PMS.toast.show(t("people.personAdded", { name: person.name }), "success");
      } }
    });
    var cancelBtn = h("button.btn.btn-sm", {
      type: "button", text: t("common.cancel"),
      on: { click: function () { panel.style.display = "none"; clearError(); } }
    });

    panel.appendChild(h("div.person-create-title", { text: t("people.newPerson") }));
    panel.appendChild(nameInput);
    panel.appendChild(emailInput);
    panel.appendChild(deptSel);
    panel.appendChild(err);
    panel.appendChild(h("div.hint", { text: t("people.personCreateHint") }));
    var actions = h("div.u-flex", { style: { gap: "6px" } });
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    panel.appendChild(actions);
    wrap.appendChild(panel);
    return { el: wrap, panel: panel };
  }

  PMS.forms = { build: build, buildControl: buildControl, personCreator: personCreator };
})(window.PMS);