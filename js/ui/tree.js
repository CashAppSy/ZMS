/* ==========================================================================
   PMS.tree - collapsible tree component for nested projects / tasks.
   Usage: Tree(options) with nodes [{id, label, children[], collapsed}] and
   optional callbacks. Also a plain recursive HTML list builder for simple use.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;

  function Tree(options) {
    this.el = h("ul.tree");
    this.options = options || {};
    this.render(options.nodes || []);
  }

  Tree.prototype.render = function (nodes, parentEl) {
    var self = this;
    var bag = parentEl || self.el;
    nodes.forEach(function (node) {
      var hasChildren = node.children.length > 0;
      var li = h("li");
      var div = h("div.tree-node" + (node.collapsed ? ".collapsed" : "") + (node.selected ? ".selected" : ""), {
        dataset: { id: node.id },
        on: self.options.onNodeClick ? { click: function () { self.options.onNodeClick(node); } } : null
      });
      var toggle = h("span.tree-toggle", { text: "▾" });
      if (hasChildren) {
        toggle.addEventListener("click", function (e) {
          e.stopPropagation();
          div.classList.toggle("collapsed");
        });
      } else toggle.style.visibility = "hidden";
      div.appendChild(toggle);
      if (node.icon) div.appendChild(h("span", { text: node.icon }));
      if (node.render) div.appendChild(node.render(node));
      else div.appendChild(h("span", { text: node.label }));
      li.appendChild(div);
      if (hasChildren) {
        var ul = h("ul");
        self.render(node.children, ul);
        li.appendChild(ul);
      }
      bag.appendChild(li);
    });
  };

  Tree.prototype.getSelected = function () {
    return this.el.querySelector(".tree-node.selected");
  };

  PMS.treeService = { Tree: Tree };
})(window.PMS);