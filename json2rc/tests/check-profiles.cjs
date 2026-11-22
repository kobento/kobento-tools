// Profiles: a document may only contain the operations its header's profiles allow
// (Operations.createMapV7, generated into src/Profiles.ts by tools/gen-profiles.cjs), as
// androidx's writer and player enforce. Every refused operation is reported, not only the first.
//
//   node json2rc/tests/check-profiles.cjs
const assert = require("assert/strict");
const P = require("../build/Parser.js");

const header = (profiles) => ({ width: 100, height: 100, ...(profiles === undefined ? {} : { profiles }) });
const doc = (profiles, children) => ({ header: header(profiles), root: { column: { children } } });
const text = { text: { value: "hi" } };                 // CORE_TEXT (239): androidx or widgets
const flow = { flow: { children: [] } };                // LAYOUT_FLOW (240): their experimental sets
const input = { type: "textInput", text: "@q", children: [{ type: "text", text: "@q" }] };   // LAYOUT_TEXT_INPUT (60): androidx experimental only
const vars = { resources: { variables: {} } };

// 1. androidx + experimental (the default the MCP supplies) allows all three.
assert.doesNotThrow(() => P.convert(doc(513, [text, flow])));
// 2. Without experimental, the flow is refused, with the profiles that would allow it.
assert.throws(() => P.convert(doc(512, [text, flow])), /LAYOUT_FLOW needs "profiles": 513 \(androidx \+ experimental\) or 257 \(widgets \+ experimental\).*has "profiles": 512/);
// 3. Every refused operation is listed (one line each), not only the first met.
const q = { root: [{ variable: { name: "q", vtype: "string", value: "" } }] };
const withInput = (profiles) => ({ header: header(profiles), root: [...q.root, { column: { children: [flow, input] } }] });
assert.doesNotThrow(() => P.convert(withInput(513)));
try { P.convert(withInput(256)); assert.fail("refused"); }
catch (e) {
    assert.match(e.message, /LAYOUT_FLOW needs/); assert.match(e.message, /LAYOUT_TEXT_INPUT needs "profiles": 513 \(androidx \+ experimental\) in the header/);
    assert.equal(e.message.split("\n").length, 2, e.message);
}
// 4. ConvertOptions.profiles replaces the header's, and is written in the header.
assert.doesNotThrow(() => P.convert(doc(0, [text, flow]), { profiles: 257 }));
assert.deepEqual(Buffer.from(P.convert(doc(0, [text]), { profiles: 513 })), Buffer.from(P.convert(doc(513, [text]))));
// 5. Two families allow only what both allow: DATA_SHADER (45) is androidx's, not widgets'.
const shaderDoc = (profiles) => ({ header: header(profiles), root: { canvas: { modifiers: [{ size: 10 }], commands: [
    { paint: { runtimeShader: { agsl: "half4 main(float2 p) { return half4(1); }" } } },
    { drawRect: { left: 0, top: 0, right: 10, bottom: 10 } }] } } });
assert.doesNotThrow(() => P.convert(shaderDoc(512)));
assert.throws(() => P.convert(shaderDoc(768)), /DATA_SHADER needs "profiles": 512 \(androidx\)/);
// 6. The operations written, and the profiles, come back with the symbols.
const { symbols } = P.convertWithSymbols(doc(513, [text, flow]));
assert.equal(symbols.profiles, 513);
for (const op of [0, 239, 240]) assert.ok(symbols.operations.includes(op), `operation ${op} listed`);
// 7. allowedOperations mirrors createMapV7.
assert.ok(P.allowedOperations(513).has(240) && !P.allowedOperations(512).has(240) && P.allowedOperations(0).has(0));
assert.ok(P.allowedOperations(512).has(45) && !P.allowedOperations(768).has(45));
void vars;
console.log("check-profiles: ok");
