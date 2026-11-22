// A computed colour between two colours by a value (json2rc extension, ColorExpression's
// interpolate modes): {"mix": [a, b], "t": 0..1}, each end a literal or a declared colour.
//   node tests/check-color-mix.cjs
const assert = require("assert");
const { convert } = require("../build/Parser.js");
const ops = (bytes, op) => { let n = 0; for (let i = 0; i < bytes.length; i++) if (bytes[i] === op) n++; return n; };
const doc = (mix) => ({ header: { apiLevel: 7, width: 100, height: 60, profiles: 513 },
    resources: { colors: { accent: "#FF1565D8" }, variables: { on: { value: 1, export: true } } },
    root: [{ variable: { name: "ring", vtype: "color", value: mix } }, { box: { modifiers: [{ size: [100, 60] }, { background: "@ring" }] } }] });
// The mode word: bit 0 the first end is a colour id, bit 1 the second.
const modeOf = (bytes) => {
    for (let i = 0; i + 8 < bytes.length; i++) if (bytes[i] === 134) return new DataView(bytes.buffer, bytes.byteOffset + i + 5, 4).getInt32(0);
    return null;
};
assert.equal(modeOf(convert(doc({ mix: ["#00000000", "@accent"], t: "@on" }))), 2, "literal then id: COLOR_ID_INTERPOLATE");
assert.equal(modeOf(convert(doc({ mix: ["@accent", "#00000000"], t: 0.5 }))), 1, "id then literal: ID_COLOR_INTERPOLATE");
assert.equal(modeOf(convert(doc({ mix: ["@accent", "@colors.accent"], t: "@on" }))), 3, "two ids: ID_ID_INTERPOLATE");
assert.throws(() => convert(doc({ mix: ["#00000000"], t: 1 })), /takes \[a, b\]/);
assert.throws(() => convert(doc({ mix: ["#00000000", "@nope"], t: 1 })), /not declared/);
assert.throws(() => convert(doc({ mix: ["#00000000", "@accent"] })), /needs "t"/);
console.log("check-color-mix: ok");
