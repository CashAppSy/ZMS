/* ==========================================================================
   PMS.dom - tiny DOM builders: h() to create elements, mount(), clear().
   Helps keep JSX-free views compact and XSS-safe (text via textContent).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  // h('div.class#id', {attr: val, on: {click: fn}, style: {...}}, children...)
  function h(tag, props, children) {
    // tolerate h('div', [child, child]) → array passed as 2nd arg
    if (Array.isArray(props) && children === undefined) { children = props; props = null; }
    var parts = String(tag).split(".");
    var el;
    if (parts[0] === "svg" || parts[0] === "path" || parts[0] === "circle" || parts[0] === "rect" || parts[0] === "g" || parts[0] === "line" || parts[0] === "text" || parts[0] === "polyline") {
      el = document.createElementNS(NS, parts[0]);
    } else {
      el = document.createElement(parts[0]);
    }
    var split = parts[1] ? parts.slice(1) : [];
    if (parts.length > 1) {
      el.setAttribute("class", split.join(" "));
    }
    if (props && props.id) el.id = props.id;

    if (props) {
      if (props.class) { var curCls = el.getAttribute("class"); el.setAttribute("class", curCls ? curCls + " " + props.class : props.class); }
      if (props.text !== undefined) el.textContent = props.text;
      if (props.html !== undefined) el.innerHTML = props.html;
      if (props.style) Object.assign(el.style, props.style);
      if (props.attrs) for (var a in props.attrs) el.setAttribute(a, props.attrs[a]);
      if (props.dataset) for (var d in props.dataset) el.dataset[d] = props.dataset[d];
      if (props.on) for (var ev in props.on) el.addEventListener(ev, props.on[ev]);
      if (props.checked !== undefined) el.checked = props.checked;
      if (props.value !== undefined) el.value = props.value;
      if (props.placeholder) el.setAttribute("placeholder", props.placeholder);
      if (props.disabled) el.disabled = true;
      if (props.title) el.setAttribute("title", props.title);
      if (props.tabindex) el.tabIndex = props.tabindex;
      if (props.type) el.type = props.type;
      if (props.min !== undefined) el.min = props.min;
      if (props.max !== undefined) el.max = props.max;
      if (props.cols) el.cols = props.cols;
      if (props.rows) el.rows = props.rows;
      if (props.for) el.htmlFor = props.for;
      if (props.name) el.name = props.name;
      if (props.required) el.required = true;
      if (props.maxlength) el.maxLength = props.maxlength;
    }

    function appendChild(c) {
      if (c === null || c === undefined) return;
      if (Array.isArray(c)) { c.forEach(appendChild); return; }
      if (c && c.nodeType) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    (children === undefined ? [] : Array.isArray(children) ? children : [children]).forEach(appendChild);
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // safely set innerHTML after escaping user-controlled strings
  function html(el, str) { el.innerHTML = str; return el; }

  function on(el, evt, fn, opts) {
    if (!el) return function () {};
    el.addEventListener(evt, fn, opts);
    return function () { el.removeEventListener(evt, fn); };
  }

  PMS.dom = { h: h, clear: clear, html: html, on: on };
})(window.PMS);