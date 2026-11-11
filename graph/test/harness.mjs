// harness.mjs — what the tests share: the graphs, converting a document to bytes (json2rc), and
// playing one in Kobento's TypeScript player.
//
// The player is ../kobento-ts (or $KOBENTO_TS) built for node (build-node/node-entry.js, and the
// `canvas` package it depends on). Without it the player tests skip.

import { readFileSync, readdirSync, existsSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GRAPH_DIR = path.join(here, "..");
const TOOLS = path.join(GRAPH_DIR, "..");
const require = createRequire(import.meta.url);

/** Every example and fixture graph: [{name, graph}]. */
export function graphs() {
    const out = [];
    for (const dir of ["examples", "test/fixtures"]) {
        const d = path.join(GRAPH_DIR, dir);
        for (const f of readdirSync(d).filter((f) => f.endsWith(".json")).sort()) {
            out.push({ name: f.replace(/\.json$/, ""), graph: JSON.parse(readFileSync(path.join(d, f), "utf8")) });
        }
    }
    return out;
}
export const graph = (name) => graphs().find((g) => g.name === name).graph;

const { convertWithSymbols } = require(path.join(TOOLS, "json2rc", "build", "Parser.js"));

/** A document's bytes and the ids json2rc gave its named values. */
export function toRc(doc) {
    const { bytes, symbols } = convertWithSymbols(doc);
    return { bytes, vars: symbols.variables };
}

const TS = process.env.KOBENTO_TS ?? path.join(TOOLS, "..", "kobento-ts");
const ENTRY = path.join(TS, "build-node", "node-entry.js");
let tsModules = null;
async function loadTs() {
    if (tsModules !== null) return tsModules;
    if (!existsSync(ENTRY)) return (tsModules = false);
    const { createCanvas } = createRequire(path.join(TS, "package.json"))("canvas");
    if (typeof globalThis.Path2D === "undefined") {
        globalThis.Path2D = class {
            constructor() { this._c = []; }
            moveTo(...a) { this._c.push(["moveTo", a]); } lineTo(...a) { this._c.push(["lineTo", a]); }
            quadraticCurveTo(...a) { this._c.push(["quadraticCurveTo", a]); }
            bezierCurveTo(...a) { this._c.push(["bezierCurveTo", a]); }
            arc(...a) { this._c.push(["arc", a]); } rect(...a) { this._c.push(["rect", a]); }
            closePath() { this._c.push(["closePath", []]); } addPath() {}
        };
    }
    tsModules = { createCanvas, ...(await import(pathToFileURL(ENTRY).href)) };
    return tsModules;
}
/** Whether the TypeScript player is there to play documents with. */
export const haveTs = async () => (await loadTs()) !== false;

/**
 * Plays a document in the TypeScript player at w x h for a few frames.
 * @returns {float(name), click(x, y) -> [actions], pixel(x, y) -> [r, g, b], vars}
 */
export async function play(doc, w, h, frames = 3) {
    const M = await loadTs();
    if (!M) throw new Error("no TypeScript player");
    const { bytes, vars } = toRc(doc);
    const { createCanvas, RemoteComposeBuffer, CoreDocument, CanvasPaintContext, WebRemoteContext } = M;
    const d = new CoreDocument();
    d.initFromBuffer(RemoteComposeBuffer.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    d.setWidth(w); d.setHeight(h);
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    const o = { fill: ctx.fill.bind(ctx), stroke: ctx.stroke.bind(ctx), clip: ctx.clip.bind(ctx) };
    const replay = (p) => { ctx.beginPath(); for (const [m, a] of p._c) ctx[m](...a); };
    ctx.fill = (p, r) => (p && p._c ? (replay(p), o.fill(r)) : o.fill(p, r));
    ctx.stroke = (p) => (p && p._c ? (replay(p), o.stroke()) : o.stroke(p));
    ctx.clip = (p, r) => (p && p._c ? (replay(p), o.clip(r)) : o.clip(p, r));
    const paint = new CanvasPaintContext(null, ctx);
    const remote = new WebRemoteContext(paint);
    remote.mWidth = w; remote.mHeight = h;
    d.initializeContext(remote);
    remote.loadFloat(5, w); remote.loadFloat(6, h);
    remote.setDensity?.(1);
    // No bounds animations: a layout a click changes is there on the next frame, not some way
    // through a transition on the wall clock.
    remote.setAnimationEnabled?.(false);
    remote.setPaintContext(paint); paint.setContext(remote);
    paint.createLayerCanvas = (cw, ch) => createCanvas(Math.max(1, cw), Math.max(1, ch)).getContext("2d");
    paint.loadBitmap = () => {};
    d.applyDataOperations(remote);
    // Paints until the document stops asking (a layout input a click changed takes a frame to
    // lay out again), at least `frames`.
    let t = 0;
    const frame = () => {
        for (let f = 0; f < 60 && (f < frames || d.needsRepaint() === 1); f++) {
            remote.setAnimationTime?.((t += 1) / 60);
            paint.reset?.(); paint.clearNeedsRepaint?.();
            d.paint(remote, -3);
        }
    };
    frame();
    const actions = [];
    d.addActionCallback({ onAction: (name, value) => actions.push({ name, value }) });
    d.addIdActionListener({ onAction: (id, metadata) => actions.push({ id, metadata }) });
    return {
        vars,
        float(name) {
            if (!(name in vars)) throw new Error(`no value named ${name}`);
            return remote.getFloat(vars[name]);
        },
        click(x, y) {
            actions.length = 0;
            d.onClick(remote, x, y);
            frame();
            return [...actions];
        },
        /** A drag from (x0, y0) to (x1, y1) in steps, released still (no fling). */
        drag(x0, y0, x1, y1, steps = 8) {
            remote.loadFloat(29 /* ID_TOUCH_EVENT_TIME */, t / 60);
            d.touchDown(remote, x0, y0); frame();
            for (let k = 1; k <= steps; k++) { d.touchDrag(remote, x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps); frame(); }
            d.touchUp(remote, x1, y1, 0, 0); frame();
        },
        pixel(x, y) {
            const p = ctx.getImageData(x, y, 1, 1).data;
            return [p[0], p[1], p[2]];
        },
    };
}
