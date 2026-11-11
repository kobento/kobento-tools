// graph2rc — a JSON graph description -> RemoteCompose JSON (for json2rc).
//
//   node graph/graph2rc.mjs graph.json out.json [--mode reflow|canvas]
//        [--direction TB|LR|auto] [--width N] [--height N]
//
// Input:
//   { "nodes": [{"id": "a", "label": "Start", "color": "#FF1E293B", "look": "pill", "data": {...}}],
//     "edges": [{"from": "a", "to": "b", "color": "#FF64748B"}, ...],
//     "direction": "TB" | "LR" | "auto",                         (reflow only; default auto)
//     "style": {"look": "card"}, "looks": {...} }               (see looks.mjs)
//
// Both modes share layered.mjs: cycles broken by reversing back edges, longest-path ranks,
// one dummy per rank a long edge crosses, barycenter crossing reduction.
//
// reflow — the converter fixes the structure, RemoteCompose does the geometry. Ranks are
//   Rows in a Column (TB) or Columns in a Row (LR); each node is its look's `layout`, laid
//   out by the engine, so the graph reflows on the device. Every node is flanked by two 0x0
//   anchor canvases on its ports (a dummy is one anchor), each binding its root position
//   through json2rc's `componentValues`; a canvas over the graph draws each edge segment as a
//   pathExpression over those positions, so the curves follow the nodes. Anchors are canvases
//   because androidx's player only refreshes COMPONENT_VALUEs for a canvas. `auto` holds both
//   orientations in a StateLayout and shows the one that overflows the space less.
//
// canvas — the converter computes all geometry (text widths estimated, see measureLabel) and
//   draws one fixed picture with the looks' `canvas` commands. Drag pans (touchExpression,
//   coasting), the + / - buttons zoom (animated); the graph starts fitted to the view, and
//   labels drop out when they would be too small to read.
//
// Edges in both modes are the same curve: a cubic with its control points halfway along the
// flow, so it leaves and enters every node (and passes every dummy) along the flow direction
// and long edges are one smooth line. It stops short of its target for the arrowhead.

import { readFileSync, writeFileSync } from "fs";
import { layered, coordinates } from "./layered.mjs";
import { THEME, fill, lookFor, lookSize } from "./looks.mjs";

const ARROW = 9;        // arrowhead length; edges end this far before their target port
const EDGE_WIDTH = 1.75;
const SPACING = { TB: { node: 24, rank: 56 }, LR: { node: 16, rank: 72 } };

/** Arrowhead with its tip at the origin, pointing along the flow (or against it). */
function arrowPath(tb, back) {
    const s = back ? -1 : 1, a = ARROW, h = 4.5;
    return tb ? `M0 0 L${-h} ${-a * s} L${h} ${-a * s} Z` : `M0 0 L${-a * s} ${-h} L${-a * s} ${h} Z`;
}

/**
 * The flow and cross shapes of an edge segment, t in [0, 1]: across the flow it eases
 * (t²(3 - 2t), the control points' cross coordinate equals the end's), along it it is the
 * cubic with both control points at the midpoint: 1.5 t (1 - t) + t³.
 */
const EASE = "a[0] * a[0] * (3 - 2 * a[0])";
const ALONG = "(1.5 * a[0] * (1 - a[0]) + a[0] * a[0] * a[0])";

// ───────────────────────────────── reflow ─────────────────────────────────

