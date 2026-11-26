// Compressed documents (Header.COMPRESS), as androidx Header.compressDocument writes them: the
// header as is plus a COMPRESS (31, INT) = 1 property, then Header.COMPRESSED_STREAM_MARKER (0x77,
// a reserved opcode) and every byte after the header as one zlib stream.
// Inflating gives back the original document byte for byte (Header.decompressDocument), and the
// CLI's --compress writes the same.
//
//   node json2rc/tests/check-compress.cjs
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { convert, compressDocument, isCompressedDocument } = require("../build/Parser.js");

const deflate = (b) => zlib.deflateSync(b);
const json = { header: { width: 200, height: 100, profiles: 513, contentDescription: "a card" },
    root: { type: "column", modifiers: ["fillMaxSize"], children: [0, 1, 2, 3].map((i) => ({ type: "text", text: `line ${i}` })) } };
const plain = convert(json);
const z = compressDocument(plain, deflate);

/** Header.decompressDocument: the header without COMPRESS, then the inflated operations (after the
 *  marker, when there is one: a stream written before it existed has none). */
function decompress(doc) {
    const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
    const parts = [Buffer.from(doc.subarray(0, 17))];
    let at = 17, kept = 0;
    for (let i = 0, n = dv.getInt32(13); i < n; i++) {
        const len = dv.getUint16(at + 2);
        if ((dv.getUint16(at) & 0x3ff) !== 31) { parts.push(Buffer.from(doc.subarray(at, at + 4 + len))); kept++; }
        at += 4 + len;
    }
    if (doc[at] === 0x77) at++;
    const out = Buffer.concat([...parts, zlib.inflateSync(doc.subarray(at))]);
    out.writeInt32BE(kept, 13);
    return out;
}

assert.equal(isCompressedDocument(plain), false);
assert.equal(isCompressedDocument(z), true);
assert.ok(z.length < plain.length, "smaller");
assert.deepEqual(decompress(z), Buffer.from(plain), "inflates to the original");
// The header stays readable: the same version and one more property, COMPRESS = DEFLATE last.
const zdv = new DataView(z.buffer, z.byteOffset, z.byteLength), pdv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
assert.equal(zdv.getInt32(1), pdv.getInt32(1));
assert.equal(zdv.getInt32(13), pdv.getInt32(13) + 1);
// The data starts with the marker; the zlib stream follows it.
const headerEnd = (() => { let at = 17; for (let i = 0, n = zdv.getInt32(13); i < n; i++) at += 4 + zdv.getUint16(at + 2); return at; })();
assert.equal(z[headerEnd], 0x77, "COMPRESSED_STREAM_MARKER after the header");
assert.equal(z[headerEnd + 1], 0x78, "then the zlib stream");
// Already compressed: a copy. A legacy header (no properties): refused.
assert.deepEqual(Buffer.from(compressDocument(z, deflate)), Buffer.from(z));
const legacy = Uint8Array.from(plain); legacy[1] = 0; legacy[2] = 0;
assert.throws(() => compressDocument(legacy, deflate), /properties/);

// The CLI.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json2rc-compress-"));
try {
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(json));
    execFileSync(process.execPath, [path.join(__dirname, "../build/cli.js"), "--compress", path.join(dir, "a.json"), path.join(dir, "a.rc")], { stdio: "pipe" });
    assert.deepEqual(fs.readFileSync(path.join(dir, "a.rc")), Buffer.from(z));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("check-compress: ok");
