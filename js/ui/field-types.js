/* ==========================================================================
   PMS.fieldTypes - registered custom field type renderers.
   Adding a new field type = one PMS.registry.registerFieldType(...) call here.
   descriptor = { render(fieldDef, value, h) -> {el, getValue} }
   ========================================================================== */
(function (PMS) {
  "use strict";

  var reg = PMS.registry;
  var t = function (k) { return PMS.i18n.t(k); };

  reg.registerFieldType("text", {
    render: function (field, value) {
      var input = PMS.dom.h("input.input", { type: "text", value: value || "" });
      return {
        el: input,
        getValue: function () { return input.value.trim(); }
      };
    }
  });

  reg.registerFieldType("number", {
    render: function (field, value) {
      var input = PMS.dom.h("input.input", { type: "number", step: "any", value: value !== undefined && value !== null ? value : "" });
      return {
        el: input,
        getValue: function () {
          var v = input.value;
          return v === "" ? null : Number(v);
        }
      };
    }
  });

  reg.registerFieldType("date", {
    render: function (field, value) {
      var input = PMS.dom.h("input.input", { type: "date", value: value || "" });
      return {
        el: input,
        getValue: function () { return input.value || null; }
      };
    }
  });

  reg.registerFieldType("select", {
    render: function (field, value) {
      var sel = PMS.dom.h("select.select");
      sel.appendChild(PMS.dom.h("option", { value: "", text: "— " + t("common.none") + " —" }));
      (field.options || []).forEach(function (o) {
        sel.appendChild(PMS.dom.h("option", { value: o.value || o, text: o.label || o }));
      });
      sel.value = value || "";
      return {
        el: sel,
        getValue: function () { return sel.value || null; }
      };
    }
  });

  reg.registerFieldType("multiselect", {
    render: function (field, value) {
      var container = PMS.dom.h("div");
      (field.options || []).forEach(function (o) {
        var val = o.value || o, lab = o.label || o;
        var row = PMS.dom.h("label.checkbox-row", { style: { marginBlock: "2px" } });
        var cb = PMS.dom.h("input", { type: "checkbox", value: val, checked: (value || []).indexOf(val) !== -1 });
        row.appendChild(cb);
        row.appendChild(PMS.dom.h("span", { text: lab }));
        container.appendChild(row);
      });
      return {
        el: container,
        getValue: function () {
          var out = [];
          container.querySelectorAll("input:checked").forEach(function (c) { out.push(c.value); });
          return out;
        }
      };
    }
  });

  reg.registerFieldType("link", {
    render: function (field, value) {
      var input = PMS.dom.h("input.input", { type: "url", value: value || "" });
      return {
        el: input,
        getValue: function () { return input.value.trim() || null; }
      };
    }
  });

  reg.registerFieldType("checkbox", {
    render: function (field, value) {
      var cb = PMS.dom.h("input", { type: "checkbox", checked: !!value });
      var row = PMS.dom.h("label.checkbox-row");
      row.appendChild(cb);
      row.appendChild(PMS.dom.h("span", { text: PMS.i18n.trilingual(field.label)(field.label) }));
      return {
        el: row,
        getValue: function () { return cb.checked; }
      };
    }
  });

})(window.PMS);