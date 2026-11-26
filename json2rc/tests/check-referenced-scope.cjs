// A string first written inside a referencedOperations group is defined only where the group
// is included, so a text after the group must write it again rather than reuse its id:
// RemoteComposeWriter.startReferencedOperations / endReferencedOperations push and pop a data
// scope (androidx b7682af3f82), as definePattern does. Also the writer's new operations
// (androidx 0d0f5ab0f6d, 7a96775051d, a34763e67a6): their bytes, field by field.
//   node tests/check-referenced-scope.cjs
const assert = require("assert");
const { convert } = require("../build/Parser.js");
const { Writer, modClipPath, modPropertyBundle } = require("../build/Writer.js");

const count = (bytes, s) => {
    const needle = Buffer.from(s, "utf8"), hay = Buffer.from(bytes);
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
    return n;
};
const header = { apiLevel: 7, width: 200, height: 100, profiles: 513 };

// Inside the group first, then outside: written twice.
const inside = convert({ header, root: { column: { children: [
    { referencedOperations: { name: "greeting", children: [{ text: { value: "Hello there" } }] } },
    { text: { value: "Hello there" } },
] } } });
assert.equal(count(inside, "Hello there"), 2, "a string first interned inside the group is written again after it");

// Outside first: the group reuses it (what was interned before a scope stays visible in it).
const before = convert({ header, root: { column: { children: [
    { text: { value: "Hello there" } },
    { referencedOperations: { name: "greeting", children: [{ text: { value: "Hello there" } }] } },
] } } });
assert.equal(count(before, "Hello there"), 1, "a string interned before the group is reused inside it");

// The new operations, as RemoteComposeBuffer writes them.
const w = new Writer(7, [], 0x201);
const at = w.buffer.index;
modClipPath(77)(w);
modPropertyBundle(10, 0, [15, 20], [11, 12])(w);
w.propertyBundleLookup(50, -1, 15, -99);
const dv = Buffer.from(w.encodeToByteArray()).subarray(at);
const ints = (off, n) => Array.from({ length: n }, (_, i) => dv.readInt32BE(off + 4 * i));
assert.equal(dv[0], 109); assert.deepEqual(ints(1, 1), [77]);
assert.equal(dv[5], 95); assert.deepEqual(ints(6, 8), [0, 10, 0, 2, 15, 11, 20, 12]);
assert.equal(dv[38], 96); assert.deepEqual(ints(39, 5), [0, 50, -1, 15, -99]);
assert.equal(dv.length, 59);
assert.throws(() => modPropertyBundle(1, 0, [1, 2], [3]), /2 property ids, 1 values/);
assert.throws(() => modPropertyBundle(1, 0, new Array(257).fill(1), new Array(257).fill(1)), /256 at most/);

console.log("check-referenced-scope: ok");
