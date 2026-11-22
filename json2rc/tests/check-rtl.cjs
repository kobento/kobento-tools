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
// A right-to-left row's children are converted in their JSON order and their bytes then put in
// the mirrored order, so the ids they get (components, texts) follow the JSON order. The twins
// below are written in the mirrored order: so that both get the same ids, a row's children
// carry their own component id ({"id": n}) and their strings are interned up front.
const LABELS = ["a", "b", "c", "1", "2", "x", "y", "+1", "555"];
const prelude = { type: "column", horizontalAlignment: "left", modifiers: [{ id: 900 }],
    children: LABELS.map((l, i) => ({ type: "text", text: l, textAlign: "left", modifiers: [{ id: 901 + i }] })) };
const doc = (root, extra = {}) => ({ header, ...extra, root: [prelude, root] });
// The converter's own ids (negative: a text's content, a layout's) are allocated as it converts,
// so they follow the JSON order too: they are compared by order of appearance, not by value.
function autoIdsRenamed(bytes) {
    const b = Buffer.from(bytes), seen = new Map();
    for (let i = 0; i + 3 < b.length; i++) {
        if (b[i] === 0xff && b[i + 1] === 0xff && b[i + 2] === 0xff && b[i + 3] >= 0xc0 && b[i + 3] !== 0xff) {
            const k = b[i + 3];
            if (!seen.has(k)) seen.set(k, 0xfe - seen.size);
            b[i + 3] = seen.get(k);
            i += 3;
        }
    }
    return b;
}
const same = (a, b, what) => assert.deepEqual(autoIdsRenamed(a), autoIdsRenamed(b), what);
const idOf = (t) => LABELS.includes(t) ? [{ id: 1000 + LABELS.indexOf(t) }] : [];
const text = (t, more = {}) => ({ type: "text", text: t, ...more, modifiers: [...idOf(t), ...(more.modifiers ?? [])] });
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
        // A flow keeps its children's order (where it wraps is not known), its lines at the right.
        { type: "flow", horizontalAlignment: mirrored ? "end" : "start",
          children: mirrored ? [mtext("x"), mtext("y")] : [text("x"), text("y")] },
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

// 6. Names declared in a row's first child are known to the children after it, though their
// bytes come later: a tree variable declared in the first child and read by the second.
const declares = {
    type: "row", children: [
        { type: "canvas", modifiers: [{ size: 10 }], commands: [{ variable: { name: "w", value: "componentWidth() * 2" } }] },
        { type: "canvas", modifiers: [{ size: 10 }], commands: [{ paint: { color: "#000000" } }, { drawCircle: { cx: "@w", cy: 5, radius: 2 } }] },
    ] };
assert.doesNotThrow(() => convert(doc(declares, { layoutDirection: "rtl" })), "a later sibling reads an earlier one's variable");
assert.notDeepEqual(Buffer.from(convert(doc(declares, { layoutDirection: "rtl" }))), Buffer.from(convert(doc(declares))), "and the order changed");

// 7. A text a row's children share is written ahead of them all, not after its first reader:
// right to left, the child that interned it comes last. Nested rows too.
{
    const t = (v) => ({ type: "text", text: v });
    const shared = { header, layoutDirection: "rtl", root: { type: "row", children: [
        t("pp"), { type: "row", children: [t("qq"), t("pp")] }, t("qq"), t("rr") ] } };
    const b = Buffer.from(convert(shared));
    const dataAt = (str) => b.indexOf(Buffer.from(str, "utf8"));
    // CoreText (239) ops: each is written after the DATA_TEXT of its string.
    const firstCoreText = b.indexOf(Buffer.from([0xef]), b.indexOf(Buffer.from("pp")) - 16);
    for (const str of ["pp", "qq", "rr"]) assert.ok(dataAt(str) < firstCoreText, `${str} written before the texts that show it`);
    // and the reordered row still converts to the right layout: the same bytes but for order.
    assert.equal(b.length, convert({ ...shared, layoutDirection: "ltr" }).length);
}
// A child with a global section (hoisted ahead of the root as it is written) in a reordered row.
assert.doesNotThrow(() => convert({ header, layoutDirection: "rtl", root: { type: "row", children: [
    { type: "canvas", modifiers: [{ size: 10 }], commands: [{ global: { commands: [
        { textSubtext: { text: "Off On ", start: 0, len: 3, varName: "st" } }] } }] },
    { type: "text", text: "pp" }, { type: "text", text: "Off On " } ] } }), "global in a reordered row");

// 8. A canvas is not mirrored, unless it asks to be (autoMirror): then its drawing is flipped
// about its middle, right to left only.
const arrow = (cmds, auto) => ({ type: "canvas", ...(auto ? { autoMirror: true } : {}),
    modifiers: [{ size: 24 }], commands: cmds });
const draw = [{ paint: { color: "#000000" } }, { drawLine: { x1: 4, y1: 12, x2: 20, y2: 12 } }];
same(convert(doc(arrow(draw, false), { layoutDirection: "rtl" })), convert(doc(arrow(draw, false))), "canvas kept");
same(convert(doc(arrow(draw, true))), convert(doc(arrow(draw, false))), "autoMirror left to right");
same(convert(doc(arrow(draw, true), { layoutDirection: "rtl" })),
     convert(doc(arrow([{ save: [{ translate: { dx: "componentWidth()", dy: 0 } }, { scale: { sx: -1, sy: 1 } }, ...draw] }], false))),
     "autoMirror right to left");

// 9. An unknown direction is refused.
assert.throws(() => convert(doc(screen(false), { layoutDirection: "upward" })), /layoutDirection/);

console.log("check-rtl: ok");
