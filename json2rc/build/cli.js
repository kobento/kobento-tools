// Plain JS so it needs no @types/node: json2rc [--compress] <in.json> <out.rc>
// --compress writes the document compressed (Header.COMPRESS, a zlib stream after the header).
const fs = require("fs");
const zlib = require("zlib");
const { convert, compressDocument } = require("./Parser");
const compress = process.argv.includes("--compress");
const a = process.argv.slice(2).filter((x) => x !== "--compress");
if (a.length < 2) { console.error("usage: cli.js [--compress] <in.json> <out.rc>"); process.exit(2); }
try {
    let out = convert(fs.readFileSync(a[0], "utf8"));
    if (compress) out = compressDocument(out, (b) => zlib.deflateSync(b));
    fs.writeFileSync(a[1], Buffer.from(out));
    console.error(`${out.length}`);
} catch (e) { console.error(`${e.name}: ${e.message}`); process.exit(1); }
