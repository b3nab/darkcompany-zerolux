globalThis.__zeroluxModule(
  "ui/native/cards.js",
  function (module, exports, require) {
    var {
        defineProperty: i,
        getOwnPropertyNames: g,
        getOwnPropertyDescriptor: p,
      } = Object,
      m = Object.prototype.hasOwnProperty;
    function y(e) {
      return this[e];
    }
    var f = (e) => {
        var a = (c ??= new WeakMap()).get(e),
          n;
        if (a) return a;
        if (
          ((a = i({}, "__esModule", { value: !0 })),
          (e && typeof e === "object") || typeof e === "function")
        ) {
          for (var o of g(e))
            if (!m.call(a, o))
              i(a, o, {
                get: y.bind(e, o),
                enumerable: !(n = p(e, o)) || n.enumerable,
              });
        }
        return (c.set(e, a), a);
      },
      c;
    var h = (e) => e;
    function C(e, a) {
      this[e] = h.bind(null, a);
    }
    var k = (e, a) => {
      for (var n in a)
        i(e, n, {
          get: a[n],
          enumerable: !0,
          configurable: !0,
          set: C.bind(a, n),
        });
    };
    var S = {};
    k(S, { default: () => u });
    module.exports = f(S);
    var l = require("react"),
      t = require("@zerolux/ui"),
      d = require("react/jsx-runtime");
    function u() {
      let e = t.useActionResult("cards", {}),
        a = t.useAction("add"),
        n = t.useAction("done"),
        [o, r] = l.useState("");
      return (
        t.useEvent("zerolux.board/changed", () => e.reload()),
        d.jsxs(t.Stack, {
          gap: 12,
          children: [
            d.jsx(t.Heading, { children: "Cards" }),
            e.data?.cards.length
              ? d.jsx(t.List, {
                  children: e.data.cards.map((s) =>
                    d.jsx(
                      t.ListItem,
                      {
                        title: s.title,
                        accessory: s.done
                          ? d.jsx(t.Badge, { children: "Done" })
                          : void 0,
                        onPress: () => n.run({ id: s.id }),
                      },
                      s.id,
                    ),
                  ),
                })
              : d.jsx(t.Empty, { children: "No cards" }),
            d.jsxs(t.Stack, {
              direction: "horizontal",
              gap: 8,
              children: [
                d.jsx(t.Input, { value: o, onChange: r, placeholder: "Title" }),
                d.jsx(t.Button, {
                  title: "Add",
                  disabled: !o.trim(),
                  onPress: async () => {
                    (await a.run({ title: o }), r(""));
                  },
                }),
              ],
            }),
          ],
        })
      );
    }
  },
);
