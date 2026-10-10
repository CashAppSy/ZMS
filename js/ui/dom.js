/* ==========================================================================
   PMS.dom - tiny DOM builders: h() to create elements, mount(), clear().
   Helps keep JSX-free views compact and XSS-safe (text via textContent).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  // Every tag h() has to create in the SVG namespace. An element built as HTML
  // and then placed inside an <svg> is not rendered and quietly takes its
  // attributes with it, so a tag missing from this list fails as "nothing
  // appears" rather than as an error - which is how the gantt's arrowheads
  // went missing while the arrows still drew.
  var SVG_TAGS = {
    svg: 1, path: 1, circle: 1, rect: 1, g: 1, line: 1, text: 1, polyline: 1,
    polygon: 1, defs: 1, marker: 1, title: 1, ellipse: 1, use: 1, tspan: 1
  };

  // h('div.class#id', {attr: val, on: {click: fn}, style: {...}}, children...)
  function h(tag, props, children) {
    // tolerate h('div', [child, child]) → array passed as 2nd arg
    if (Array.isArray(props) && children === undefined) { children = props; props = null; }
    var parts = String(tag).split(".");
    var el;
    if (SVG_TAGS[parts[0]]) {
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

  function affects(event, collections) {
    return !event || !event.collections || event.collections.some(function (key) {
      return collections.indexOf(key) !== -1;
    });
  }

  // Rebuilding a data view must not discard a user's search focus or scroll.
  function refresh(container, render) {
    var active = document.activeElement;
    var index = container.contains(active) ? Array.from(container.querySelectorAll("input,select,textarea,button")).indexOf(active) : -1;
    var top = container.scrollTop, left = container.scrollLeft;
    var scrolling = Array.from(container.querySelectorAll("*")).filter(function (el) { return el.scrollTop || el.scrollLeft; }).map(function (el) {
      var peers = el.className && typeof el.className === "string" ? Array.from(container.getElementsByClassName(el.className)) : [];
      return { id: el.id, className: el.className, index: peers.indexOf(el), top: el.scrollTop, left: el.scrollLeft };
    });
    var start = active && active.selectionStart, end = active && active.selectionEnd;
    render();
    container.scrollTop = top;
    container.scrollLeft = left;
    scrolling.forEach(function (saved) {
      var el = saved.id ? document.getElementById(saved.id) : (typeof saved.className === "string" && saved.className ? container.getElementsByClassName(saved.className)[saved.index] : null);
      if (el && container.contains(el)) { el.scrollTop = saved.top; el.scrollLeft = saved.left; }
    });
    if (index >= 0) {
      var candidates = Array.from(container.querySelectorAll("input,select,textarea,button"));
      var target = active.id ? candidates.find(function (el) { return el.id === active.id; }) : null;
      if (!target && active.name) {
        var named = candidates.filter(function (el) { return el.name === active.name; });
        if (named.length === 1) target = named[0];
      }
      if (!target && active.tagName !== "BUTTON") target = candidates[index];
      if (target && target.tagName === active.tagName && target.type === active.type && target.name === active.name) {
        target.focus({ preventScroll: true });
        if (start !== null && start !== undefined && target.setSelectionRange) {
          try { target.setSelectionRange(start, end); } catch (e) { /* non-text input */ }
        }
      }
    }
  }

  PMS.dom = { h: h, clear: clear, html: html, on: on, affects: affects, refresh: refresh };
})(window.PMS);
