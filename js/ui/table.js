/* ==========================================================================
   PMS.table - virtual-scrolling data table for very large lists (thousands
   of rows). Renders only visible rows based on scroll position.
   configure: {columns, rows, rowHeight, onRow, onRenderCell, stickyHeaders}
   column: {key, label, width, render(row), sortable}
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;

  function Table(options) {
    var self = this;
    self.options = options || {};
    self.rows = self.options.rows || [];
    self.columns = self.options.columns || [];
    self.rowHeight = self.options.rowHeight || 42;
    self.sortKey = null;
    self.sortDir = "asc";
    self.filters = {};
    self.search = "";
    self.virtual = self.options.virtual !== false;
    self.container = h("div.tbl-wrap");
    self.build();
  }

  Table.prototype.build = function () {
    var self = this;
    self.table = h("table.tbl");
    var thead = h("thead");
    var headRow = h("tr");

    if (self.options.checkbox) headRow.appendChild(h("th.col-check"));

    self.columns.forEach(function (col) {
      var th = h("th" + (col.sortable ? ".sortable" : "") + (self.sortKey === col.key ? (self.sortDir === "asc" ? ".sort-asc" : ".sort-desc") : ""), {
        style: col.width ? { width: col.width } : null,
        on: col.sortable ? { click: function () { self.sort(col.key); } } : null
      });
      th.appendChild(h("span", { text: col.label }));
      if (col.sortable) th.appendChild(h("span.sort-arrow", { text: col.sortDir === "desc" && self.sortKey === col.key ? " ▾" : " ▴" }));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    self.table.appendChild(thead);

    self.tbody = h("tbody");
    self.table.appendChild(self.tbody);
    self.container.appendChild(self.table);

    if (self.virtual) {
      self.spacer = h("div", { style: { height: self.rows.length * self.rowHeight + "px" } });
      self.tbody.appendChild(h("tr", { style: { display: "none" } }));
      self.tbody.appendChild(h("tr", {}, [h("td", { cols: self.columns.length + (self.options.checkbox ? 1 : 0) }, [self.spacer])]));

      self.container.style.maxHeight = (self.options.height || 480) + "px";
      self.container.style.overflow = "auto";
      self.container.addEventListener("scroll", function () { self.renderVirtual(); });
      self.renderVirtual();
    } else {
      self.renderAll();
    }
  };

  Table.prototype.getVisibleRows = function () {
    var self = this;
    var rows = self.rows;
    if (self.search) {
      var q = self.search.toLowerCase();
      rows = rows.filter(function (r) {
        return JSON.stringify(r).toLowerCase().indexOf(q) !== -1;
      });
    }
    if (self.sortKey) {
      var col = self.columns.find(function (c) { return c.key === self.sortKey; });
      var fn = col && col.sortFn;
      rows = rows.slice().sort(function (a, b) {
        var av = fn ? fn(a) : a[self.sortKey];
        var bv = fn ? fn(b) : b[self.sortKey];
        if (av === bv) return 0;
        var cmp = av > bv ? 1 : -1;
        return self.sortDir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  };

  Table.prototype.renderVirtual = function () {
    var self = this;
    var rows = self.getVisibleRows();
    self.spacer.style.height = (rows.length ? rows.length : 0) * self.rowHeight + "px";
    self.tbody.innerHTML = "";

    var scrollTop = self.container.scrollTop || 0;
    var height = self.container.clientHeight || (self.options.height || 480);
    var startIdx = Math.max(0, Math.floor(scrollTop / self.rowHeight) - 10);
    var endIdx = Math.min(rows.length, Math.ceil((scrollTop + height) / self.rowHeight) + 10);

    // keep a lightweight header copy (separate table header is sticky via CSS)
    self.tbody.appendChild(h("tr", { style: { height: "0" } }));
    for (var i = startIdx; i < endIdx; i++) {
      var tr = self.renderRow(rows[i], i, true);
      tr.style.position = "absolute";
      tr.style.top = (i * self.rowHeight) + "px";
      tr.style.left = "0";
      tr.style.right = "0";
      tr.style.height = self.rowHeight + "px";
      self.tbody.appendChild(tr);
    }
    self.tbody.appendChild(self.spacer);
  };

  Table.prototype.renderAll = function () {
    var self = this;
    var rows = self.getVisibleRows();
    self.tbody.innerHTML = "";
    rows.forEach(function (r, i) { self.tbody.appendChild(self.renderRow(r, i, false)); });
  };

  Table.prototype.renderRow = function (row, index, absolute) {
    var self = this;
    var tr = h("tr" + (self.options.rowClassPrefix ? "." + self.options.rowClassPrefix : "") + (row._selected ? ".selected" : ""), {
      on: self.options.onRowClick ? { click: function (e) { self.options.onRowClick(row, e); } } : {}
    });
    if (self.options.checkbox) {
      tr.appendChild(h("td.col-check", [h("input", { type: "checkbox", on: { change: function (e) { row._selected = e.target.checked; self.options.onCheck && self.options.onCheck(row, e.target.checked); } } })]));
    }
    self.columns.forEach(function (col) {
      var td = h("td");
      var val = row[col.key];
      if (col.render) td.appendChild(col.render(val, row, index));
      else td.textContent = val === undefined || val === null ? "" : String(val);
      tr.appendChild(td);
    });
    return tr;
  };

  Table.prototype.sort = function (key) {
    var self = this;
    if (self.sortKey === key) self.sortDir = self.sortDir === "asc" ? "desc" : "asc";
    else { self.sortKey = key; self.sortDir = "asc"; }
    self.build();
  };

  Table.prototype.setRows = function (rows) {
    this.rows = rows;
    if (this.virtual) { this.spacer.style.height = rows.length * this.rowHeight + "px"; this.renderVirtual(); }
    else this.renderAll();
  };

  Table.prototype.searchRows = function (q) {
    this.search = q;
    if (this.virtual) this.renderVirtual(); else this.renderAll();
  };

  PMS.tableService = { Table: Table };
  window.PMSVirtual = Table;
})(window.PMS);