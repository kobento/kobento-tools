// graph2rc — a JSON graph description -> RemoteCompose JSON (for json2rc).
//
//   node graph/graph2rc.mjs graph.json out.json [--mode reflow|canvas]
//        [--direction TB|LR|auto] [--width N] [--height N]
//
// Input:
//   { "nodes": [{"id": "a", "label": "Start", "color": "#FF2B3A55"}, ...],
//     "edges": [{"from": "a", "to": "b", "color": "#FF8FA3BF"}, ...],
//     "direction": "TB" | "LR" | "auto" }                       (reflow only; default auto)
//
// Both modes share layered.mjs: cycles broken by reversing back edges, longest-path ranks,
// one dummy per rank a long edge crosses, barycenter crossing reduction.
//
// reflow — the converter fixes the structure, RemoteCompose does the geometry. Ranks are
//   Rows in a Column (TB) or Columns in a Row (LR); nodes are real Box+Text, so their size is
//   the engine's own text measurement and the layout reflows on the device. Every node is
//   flanked by two 0x0 anchor canvases on its ports (a dummy is one anchor), each binding its
//   root position through json2rc's `componentValues`; a canvas laid over the graph draws the
//   edges against those, so they follow the nodes. Anchors are canvases because androidx's
//   player only refreshes COMPONENT_VALUEs for a canvas. `auto` holds both orientations in a
//   StateLayout and picks LR when the window is landscape and wide enough for it.
//
// canvas — the converter computes all geometry (text widths estimated, see measureLabel) and
//   draws one fixed picture: curved edges through the dummies, rounded nodes. Drag pans
//   (touchExpression, coasting), the + / - buttons zoom (animated); the graph starts fitted to
//   the view, and labels drop out when they would be too small to read.

import { readFileSync, writeFileSync } from "fs";
import { layered, coordinates } from "./layered.mjs";

const THEME = { bg: "#FF101828", node: "#FF2B3A55", text: "#FFFFFFFF", edge: "#FF8FA3BF",
                button: "#CC2B3A55", buttonFg: "#FFE6ECF5" };
const FONT = 16;

// ───────────────────────────────── reflow ─────────────────────────────────