function reflowVariant(graph, L, dir, prefix) {
    const tb = dir === "TB";
    // Variable names from an index, not the node id: ids are user strings.
    const index = new Map([...L.nodes.keys()].map((id, i) => [id, i]));
    const anchor = (id, port) => ({ canvas: {
        componentValues: { [`${prefix}${index.get(id)}${port}x`]: "rootX",
                           [`${prefix}${index.get(id)}${port}y`]: "rootY" },
        modifiers: [{ size: [0, 0] }], commands: [],
    } });
    const node = (id) => {
        const n = L.nodes.get(id);
        if (n.dummy) return anchor(id, "a");
        const { name, look, vars } = lookFor(graph, n);
        if (!look.layout) throw new Error(`look "${name}" has no layout (needed by reflow mode)`);
        const kids = [anchor(id, "a"), fill(look.layout, vars, `node ${id}, look "${name}"`), anchor(id, "b")];
        return tb ? { column: { horizontalAlignment: "center", children: kids } }
                  : { row: { verticalAlignment: "center", children: kids } };
    };
    // Port a is where edges come in (top / left), b where they leave; a dummy's one anchor is both.
    const v = (id, p, axis) => `@${prefix}${index.get(id)}${L.nodes.get(id).dummy ? "a" : p}${axis}`;
    const [F, X] = tb ? ["y", "x"] : ["x", "y"];          // flow axis, cross axis
    const g = (axis) => `@${prefix}g${axis}`;

    const commands = [];
    L.chains.forEach(({ edge, path, reversed, offset }, i) => {
        const color = edge.color ?? THEME.edge;
        commands.push({ paint: { ops: [{ color }, { style: "stroke" }, { width: EDGE_WIDTH }, { strokeCap: "round" }] } });
        const last = path.length - 2;
        for (let k = 0; k <= last; k++) {
            const a = path[k], b = path[k + 1];
            // Pull back the end that carries the arrowhead.
            const s0 = reversed && k === 0 ? ARROW : 0, s1 = !reversed && k === last ? ARROW : 0;
            const off = offset ? ` + ${offset}` : "";
            const cross = `${v(a, "b", X)} - ${g(X)}${off} + (${v(b, "a", X)} - ${v(a, "b", X)}) * ${EASE}`;
            const along = `${v(a, "b", F)} - ${g(F)}${s0 ? ` + ${s0}` : ""} + (${v(b, "a", F)} - ${v(a, "b", F)}${s0 + s1 ? ` - ${s0 + s1}` : ""}) * ${ALONG}`;
            const id = `${prefix}e${i}s${k}`;
            commands.push(
                { pathExpression: { id, expressionX: tb ? cross : along, expressionY: tb ? along : cross,
                                    start: 0, end: 1, count: 24 } },
                { drawPath: { path: id } });
        }
        const [tip, port] = reversed ? [path[0], "b"] : [path[path.length - 1], "a"];
        const tx = `${v(tip, port, "x")} - ${g("x")}${offset && tb ? ` + ${offset}` : ""}`;
        const ty = `${v(tip, port, "y")} - ${g("y")}${offset && !tb ? ` + ${offset}` : ""}`;
        commands.push({ save: { commands: [
            { translate: { dx: tx, dy: ty } },
            { paint: { ops: [{ style: "fill" }] } },
            { drawPath: { path: arrowPath(tb, reversed) } },
        ] } });
    });

    const sp = SPACING[dir];
    const rank = (l) => tb
        ? { row: { verticalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: l.map(node) } }
        : { column: { horizontalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: l.map(node) } };
    const ranks = { horizontalAlignment: "center", verticalAlignment: "center",
                    modifiers: ["fillMaxSize", { padding: [16, 16] }, { spacedBy: sp.rank }],
                    children: L.layers.map(rank) };
    return { box: {
        modifiers: ["fillMaxSize"],
        children: [
            tb ? { column: ranks } : { row: ranks },
            { canvas: { componentValues: { [`${prefix}gx`]: "rootX", [`${prefix}gy`]: "rootY" },
                        modifiers: ["fillMaxSize"], commands } },
        ],
    } };
}

export function reflowDoc(graph, { width = 400, height = 500, direction, measure = measureLabel } = {}) {
    const L = layered(graph);
    const dir = String(direction ?? graph.direction ?? "auto").toUpperCase();
    const doc = {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        root: [],
    };
    let children;
    if (dir === "TB" || dir === "LR") {
        children = [reflowVariant(graph, L, dir, "v")];
    } else {
        // 0: top to bottom, 1: left to right: whichever overflows the space less, from both
        // layouts' sizes estimated from the looks (the engine's own measure is not known when
        // the state is picked). The space is measured by a canvas filling the graph's box, not
        // windowWidth(): androidx's player keeps that at the document's declared size, while
        // Kobento's players give the viewport. Until that canvas is laid out its values hold
        // the 1.0 placeholder and the windowWidth() guess stands, so the usual case starts in
        // the right state with no cross-fade.
        const { tb: [tbW, tbH], lr: [lrW, lrH] } = estimateSizes(graph, L, measure);
        const pick = (w, h) => `step(max(${tbW} / ${w}, ${tbH} / ${h}), max(${lrW} / ${w}, ${lrH} / ${h}))`;
        doc.resources = { variables: { orientWindow: pick("max(windowWidth(), 1)", "max(windowHeight(), 1)") } };
        children = [
            { canvas: { modifiers: ["fillMaxSize"], commands: [], componentValues: {
                availW: "width", availH: "height",
                orientMeasured: { expression: pick("max(@availW, 1)", "max(@availH, 1)") },
                orient: { expression: "ifElse(@orientWindow, @orientMeasured, @availW - 1.5)" },
            } } },
            { stateLayout: { indexId: "@orient", modifiers: ["fillMaxSize"],
                             children: [reflowVariant(graph, L, "TB", "t"), reflowVariant(graph, L, "LR", "l")] } },
        ];
    }
    doc.root.push({ box: { modifiers: ["fillMaxSize", { background: THEME.bg }], children } });
    return doc;
}

