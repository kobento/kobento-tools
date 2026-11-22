// Right-to-left layout (the layoutDirection extension). Players have no layout direction: the
// converter resolves start and end to sides as it writes, as Compose's RemoteLayoutDirection
// does. So a right-to-left document is byte for byte the left-to-right document mirrored by
// hand: rows' children reversed and start <-> end in alignments, arrangements, text alignment,
// padding and rounded corners. Absolute words (left, right, topLeft ...) and canvases stay.
//
//   node json2rc/tests/check-rtl.cjs
const assert = require("assert/strict");
const { convert } = require("../build/Parser.js");

const header = { width: 360, height: 640, profiles: 513 };
const doc = (root, extra = {}) => ({ header, ...extra, root });
const same = (a, b, what) => assert.deepEqual(Buffer.from(a), Buffer.from(b), what);
const text = (t, more = {}) => ({ type: "text", text: t, ...more });
// A text as its mirrored twin writes it: its default alignment, start, is the end right to left.
const mtext = (t) => text(t, { textAlign: "end" });

// A screen with every mirrored thing in it, and its hand-mirrored twin.
const screen = (mirrored) => ({
    type: "column", horizontalAlignment: mirrored ? "end" : "start",
    modifiers: ["fillMaxSize", { padding: mirrored ? [24, 8, 16, 0] : [16, 8, 24, 0] },
        { padding: mirrored ? { start: 3, end: 1, top: 2 } : { start: 1, end: 3, top: 2 } }],
    children: [
        { type: "row", horizontalArrangement: mirrored ? "end" : "start",
          children: mirrored ? [mtext("c"), mtext("b"), mtext("a")] : [text("a"), text("b"), text("c")] },
        { type: "row", horizontalArrangement: "spaceBetween",
          children: mirrored ? [mtext("2"), mtext("1")] : [text("1"), text("2")] },
        { type: "box", horizontalAlignment: mirrored ? "start" : "end",
          modifiers: [{ clip: mirrored
              ? { type: "roundedRect", topStart: 4, topEnd: 12, bottomStart: 0, bottomEnd: 8 }
              : { type: "roundedRect", topStart: 12, topEnd: 4, bottomStart: 8, bottomEnd: 0 } }],
          children: [text("in a box", { textAlign: mirrored ? "end" : "start" })] },
        text("default alignment", mirrored ? { textAlign: "end" } : {}),
        text("centred", { textAlign: "center" }),
        { type: "flow", horizontalAlignment: mirrored ? "end" : "start",
          children: mirrored ? [mtext("y"), mtext("x")] : [text("x"), text("y")] },
    ],
});

// 1. The document's own layoutDirection.
same(convert(doc(screen(false), { layoutDirection: "rtl" })), convert(doc(screen(true))), "rtl document");
// "ltr" (or no layoutDirection) changes nothing.
same(convert(doc(screen(false), { layoutDirection: "ltr" })), convert(doc(screen(false))), "ltr document");

// 2. ConvertOptions.layoutDirection replaces the document's.
same(convert(doc(screen(false)), { layoutDirection: "rtl" }), convert(doc(screen(true))), "option rtl");
same(convert(doc(screen(false), { layoutDirection: "rtl" }), { layoutDirection: "ltr" }),
     convert(doc(screen(false))), "option ltr wins over the document");

// 3. Absolute words are not mirrored, and an absolutely arranged row keeps its order.
const absolute = {
    type: "column", horizontalAlignment: "left",
    modifiers: [{ padding: { left: 5, right: 9 } },
        { clip: { type: "roundedRect", topLeft: 10, topRight: 0, bottomLeft: 0, bottomRight: 10 } }],
    children: [
        { type: "row", horizontalArrangement: "right",
          children: [text("a", { textAlign: "left" }), text("b", { textAlign: "right" })] },
        text("left", { textAlign: "left" }), text("right", { textAlign: "right" }),
    ],
};
same(convert(doc(absolute, { layoutDirection: "rtl" })), convert(doc(absolute)), "absolute words");
// left / right are START / END on the wire, as start / end are left to right.
const words = (h, a) => ({ type: "column", horizontalAlignment: h,
    children: [{ type: "row", horizontalArrangement: a, children: [text("a")] }] });
same(convert(doc(words("left", "right"))), convert(doc(words("start", "end"))), "left/right are the sides");

// 4. A component's layoutDirection holds for its subtree (a phone number in a right-to-left screen).
const phone = (rtlOuter) => ({
    type: "column", horizontalAlignment: rtlOuter ? "end" : "start", children: [
        { type: "row", horizontalArrangement: rtlOuter ? "end" : "start",
          children: rtlOuter ? [mtext("2"), mtext("1")] : [text("1"), text("2")] },
        { type: "row", layoutDirection: "ltr", children: [text("+1"), text("555")] },
    ] });
same(convert(doc(phone(false), { layoutDirection: "rtl" })), convert(doc(phone(true))), "ltr subtree");
const nested = { type: "column", children: [{ type: "row", layoutDirection: "rtl", children: [text("1"), text("2")] }] };
const nestedMirrored = { type: "column", children: [{ type: "row", horizontalArrangement: "end",
    children: [mtext("2"), mtext("1")] }] };
same(convert(doc(nested)), convert(doc(nestedMirrored)), "rtl subtree in an ltr document");

// 5. A row's children that are not laid out stay ahead of the reversed ones, in their order.
const withRem = (m) => ({ type: "row", horizontalArrangement: m ? "end" : "start", children: m
    ? [{ type: "rem", text: "note" }, mtext("b"), mtext("a")]
    : [text("a"), { type: "rem", text: "note" }, text("b")] });
same(convert(doc(withRem(false), { layoutDirection: "rtl" })), convert(doc(withRem(true))), "rem kept");

// 6. A canvas is not mirrored, unless it asks to be (autoMirror): then its drawing is flipped
// about its middle, right to left only.
const arrow = (cmds, auto) => ({ type: "canvas", ...(auto ? { autoMirror: true } : {}),
    modifiers: [{ size: 24 }], commands: cmds });
const draw = [{ paint: { color: "#000000" } }, { drawLine: { x1: 4, y1: 12, x2: 20, y2: 12 } }];
same(convert(doc(arrow(draw, false), { layoutDirection: "rtl" })), convert(doc(arrow(draw, false))), "canvas kept");
same(convert(doc(arrow(draw, true))), convert(doc(arrow(draw, false))), "autoMirror left to right");
same(convert(doc(arrow(draw, true), { layoutDirection: "rtl" })),
     convert(doc(arrow([{ save: [{ translate: { dx: "componentWidth()", dy: 0 } }, { scale: { sx: -1, sy: 1 } }, ...draw] }], false))),
     "autoMirror right to left");

// 7. An unknown direction is refused.
assert.throws(() => convert(doc(screen(false), { layoutDirection: "upward" })), /layoutDirection/);

console.log("check-rtl: ok");
