// resources.bitmaps {"url": ...} (a json2rc extension: the reference JSON parser has no url
// key for bitmaps) writes DATA_BITMAP as RemoteComposeBuffer.storeBitmapUrl does:
// type PNG (1) and width in the first word, ENCODING_URL (1) and height in the second, the
// URL's UTF-8 bytes as the payload. 1x1 when no size is given, as storeBitmapUrl writes.
//
//   node json2rc/tests/check-bitmap-url.cjs
const assert = require("assert/strict");
const { convert } = require("../build/Parser.js");

const URL_ = "https://example.com/photos/lisbon.jpg";
function doc(bitmap) {
    return { header: { apiLevel: 7, width: 100, height: 100, profiles: 513 },
        resources: { bitmaps: { photo: bitmap } },
        root: { canvas: { modifiers: ["fillMaxSize"], commands: [
            { type: "drawScaledBitmap", image: "@photo", srcLeft: 0, srcTop: 0, srcRight: 400, srcBottom: 300,
              dstLeft: 0, dstTop: 0, dstRight: 100, dstBottom: 100, scaleType: 5 }] } } };
}
/** The DATA_BITMAP (opcode 101) operation in the bytes: [id, word1, word2, payload]. */
function bitmapOp(bytes) {
    const b = Buffer.from(bytes), want = Buffer.from(URL_, "utf8");
    const at = b.indexOf(want);
    assert.ok(at > 0, "the URL is in the document");
    const len = b.readInt32BE(at - 4);
    assert.equal(len, want.length, "the payload is the URL's bytes, length-prefixed");
    assert.equal(b[at - 17], 101, "DATA_BITMAP");
    return { id: b.readInt32BE(at - 16), w: b.readInt32BE(at - 12), h: b.readInt32BE(at - 8) };
}
let op = bitmapOp(convert(doc({ url: URL_, width: 400, height: 300 })));
assert.equal(op.w, (1 << 16) | 400, "type PNG << 16 | width");
assert.equal(op.h, (1 << 16) | 300, "ENCODING_URL << 16 | height");
op = bitmapOp(convert(doc({ url: URL_ })));
assert.equal(op.w, (1 << 16) | 1);
assert.equal(op.h, (1 << 16) | 1);
assert.throws(() => convert(doc({ url: "file:///etc/passwd" })), /url must start with/);
assert.throws(() => convert(doc({ url: URL_, width: 0, height: 3 })), /whole numbers/);
console.log("  bitmap url: ok");