/** Rough [width, height] of the TB and LR reflow layouts, mirroring reflowVariant's spacing. */
function estimateSizes(graph, L, measure) {
    const dims = new Map();
    for (const n of L.nodes.values()) {
        dims.set(n.id, n.dummy ? { w: 0, h: 0 } : lookSize(lookFor(graph, n).look, n.label, measure));
    }
    const w = (id) => dims.get(id).w, h = (id) => dims.get(id).h;
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const R = L.layers.length, T = SPACING.TB, LR = SPACING.LR;
    const tbW = 32 + Math.max(...L.layers.map((l) => sum(l.map(w)) + T.node * (l.length - 1)));
    const tbH = 32 + T.rank * (R - 1) + sum(L.layers.map((l) => Math.max(0, ...l.map(h))));
    const lrW = 32 + LR.rank * (R - 1) + sum(L.layers.map((l) => Math.max(0, ...l.map(w))));
    const lrH = 32 + Math.max(...L.layers.map((l) => sum(l.map(h)) + LR.node * (l.length - 1)));
    const r = (x) => Math.ceil(x * 1.05);
    return { tb: [r(tbW), r(tbH)], lr: [r(lrW), r(lrH)] };
}

// ───────────────────────────────── canvas ─────────────────────────────────

/**
 * A label's width at `size`, from per-character advances close to the usual sans faces
 * (Roboto, Helvetica). The player draws with its own font, so looks keep generous padding
 * and draw labels centred: a small error shows as uneven margins, not overflow.
 */
export function measureLabel(s, size = 15) {
    let em = 0;
    for (const c of s) {
        if ("il.,:;'|!".includes(c)) em += 0.26;
        else if ("fjrtI ()[]".includes(c)) em += 0.33;
        else if ("mwMW".includes(c)) em += 0.86;
        else if (/[A-Z]/.test(c)) em += 0.66;
        else if (/[0-9]/.test(c)) em += 0.56;
        else em += 0.53;
    }
    return em * size;
}

const r1 = (x) => Math.round(x * 10) / 10;

