// resources.textStyles (json2rc extension): named TEXT_STYLE operations, a style inheriting
// from one declared before it ("parent"), and a text naming one ("textStyle"). The reference
// JSON parser can only take a raw "textStyleId", so no JSON document could define a style.
//   node tests/check-text-styles.cjs
const assert = require("assert");
const { convert } = require("../build/Parser.js");

const doc = (text, styles, extra = {}) => ({
    header: { apiLevel: 7, width: 200, height: 100, profiles: 513 },
    resources: { colors: { accent: "#FF1565D8" }, textStyles: styles },
    root: { column: { children: [{ text: { value: "Hi", ...text } }] } }, ...extra });
const styles = {
    body: { fontSize: 20, color: "@colors.accent", fontFamily: "serif", textAlign: "center" },
    done: { parent: "body", strikethrough: true, color: "#FF888888" },
};

// Each TEXT_STYLE: [id, {tag: raw int or bool}] in the order written.
function textStyles(bytes) {
    const out = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 3; i++) {
        if (bytes[i] !== 242) continue;
        const n = dv.getInt16(i + 1);
        if (n < 1 || n > 26 || bytes[i + 3] !== 1) continue;  // the id comes first
        let p = i + 3; const tags = {}; const order = [];
        for (let k = 0; k < n; k++) {
            const tag = bytes[p++]; order.push(tag);
            if (tag === 18 || tag === 19 || tag === 22) tags[tag] = bytes[p++] === 1;
            else { tags[tag] = dv.getInt32(p); p += 4; }
        }
        out.push({ id: tags[1], tags, order });
    }
    return out;
}
const f32 = (bits) => new Float32Array(new Int32Array([bits]).buffer)[0];

const bytes = convert(doc({ textStyle: "done" }, styles));
const [body, done] = textStyles(bytes);
assert.ok(body && done, "two TEXT_STYLE operations");
assert.deepEqual(body.order, [1, 4, 5, 8, 9], "body: id, colorId, fontSize, fontFamily, textAlign, in TextStyle.apply's order");
assert.equal(f32(body.tags[5]), 20, "the size");
assert.equal(body.tags[9], 3, "center");
assert.deepEqual(done.order, [1, 3, 19, 24], "done: id, color, strikethrough, parentId");
assert.equal(done.tags[24], body.id, "done's parent is body");
assert.equal(done.tags[3] >>> 0, 0xFF888888, "its own colour");

// The text names "done" (P_PARENT_ID 24 on CORE_TEXT) and leaves size and alignment at the
// reference defaults (absent), so the style's apply.
const coreText = (b) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < b.length - 7; i++) {
        if (b[i] !== 239) continue;
        const n = dv.getInt16(i + 5);
        if (n < 0 || n > 30) continue;
        let p = i + 7; const tags = {};
        for (let k = 0; k < n; k++) {
            const tag = b[p++];
            if (tag === 18 || tag === 19 || tag === 22) tags[tag] = b[p++] === 1;
            else if (tag >= 1 && tag <= 26) { tags[tag] = dv.getInt32(p); p += 4; } else return null;
        }
        if (p <= b.length) return tags;
    }
    return null;
};
const t = coreText(bytes);
assert.equal(t[24], done.id, "the text names its style");
assert.ok(!(5 in t), "no font size of its own (the style's applies)");
assert.ok(!(9 in t), "no alignment of its own (the style's applies)");

// A text's own value still wins, and a text with no style keeps the dp default size.
const own = coreText(convert(doc({ textStyle: "body", fontSize: 12, textAlign: "end" }, styles)));
assert.equal(f32(own[5]), 12); assert.equal(own[9], 6);
const dense = coreText(convert({ ...doc({}, styles), header: { apiLevel: 7, width: 200, height: 100, profiles: 513 } }, { density: 2 }));
assert.equal(f32(dense[5]), 72, "no style: the default size scaled by density");
const denseStyled = coreText(convert(doc({ textStyle: "body" }, styles), { density: 2 }));
assert.ok(!(5 in denseStyled), "styled: the reference default, so the style's (scaled) size applies");

// Errors name what is wrong.
assert.throws(() => convert(doc({ textStyle: "nope" }, styles)), /textStyle "nope" is not declared.*body, done/);
assert.throws(() => convert(doc({}, { a: { parent: "b" }, b: {} })), /parent "b" is not declared before it/);
assert.throws(() => convert(doc({}, { a: { fontsize: 3 } })), /unknown property "fontsize"/);
console.log("check-text-styles: ok");
