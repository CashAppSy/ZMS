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
        self.el = h("select.select");
        self.el.appendChild(h("option", { value: "", text: "— " + t("common.none") + " —" }));
        (field.options || []).forEach(function (o) {
          self.el.appendChild(h("option", { value: o.value || o, text: o.label || o }));
        });
        // set AFTER appending options so the current value is selected (and
        // so saving an edit cannot silently reset the field to the first option)
        self.el.value = value !== undefined && value !== null ? String(value) : "";
        self.getValue = function () { return self.el.value || null; };
        break;

      case "multiselect":
        self.el = h("div");
        (field.options || []).forEach(function (o) {
          var val = o.value || o, lab = o.label || o;
          var box = h("label.checkbox-row", { style: { marginBlock: "2px" } });
          var cb = h("input", { type: "checkbox", value: val, checked: (value || []).indexOf(val) !== -1 });
          box.appendChild(cb);
          box.appendChild(h("span", { text: lab }));
          self.el.appendChild(box);
        });
        self.getValue = function () {
          var out = [];
          self.el.querySelectorAll("input:checked").forEach(function (c) { out.push(c.value); });
          return out;
        };
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
        self.el.appendChild(buildTagInput(self.el, value || []));
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

  function buildTagInput(container, initial) {
    var input = h("input", { placeholder: t("common.placeholderTag") || "" });
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

  PMS.forms = { build: build, buildControl: buildControl };
})(window.PMS);