export function canvasDoc(graph, { width = 400, height = 500, measure = measureLabel } = {}) {
    const L = layered(graph);
    const looks = new Map();
    for (const n of L.nodes.values()) if (!n.dummy) looks.set(n.id, lookFor(graph, n));
    const C = coordinates(L, (id) => lookSize(looks.get(id).look, L.nodes.get(id).label, measure),
                          { nodeSep: SPACING.TB.node, rankSep: SPACING.TB.rank });
    const rankOf = (id) => L.nodes.get(id).rank;
    const cy = (id) => C.rankTop[rankOf(id)] + C.rankH[rankOf(id)] / 2;
    const top = (id) => (L.nodes.get(id).dummy ? C.rankTop[rankOf(id)] : cy(id) - C.dim.get(id).h / 2);
    const bottom = (id) => (L.nodes.get(id).dummy ? C.rankTop[rankOf(id)] + C.rankH[rankOf(id)]
                                                  : cy(id) + C.dim.get(id).h / 2);

    const edgeCmds = [], arrowCmds = [];
    for (const { edge, path, reversed, offset } of L.chains) {
        // Out of the bottom of each node, across each dummy's rank band as a straight run, into
        // the top of the next: the same curve as reflow mode's, with fixed coordinates.
        const pts = [];
        path.forEach((id, k) => {
            const x = C.x.get(id) + offset;
            if (k > 0) pts.push([x, top(id)]);
            if (k + 1 < path.length) pts.push([x, bottom(id)]);
        });
        const tip = reversed ? [...pts[0]] : [...pts[pts.length - 1]];
        if (reversed) pts[0][1] += ARROW; else pts[pts.length - 1][1] -= ARROW;
        let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
        for (let i = 1; i < pts.length; i++) {
            const [px, py] = pts[i - 1], [qx, qy] = pts[i];
            if (i % 2 === 0) { d += ` L${r1(qx)} ${r1(qy)}`; continue; }   // inside a dummy's band
            const my = r1((py + qy) / 2);
            d += ` C${r1(px)} ${my} ${r1(qx)} ${my} ${r1(qx)} ${r1(qy)}`;
        }
        const color = edge.color ?? THEME.edge;
        edgeCmds.push({ paint: { ops: [{ color }, { style: "stroke" }, { width: EDGE_WIDTH }, { strokeCap: "round" }] } },
                      { drawPath: { path: d } });
        arrowCmds.push({ paint: { ops: [{ color }, { style: "fill" }] } },
                       { save: { commands: [{ translate: { dx: r1(tip[0]), dy: r1(tip[1]) } },
                                            { drawPath: { path: arrowPath(true, reversed) } }] } });
    }

    const nodeCmds = [], labelCmds = [];
    for (const [id, { name, look, vars }] of looks) {
        if (!look.canvas) throw new Error(`look "${name}" has no canvas drawing (needed by canvas mode)`);
        const { w, h } = C.dim.get(id), x = C.x.get(id), y = cy(id);
        const geo = { left: r1(x - w / 2), top: r1(y - h / 2), right: r1(x + w / 2), bottom: r1(y + h / 2),
                      cx: r1(x), cy: r1(y), w, h, radius: r1(h / 2) };
        const all = { ...vars, ...geo };
        nodeCmds.push(...fill(look.canvas.commands ?? [], all, `node ${id}, look "${name}"`));
        labelCmds.push(...fill(look.canvas.label ?? [], all, `node ${id}, look "${name}"`));
    }

    const GW = Math.max(1, Math.ceil(C.width)), GH = Math.max(1, Math.ceil(C.height));
    // Fitted scale (never past 1.5x), times the user's zoom steps, animated.
    const scale = `min(min((width - 32) / ${GW}, (height - 32) / ${GH}), 1.5) * @zoom`;
    const zoomButton = (step, label, glyph) => ({ canvas: {
        modifiers: [{ size: [40, 40] },
                    { semantics: { contentDescription: label, clickable: true } },
                    { onClick: { type: "valueFloatExpressionChange", target: "@zoomSteps",
                                 value: `clamp(-8, 8, @zoomSteps + ${step})` } }],
        commands: [
            { paint: { ops: [{ color: THEME.button }, { style: "fill" }] } },
            { drawRoundRect: { left: 0.5, top: 0.5, right: 39.5, bottom: 39.5, rx: 12, ry: 12 } },
            { paint: { ops: [{ color: THEME.outline }, { style: "stroke" }, { width: 1 }] } },
            { drawRoundRect: { left: 0.5, top: 0.5, right: 39.5, bottom: 39.5, rx: 12, ry: 12 } },
            { paint: { ops: [{ color: THEME.buttonFg }, { style: "stroke" }, { width: 2 }, { strokeCap: "round" }] } },
            ...glyph,
        ],
    } });
    const minus = { drawLine: { x1: 14, y1: 20, x2: 26, y2: 20 } };
    const plus = { drawLine: { x1: 20, y1: 14, x2: 20, y2: 26 } };

    return {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        resources: { variables: {
            zoomSteps: 0,
            zoom: { value: "pow(1.25, @zoomSteps)", anim: 0.25 },
        } },
        root: [{ box: {
            modifiers: ["fillMaxSize", { background: THEME.bg }],
            children: [
                { canvas: {
                    modifiers: ["fillMaxSize", { semantics: { contentDescription: `${describe(graph)}. Drag to pan.` } }],
                    commands: [
                        { touchExpression: { name: "panX", defaultValue: 0, min: -100000, max: 100000, stopMode: "gently", expression: "touchX()" } },
                        { touchExpression: { name: "panY", defaultValue: 0, min: -100000, max: 100000, stopMode: "gently", expression: "touchY()" } },
                        { save: { commands: [
                            { translate: { dx: "width * 0.5 + @panX", dy: "height * 0.5 + @panY" } },
                            { scale: { sx: scale, sy: scale } },
                            { translate: { dx: -GW / 2, dy: -GH / 2 } },
                            ...edgeCmds, ...arrowCmds, ...nodeCmds,
                            // Labels only while they are legible (about 6px and up at 15).
                            { conditionalOperations: { condition: "ge", v1: `${scale} * 15`, v2: 6, commands: labelCmds } },
                        ] } },
                    ],
                } },
                { column: {
                    horizontalAlignment: "end", verticalAlignment: "bottom",
                    modifiers: ["fillMaxSize", { padding: [12, 12] }, { spacedBy: 8 }],
                    children: [zoomButton(1, "Zoom in", [minus, plus]), zoomButton(-1, "Zoom out", [minus])],
                } },
            ],
        } }],
    };
}

function describe(graph) {
    const n = (graph.nodes ?? []).length, e = (graph.edges ?? []).length;
    return `A graph of ${n} node${n === 1 ? "" : "s"} and ${e} edge${e === 1 ? "" : "s"}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [inPath, outPath, ...rest] = process.argv.slice(2);
    if (!inPath || !outPath) {
        console.error("usage: graph2rc.mjs graph.json out.json [--mode reflow|canvas] [--direction TB|LR|auto] [--width N] [--height N]");
        process.exit(2);
    }
    const opt = {};
    for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
    for (const k of ["width", "height"]) if (k in opt) opt[k] = Number(opt[k]);
    const graph = JSON.parse(readFileSync(inPath, "utf8"));
    const doc = (opt.mode ?? "reflow") === "canvas" ? canvasDoc(graph, opt) : reflowDoc(graph, opt);
    writeFileSync(outPath, JSON.stringify(doc, null, 1));
}
