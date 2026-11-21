"use strict";
/**
 * Compressed documents, as androidx remote-core Header.compressDocument writes them: the header
 * stays as it is (so a player can still read its version and properties), with a COMPRESS
 * property (tag 31, INT) = 1 (DEFLATE) appended and the property count raised by one; every byte
 * after the header becomes ONE zlib (RFC 1950) stream. Players that know the flag (androidx with
 * Header.COMPRESS, Kobento's TypeScript and C++ players) inflate it while loading; others stop on
 * opcode 120 (0x78, the zlib stream's first byte, reserved for this in Operations).
 *
 * The deflate function is passed in (node's zlib.deflateSync, or any zlib encoder), so the
 * converter itself stays free of platform modules. Java uses java.util.zip.Deflater with its
 * defaults (level 6); zlib's defaults are the same, but two zlib builds may still emit different
 * bytes for the same input: compare compressed documents by what they inflate to.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCompressedDocument = isCompressedDocument;
exports.compressDocument = compressDocument;
const HEADER_OP = 0;
const COMPRESS = 31;
const DATA_TYPE_INT = 0;
const COMPRESSION_NONE = 0;
const COMPRESSION_DEFLATE = 1;
/** The modern (properties) header at the start of a document, or null when there is none. */
function readHeader(doc) {
    if (doc.length < 17 || doc[0] !== HEADER_OP)
        return null;
    const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
    const major = dv.getInt32(1);
    if ((major & 0xffff0000) !== 0x048c0000)
        return null; // a legacy header: no properties
    const countAt = 13;
    const count = dv.getInt32(countAt);
    let at = 17, compress = null;
    for (let i = 0; i < count; i++) {
        if (at + 4 > doc.length)
            throw new Error("compressDocument: truncated header");
        const tag = dv.getUint16(at) & 0x3ff, len = dv.getUint16(at + 2);
        if (tag === COMPRESS && len === 4)
            compress = dv.getInt32(at + 4);
        at += 4 + len;
    }
    if (at > doc.length)
        throw new Error("compressDocument: truncated header");
    return { size: at, countAt, count, compress };
}
/** True when the document's header says its operations are compressed. */
function isCompressedDocument(doc) {
    const h = readHeader(doc);
    return !!h && h.compress !== null && h.compress !== COMPRESSION_NONE;
}
/**
 * The document compressed (Header.compressDocument). A document that is already compressed comes
 * back as a copy; one without a properties header (API level < 7) cannot be compressed.
 */
function compressDocument(doc, deflate) {
    const h = readHeader(doc);
    if (!h)
        throw new Error("compressDocument: compression needs a header with properties (API level 7+)");
    if (h.compress !== null && h.compress !== COMPRESSION_NONE)
        return doc.slice();
    // The header without any COMPRESS property (as copyHeaderWithoutCompress), then ours.
    const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
    const parts = [doc.subarray(0, 17)];
    let kept = 0;
    for (let at = 17; at < h.size;) {
        const len = dv.getUint16(at + 2);
        if ((dv.getUint16(at) & 0x3ff) !== COMPRESS) {
            parts.push(doc.subarray(at, at + 4 + len));
            kept++;
        }
        at += 4 + len;
    }
    const prop = new Uint8Array(8);
    const pv = new DataView(prop.buffer);
    pv.setUint16(0, COMPRESS | (DATA_TYPE_INT << 10));
    pv.setUint16(2, 4);
    pv.setInt32(4, COMPRESSION_DEFLATE);
    parts.push(prop);
    parts.push(deflate(doc.subarray(h.size)));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    new DataView(out.buffer).setInt32(h.countAt, kept + 1);
    return out;
}
