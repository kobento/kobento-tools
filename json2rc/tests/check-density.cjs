// ConvertOptions.density: a document written in pixels for a screen of that density (a launcher's
// widget host lays documents out in pixels; the documents are in dp).
//   node tests/check-density.cjs
const assert = require("assert");
const { convert } = require("../build/Parser.js");
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const has = (bytes, v) => Buffer.from(bytes).indexOf(f32(v)) >= 0;
const doc = (extra = {}) => ({ header: { apiLevel: 7, width: 200, height: 100, profiles: 513, ...(extra.header ?? {}) },
    resources: { variables: { sy: { value: 0 }, half: "componentWidth() / 2", ...(extra.vars ?? {}) } },
    root: { column: { modifiers: ["fillMaxSize", { padding: 13 }, { verticalScroll: "@sy" }], children: [
        { text: { value: "Hi", fontSize: 17 } },
        { box: { modifiers: [{ width: 37 }, { height: "@sy * 3 + 5" }] } },
        { canvas: { modifiers: [{ size: 50 }], commands: [{ drawCircle: { cx: 25, cy: 25, radius: 9 } }] } }] } } });

// Density 1, or none: the bytes as before.
assert.deepStrictEqual(Buffer.from(convert(doc(), { density: 1 })), Buffer.from(convert(doc())));
const one = convert(doc()), two = convert(doc(), { density: 2 });
// Lengths times the density: padding, a width, a font size; a canvas keeps its own (dp) coordinates.
for (const v of [26, 74, 34]) assert.ok(has(two, v) && !has(one, v), `${v / 2} dp written as ${v} px`);
assert.ok(has(two, 25) && has(two, 9), "canvas coordinates stay in dp: the canvas is drawn scaled");
// An expression length gets the factor; the scroll position (pixels) is read through a dp companion.
assert.ok(two.length > one.length);
assert.doesNotThrow(() => convert(doc({ vars: { y: "@sy / 4" } }), { density: 2.625 }));
// A document in pixels already: as written.
const px = doc({ header: { apiLevel: 8, densityBehavior: 1 } });
assert.deepStrictEqual(Buffer.from(convert(px, { density: 3 })), Buffer.from(convert(px)));
// A document in dp for the player to scale: converted, and its density header dropped.
const dp = doc({ header: { apiLevel: 8, densityBehavior: 2 } });
const dp2 = convert(dp, { density: 2 });
assert.ok(has(dp2, 26) && !has(convert(dp), 26), "the conversion scales it");
console.log("check-density: ok");
