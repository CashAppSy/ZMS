/* ==========================================================================
   PMS.charts - SVG-based charts (no CDN):
   - donutChart(data: [{label, value, color}], size, thickness)
   - barChart(data, opts)
   - ring(percent, size, color) -> progress ring
   All return an SVG element. Pure functions (testable).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function polar(cx, cy, r, angleDeg) {
    var a = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  // pie/donut chart. data: [{label, value, color}]
  function donut(data, opts) {
    opts = opts || {};
    var size = opts.size || 180;
    var thickness = opts.thickness || 30;
    var cx = size / 2, cy = size / 2;
    var r = (size - thickness) / 2;
    var total = data.reduce(function (s, d) { return s + d.value; }, 0);
    var svgEl = svg("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size });
    if (opts.title) svgEl.appendChild(svg("title", {}).textContent !== undefined && (function () { var t = svg("title", {}); t.textContent = opts.title; svgEl.appendChild(t); })());
    if (!total) {
      var circ0 = svg("circle", { cx: cx, cy: cy, r: r, fill: "none", stroke: "var(--bg-subtle)", "stroke-width": thickness });
      svgEl.appendChild(circ0);
      return svgEl;
    }
    var angle = 0;
    data.forEach(function (d) {
      if (!d.value) return;
      var frac = d.value / total;
      var sweep = frac * 360;
      var p1 = polar(cx, cy, r, angle);
      var p2 = polar(cx, cy, r, angle + sweep);
      var largeArc = sweep > 180 ? 1 : 0;
      var path = svg("path", {
        d: "M " + p1.x + " " + p1.y + " A " + r + " " + r + " 0 " + largeArc + " 1 " + p2.x + " " + p2.y,
        fill: "none",
        stroke: d.color || "var(--primary)",
        "stroke-width": thickness,
        "stroke-linecap": "butt"
      });
      svgEl.appendChild(path);
      angle += sweep;
    });
    if (opts.centerText) {
      var txt = svg("text", { x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central", "font-size": "16", "font-weight": "700" });
      txt.textContent = opts.centerText;
      svgEl.appendChild(txt);
    }
    return svgEl;
  }

  // horizontal bar chart. data: [{label, value, color}]
  function hbars(data, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var width = opts.width || 220;
    var rowH = opts.rowH || 20;
    var gap = opts.gap || 6;
    var height = data.length * rowH;
    var svgEl = svg("svg", { width: width + 80, height: height + 4, viewBox: "0 0 " + (width + 80) + " " + (height + 4), "font-size": "11" });

    data.forEach(function (d, i) {
      var y = i * rowH;
      var bw = (d.value / max) * width;
      svgEl.appendChild(svg("rect", { x: 78, y: y + 2, width: bw, height: rowH - gap, rx: 3, fill: d.color || "var(--primary)" }));
      if (bw > 30) {
        var txt = svg("text", { x: 78 + bw - 6, y: y + (rowH - gap) / 2 + 4, "text-anchor": "end" });
        txt.textContent = d.value;
        svgEl.appendChild(txt);
      }
      var lab = svg("text", { x: 76, y: y + (rowH - gap) / 2 + 4, "text-anchor": "end", fill: "currentColor" });
      lab.textContent = d.label;
      svgEl.appendChild(lab);
    });
    return svgEl;
  }

  // vertical bars. data: [{label,value,color}]
  function vbars(data, opts) {
    opts = opts || {};
    var barW = opts.barW || 22;
    var gap = opts.gap || 10;
    var width = Math.max(160, data.length * (barW + gap));
    var height = opts.height || 160;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var pad = 18;
    var svgEl = svg("svg", { width: width, height: height + pad, viewBox: "0 0 " + width + " " + (height + pad) });
    data.forEach(function (d, i) {
      var bh = (d.value / max) * height;
      var x = i * (barW + gap);
      svgEl.appendChild(svg("rect", { x: x, y: height - bh, width: barW, height: bh, rx: 3, fill: d.color || "var(--primary)" }));
      var lab = svg("text", { x: x + barW / 2, y: height + 12, "text-anchor": "middle", "font-size": "10" });
      lab.textContent = d.label;
      svgEl.appendChild(lab);
      if (bh > 14) {
        var val = svg("text", { x: x + barW / 2, y: height - bh - 5, "text-anchor": "middle", "font-size": "10", "font-weight": "600" });
        val.textContent = d.value;
        svgEl.appendChild(val);
      }
    });
    return svgEl;
  }

  // circular progress ring
  function ring(percent, opts) {
    opts = opts || {};
    var size = opts.size || 60;
    var thick = opts.thick || 6;
    var color = opts.color || "var(--primary)";
    var p = Math.max(0, Math.min(100, percent));
    var r = (size - thick) / 2;
    var circ = 2 * Math.PI * r;
    var svgEl = svg("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size });
    svgEl.appendChild(svg("circle", { cx: size / 2, cy: size / 2, r: r, fill: "none", stroke: "var(--bg-subtle)", "stroke-width": thick }));
    var arc = svg("circle", {
      cx: size / 2, cy: size / 2, r: r, fill: "none", stroke: color,
      "stroke-width": thick, "stroke-linecap": "round",
      "stroke-dasharray": circ.toFixed(2),
      "stroke-dashoffset": (circ * (1 - p / 100)).toFixed(2),
      transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")"
    });
    svgEl.appendChild(arc);
    var txt = svg("text", { x: size / 2, y: size / 2, "text-anchor": "middle", "dominant-baseline": "central", "font-size": size / 4.4, "font-weight": "700", fill: "currentColor" });
    txt.textContent = Math.round(p) + "%";
    svgEl.appendChild(txt);
    return svgEl;
  }

  PMS.charts = { donut: donut, hbars: hbars, vbars: vbars, ring: ring, svg: svg };
})(window.PMS);