function reflowVariant(L, dir, prefix) {
    const tb = dir === "TB";
    // Variable names from an index, not the node id: ids are user strings.
    const index = new Map([...L.nodes.keys()].map((id, i) => [id, i]));
    const nv = (id, port, axis) => `@${prefix}${index.get(id)}${port}${axis}`;
    const anchor = (id, port) => ({ canvas: {
        componentValues: { [`${prefix}${index.get(id)}${port}x`]: "rootX",
                           [`${prefix}${index.get(id)}${port}y`]: "rootY" },
        modifiers: [{ size: [0, 0] }], commands: [],
    } });
    const node = (id) => {
        const n = L.nodes.get(id);
        if (n.dummy) return anchor(id, "a");
        const kids = [
            anchor(id, "a"),
            { box: {
                horizontalAlignment: "center", verticalAlignment: "center",
                modifiers: [{ background: n.color ?? THEME.node }, { padding: [14, 8] }],
                children: [{ text: { value: n.label, fontSize: FONT, color: THEME.text } }],
            } },
            anchor(id, "b"),
        ];
        return tb ? { column: { horizontalAlignment: "center", children: kids } }
                  : { row: { verticalAlignment: "center", children: kids } };
    };
    // Port a is where edges come in (top / left), b where they leave; a dummy's one anchor is both.
    const port = (id, p) => (L.nodes.get(id).dummy ? "a" : p);
    // `off` shifts across the edge (x in TB, y in LR) to separate parallel edges.
    const pt = (id, p, off = 0) => {
        const o = off ? ` + ${off}` : "";
        return [`${nv(id, port(id, p), "x")} - @${prefix}gx${tb ? o : ""}`,
                `${nv(id, port(id, p), "y")} - @${prefix}gy${tb ? "" : o}`];
    };
    const raw = (id, p) => [nv(id, port(id, p), "x"), nv(id, port(id, p), "y")];

    const commands = [];
    for (const { edge, path, reversed, offset } of L.chains) {
        commands.push({ paint: { ops: [{ color: edge.color ?? THEME.edge }, { style: "stroke" }, { width: 2 }] } });
        for (let k = 0; k + 1 < path.length; k++) {
            const [x1, y1] = pt(path[k], "b", offset), [x2, y2] = pt(path[k + 1], "a", offset);
            commands.push({ drawLine: { x1, y1, x2, y2 } });
        }
        // The arrowhead sits on the edge's real target: the lower end, or the upper one for a
        // reversed (cycle) edge, pointing along the segment that arrives there.
        const [tip, tipPort, from, fromPort] = reversed
            ? [path[0], "b", path[1], "a"] : [path[path.length - 1], "a", path[path.length - 2], "b"];
        const [tx, ty] = pt(tip, tipPort, offset);
        const [rtx, rty] = raw(tip, tipPort), [rfx, rfy] = raw(from, fromPort);
        commands.push({ save: { commands: [
            { translate: { dx: tx, dy: ty } },
            { rotate: { angle: `atan2(${rty} - ${rfy}, ${rtx} - ${rfx}) * 57.29578` } },
            { paint: { ops: [{ style: "fill" }] } },
            { drawPath: { path: "M0 0 L-10 -5 L-10 5 Z" } },
        ] } });
    }

    const rank = (l) => tb
        ? { row: { verticalAlignment: "center", modifiers: [{ spacedBy: 28 }], children: l.map(node) } }
        : { column: { horizontalAlignment: "center", modifiers: [{ spacedBy: 16 }], children: l.map(node) } };
    const ranks = { horizontalAlignment: "center", verticalAlignment: "center",
                    modifiers: ["fillMaxSize", { padding: [16, 16] }, { spacedBy: tb ? 48 : 64 }],
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

export function reflowDoc(graph, { width = 400, height = 500, direction } = {}) {
    const L = layered(graph);
    const dir = String(direction ?? graph.direction ?? "auto").toUpperCase();
    const doc = {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        root: [],
    };
    let children;
    if (dir === "TB" || dir === "LR") {
        children = [reflowVariant(L, dir, "v")];
    } else {
        // 0: top to bottom, 1: left to right: whichever overflows the space less, from both
        // layouts' sizes estimated from the labels (the engine's own measure is not known
        // when the state is picked). The space is measured by a canvas filling the graph's
        // box, not windowWidth(): androidx's player keeps that at the document's declared
        // size, while Kobento's players give the viewport.
        // Until the canvas is laid out its values hold the 1.0 placeholder; the first state
        // is picked from windowWidth() meanwhile (exact in Kobento's players, the declared
        // size on Android), so the usual case starts in the right state with no cross-fade.
        const { tb: [tbW, tbH], lr: [lrW, lrH] } = estimateSizes(L);
        const pick = (w, h) => `step(max(${tbW} / ${w}, ${tbH} / ${h}), max(${lrW} / ${w}, ${lrH} / ${h}))`;
        doc.resources = { variables: { orientWindow: pick("max(windowWidth(), 1)", "max(windowHeight(), 1)") } };
        children = [
            { canvas: { modifiers: ["fillMaxSize"], commands: [], componentValues: {
                availW: "width", availH: "height",
                orientMeasured: { expression: pick("max(@availW, 1)", "max(@availH, 1)") },
                orient: { expression: "ifElse(@orientWindow, @orientMeasured, @availW - 1.5)" },
            } } },
            { stateLayout: { indexId: "@orient", modifiers: ["fillMaxSize"],
                             children: [reflowVariant(L, "TB", "t"), reflowVariant(L, "LR", "l")] } },
        ];
    }
    doc.root.push({ box: { modifiers: ["fillMaxSize", { background: THEME.bg }], children } });
    return doc;
}

/** Rough [width, height] of the TB and LR reflow layouts, mirroring reflowVariant's spacing. */
function estimateSizes(L) {
    const w = (id) => (L.nodes.get(id).dummy ? 0 : measureLabel(L.nodes.get(id).label) + 28);
    const h = (id) => (L.nodes.get(id).dummy ? 0 : FONT * 1.2 + 16);
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    const R = L.layers.length;
    const tbW = 32 + Math.max(...L.layers.map((l) => sum(l.map(w)) + 28 * (l.length - 1)));
    const tbH = 32 + 48 * (R - 1) + sum(L.layers.map((l) => Math.max(0, ...l.map(h))));
    const lrW = 32 + 64 * (R - 1) + sum(L.layers.map((l) => Math.max(0, ...l.map(w))));
    const lrH = 32 + Math.max(...L.layers.map((l) => sum(l.map(h)) + 16 * (l.length - 1)));
    const r = (v) => Math.ceil(v * 1.05);
    return { tb: [r(tbW), r(tbH)], lr: [r(lrW), r(lrH)] };
}

// ───────────────────────────────── canvas ─────────────────────────────────

/**
 * A label's width at FONT, from per-character advances close to the usual sans faces
 * (Roboto, Helvetica). The player draws with its own font, so nodes keep generous padding
 * and labels are drawn centred: a small error shows as uneven margins, not overflow.
 */
export function measureLabel(s, size = FONT) {
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

const r1 = (v) => Math.round(v * 10) / 10;

export function canvasDoc(graph, { width = 400, height = 500, measure = measureLabel } = {}) {
    const L = layered(graph);
    const padX = 16, padY = 10;
    const size = (id) => ({ w: Math.ceil(measure(L.nodes.get(id).label) + 2 * padX), h: Math.ceil(FONT * 1.2 + 2 * padY) });
    const C = coordinates(L, size);
    const cy = (id) => C.rankTop[L.nodes.get(id).rank] + C.rankH[L.nodes.get(id).rank] / 2;
    const top = (id) => (L.nodes.get(id).dummy ? C.rankTop[L.nodes.get(id).rank] : cy(id) - C.dim.get(id).h / 2);
    const bottom = (id) => (L.nodes.get(id).dummy ? C.rankTop[L.nodes.get(id).rank] + C.rankH[L.nodes.get(id).rank]
                                                  : cy(id) + C.dim.get(id).h / 2);

    const edgeCmds = [], arrowCmds = [];
    for (const { edge, path, reversed, offset } of L.chains) {
        // Through each dummy as a vertical run across its rank band, cubic between ranks with
        // vertical tangents at both ends.
        const pts = [];
        path.forEach((id, k) => {
            const x = C.x.get(id) + offset;
            if (k > 0) pts.push([x, top(id)]);
            if (k + 1 < path.length) pts.push([x, bottom(id)]);
        });
        let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
        for (let i = 1; i < pts.length; i++) {
            const [px, py] = pts[i - 1], [qx, qy] = pts[i];
            if (i % 2 === 0) { d += ` L${r1(qx)} ${r1(qy)}`; continue; }   // inside a dummy's band
            const my = r1((py + qy) / 2);
            d += ` C${r1(px)} ${my} ${r1(qx)} ${my} ${r1(qx)} ${r1(qy)}`;
        }
        const color = edge.color ?? THEME.edge;
        edgeCmds.push({ paint: { ops: [{ color }, { style: "stroke" }, { width: 2 }] } }, { drawPath: { path: d } });
        // Arrowhead at the real target: tangents are vertical, so it points down, or up at the
        // upper end of a reversed (cycle) edge.
        const [ax, ay] = reversed ? pts[0] : pts[pts.length - 1];
        const s = reversed ? -1 : 1;
        arrowCmds.push({ paint: { ops: [{ color }, { style: "fill" }] } },
            { drawPath: { path: `M${r1(ax)} ${r1(ay)} L${r1(ax - 5)} ${r1(ay - 10 * s)} L${r1(ax + 5)} ${r1(ay - 10 * s)} Z` } });
    }

    const nodeCmds = [], labelCmds = [];
    for (const n of L.nodes.values()) {
        if (n.dummy) continue;
        const { w, h } = C.dim.get(n.id), x = C.x.get(n.id), y = cy(n.id);
        nodeCmds.push({ paint: { ops: [{ color: n.color ?? THEME.node }, { style: "fill" }] } },
            { drawRoundRect: { left: r1(x - w / 2), top: r1(y - h / 2), right: r1(x + w / 2), bottom: r1(y + h / 2), rx: 6, ry: 6 } });
        labelCmds.push({ drawTextAnchored: { text: n.label, x: r1(x), y: r1(y), panX: 0, panY: 0 } });
    }

    const GW = Math.max(1, Math.ceil(C.width)), GH = Math.max(1, Math.ceil(C.height));
    // Fitted scale (never past 1.5x), times the user's zoom steps, animated.
    const scale = `min(min((width - 32) / ${GW}, (height - 32) / ${GH}), 1.5) * @zoom`;
    const zoomButton = (step, label, glyph) => ({ canvas: {
        modifiers: [{ size: [44, 44] },
                    { semantics: { contentDescription: label, clickable: true } },
                    { onClick: { type: "valueFloatExpressionChange", target: "@zoomSteps",
                                 value: `clamp(-8, 8, @zoomSteps + ${step})` } }],
        commands: [
            { paint: { ops: [{ color: THEME.button }, { style: "fill" }] } },
            { drawRoundRect: { left: 0, top: 0, right: 44, bottom: 44, rx: 10, ry: 10 } },
            { paint: { ops: [{ color: THEME.buttonFg }, { style: "stroke" }, { width: 2.5 }, { strokeCap: "round" }] } },
            ...glyph,
        ],
    } });
    const minus = { drawLine: { x1: 14, y1: 22, x2: 30, y2: 22 } };
    const plus = { drawLine: { x1: 22, y1: 14, x2: 22, y2: 30 } };

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
                            // Labels only while they are legible (about 6px and up).
                            { conditionalOperations: { condition: "ge", v1: `${scale} * ${FONT}`, v2: 6, commands: [
                                { paint: { ops: [{ color: THEME.text }, { style: "fill" }, { textSize: FONT }] } },
                                ...labelCmds,
                            ] } },
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
