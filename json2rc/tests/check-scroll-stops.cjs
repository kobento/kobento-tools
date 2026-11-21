// How a scroll comes to rest. {"horizontalScroll": {"position", "notches": N}} is the reference
// form (DefaultModifierParsers -> RemoteComposeWriter.addModifierScroll(dir, pos, notches)): the
// scroll's TouchExpression stops at STOP_NOTCHES_EVEN with the spec [N, notchMax], notchMax being
// the id the player fills with the content size. The bytes of that form match the Java parser
// (conformance/java-json.sh). rcj extensions: stopMode, a notches expression, and stops for the
// percent and absolute modes.
//
//   node json2rc/tests/check-scroll-stops.cjs
const assert = require("assert/strict");
const { convert } = require("../build/Parser.js");

const NAN_ID = (bits) => ((bits & 0xff800000) >>> 0) === 0xff800000 && (bits & 0x7fffff) ? bits & 0x7fffff : null;
function doc(scroll, vars = {}) {
    return { header: { width: 360, height: 200 },
        resources: { variables: { pos: 0, n: 4, ...vars } },
        root: { type: "row", modifiers: ["fillMaxSize", { horizontalScroll: scroll }],
            children: [0, 1, 2, 3].map(() => ({ type: "box", modifiers: [{ width: 360 }, { height: 200 }] })) } };
}
/** The scroll modifier and its touch expression: {notchMax, mode, spec: [raw bits]}. */
function scrollOf(json) {
    const b = Buffer.from(convert(json));
    for (let i = 0; i + 17 < b.length; i++) {
        if (b[i] !== 226) continue;                       // MODIFIER_SCROLL: dir, pos, max, notchMax
        const notchMax = NAN_ID(b.readInt32BE(i + 13));
        if (notchMax === null || b[i + 17] !== 157) continue;   // then TOUCH_EXPRESSION
        let k = i + 18 + 4 + 16 + 4;                      // id, default/min/max/velocity, effects
        const nExp = b.readInt32BE(k); k += 4 + 4 * nExp;
        const packed = b.readInt32BE(k); k += 4;
        const spec = [];
        for (let s = 0; s < (packed & 0xffff); s++, k += 4) spec.push(b.readInt32BE(k));
        return { notchMax, mode: packed >>> 16, spec };
    }
    assert.fail("no scroll modifier followed by its touch expression");
}
const f = (bits) => Buffer.from(Int32Array.of(bits).buffer).readFloatLE(0);

let s = scrollOf(doc("@pos"));
assert.deepEqual([s.mode, s.spec.length], [0, 0], "a plain scroll stops gently, no spec");

s = scrollOf(doc({ position: "@pos", notches: 4 }));
assert.equal(s.mode, 3, "notches: STOP_NOTCHES_EVEN");
assert.equal(f(s.spec[0]), 4);
assert.equal(NAN_ID(s.spec[1]), s.notchMax, "the second entry is the notchMax id");

s = scrollOf(doc({ position: "@pos", notches: 0 }));
assert.equal(s.mode, 0, "notches 0 is a free scroll, as in the reference");

s = scrollOf(doc({ position: "@pos", notches: 4, stopMode: "notchesSingleEven" }));
assert.equal(s.mode, 7);
assert.equal(f(s.spec[0]), 4);

s = scrollOf(doc({ position: "@pos", notches: "@n" }));
assert.equal(s.mode, 3);
assert.ok(NAN_ID(s.spec[0]) !== null, "a variable notch count is an id");

s = scrollOf(doc({ position: "@pos", stopMode: "notchesPercents", stops: [0, 0.5, 1] }));
assert.deepEqual([s.mode, s.spec.map(f)], [4, [0, 0.5, 1]]);
s = scrollOf(doc({ position: "@pos", stopMode: "notches_absolute", stops: [0, 200, 1080] }));
assert.deepEqual([s.mode, s.spec.map(f)], [5, [0, 200, 1080]]);
s = scrollOf(doc({ position: "@pos", stopMode: "ends" }));
assert.deepEqual([s.mode, s.spec.length], [2, 0]);

assert.throws(() => convert(doc({ position: "@pos", stopMode: "notchesEven" })), /needs notches/);
assert.throws(() => convert(doc({ position: "@pos", stopMode: "notchesAbsolute" })), /needs stops/);
assert.throws(() => convert(doc({ position: "@pos", stopMode: "bouncy" })), /expected one of/);
console.log("  scroll stops: ok");
