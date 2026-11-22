// Compute blocks that record (json2rc extension): a "floatList" variable, and in a
// computeMeasure / computePosition block "@bounds" (the component's box), "record" into a list
// at an index, and "set" a float variable.
//   node tests/check-compute-record.cjs
const assert = require("assert");
const { convert } = require("../build/Parser.js");
const doc = (record, extra = {}) => ({ header: { apiLevel: 7, width: 200, height: 100, profiles: 513 },
    resources: { variables: { seen: { value: 0, export: true } } },
    root: [{ variable: { name: "heights", vtype: "floatList", size: 4 } },
           { box: { modifiers: ["fillMaxSize"], children: [
               { text: { value: "Row", modifiers: [{ computeMeasure: { record, ...extra } }] } }] } }] });
const count = (b, op) => { let n = 0; for (let i = 0; i < b.length; i++) if (b[i] === op) n++; return n; };
// A list: DYNAMIC_FLOAT_LIST (197) for it and for the block's bounds; a record: an
// UPDATE_DYNAMIC_FLOAT_LIST (198) into the list, reading the bounds.
const one = convert(doc({ into: "@heights", at: 2, value: "arrayGet(@bounds, 3)" }));
assert.ok(count(one, 197) >= 2, "the list and the bounds");
assert.ok(count(one, 198) >= 1, "the record");
// Several records, and a set: the set is a float expression (ANIMATED_FLOAT, 81) in the block.
const two = convert(doc([{ into: "@heights", at: 0, value: "arrayGet(@bounds, 3)" }, { set: "@seen", value: "arrayGet(@bounds, 2)" }]));
assert.ok(count(two, 198) > count(one, 198) - 1);
assert.ok(two.length > one.length);
// Errors name the problem.
assert.throws(() => convert(doc({ into: "@nope", at: 0, value: 1 })), /not a float list/);
assert.throws(() => convert(doc({ into: "@heights", value: 1 })), /each "record" is/);
assert.throws(() => convert(doc({ set: "@missing", value: 1 })), /not a float variable/);
assert.throws(() => convert({ header: { apiLevel: 7, width: 10, height: 10, profiles: 513 }, root: [{ variable: { name: "l", vtype: "floatList" } }] }), /needs a "size"/);
// "@bounds" outside a block is unknown.
assert.throws(() => convert({ header: { apiLevel: 7, width: 10, height: 10, profiles: 513 }, root: [{ variable: { name: "x", value: "arrayGet(@bounds, 3)" } }] }));
// A float list declared in resources (evaluated before any layout, as the tree's is not on Java).
const res = convert({ header: { apiLevel: 7, width: 10, height: 10, profiles: 513 },
    resources: { variables: { l: { vtype: "floatList", size: 4 }, x: "arrayGet(@l, 1) + 1" } }, root: { box: { modifiers: ["fillMaxSize"] } } });
assert.ok(count(res, 197) >= 1, "the list in resources");
assert.throws(() => convert({ header: { apiLevel: 7, width: 10, height: 10, profiles: 513 }, resources: { variables: { l: { vtype: "floatList" } } }, root: { box: {} } }), /needs a "size"/);
console.log("check-compute-record: ok");
