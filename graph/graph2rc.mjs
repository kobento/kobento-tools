// graph2rc — a JSON graph description -> RemoteCompose JSON (for json2rc).
//
//   node graph/graph2rc.mjs graph.json out.json [--mode reflow|canvas]
//        [--direction TB|LR|auto] [--width N] [--height N]
//
// Input:
//   { "nodes": [{"id": "a", "label": "Start", "color": "#FF1E293B", "look": "pill", "group": "g"}],
//     "edges": [{"from": "a", "to": "b", "color": "#FF64748B"}, ...],     (an end may be a group)
//     "groups": [{"id": "g", "label": "Front end", "nodes": [...], "groups": [...]}],
//     "direction": "TB" | "LR" | "auto",                         (reflow only; default auto)
//     "style": {"look": "card", "groupLook": "group"}, "looks": {...} }    (see looks.mjs)
//
// Both modes share layered.mjs (cycles broken by reversing back edges, longest-path ranks, one
// dummy per rank a long edge crosses, barycenter crossing reduction) and compound.mjs: each
// group is laid out as its own layered graph and is one node of its parent's; an edge is laid
// out at the deepest group holding both its ends and drawn to the real nodes.
//
// reflow — the converter fixes the structure, RemoteCompose does the geometry. Ranks are
//   Rows in a Column (TB) or Columns in a Row (LR); each node is its look's `layout`, and each
//   group its look's layout with the group's own ranks in its {{content}} slot, all laid out by
//   the engine, so the graph reflows on the device. Every node and group is flanked by two 0x0
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
import { compound, ROOT } from "./compound.mjs";
import { geometry, SPACING } from "./geometry.mjs";
import { route, allChains, arrowPath } from "./routes.mjs";
import { THEME, fill, lookFor, lookForGroup, lookSize, groupSize } from "./looks.mjs";

const EDGE_WIDTH = 1.75;

/**
 * The flow and cross shapes of a curve, t in [0, 1]: across the flow it eases (t²(3 - 2t),
 * the control points' cross coordinate equals the end's), along it it is the cubic with both
 * control points at the midpoint: 1.5 t (1 - t) + t³.
 */
const EASE = "a[0] * a[0] * (3 - 2 * a[0])";
const ALONG = "(1.5 * a[0] * (1 - a[0]) + a[0] * a[0] * a[0])";

const edgePaint = (color) => ({ paint: { ops: [{ color }, { style: "stroke" }, { width: EDGE_WIDTH }, { strokeCap: "round" }] } });

// ───────────────────────────────── reflow ─────────────────────────────────

function reflowVariant(graph, T, G, dir, prefix) {
    const tb = dir === "TB";
    const [F, X] = tb ? ["y", "x"] : ["x", "y"];          // flow axis, cross axis
    // Variable names from an index, not the id: ids are user strings.
    const index = new Map([...T.items.keys()].map((id, i) => [id, i]));
    const levelIndex = new Map([...T.levels.keys()].map((g, i) => [g, i]));
    const nv = (name, axis) => `@${prefix}${name}${axis}`;

    // Routes first: they say which items need side anchors and which ranks need band anchors.
    const sides = new Set(), bands = new Set();
    const routes = [];
    for (const chain of allChains(T)) {
        const off = chain.offset;
        const add = (v, k) => (k ? `${v} ${k < 0 ? "-" : "+"} ${Math.abs(k)}` : v);
        const P = {
            add,
            crossOf: (id) => G.geo.get(id).cx,
            port: (id, p) => {
                if (T.items.get(id).kind === "dummy") p = "a";
                if (p === "l" || p === "r") sides.add(id);
                const name = `${index.get(id)}${p}`;
                // Parallel edges are spread across the flow on the flow ports, along it on the sides.
                return p === "l" || p === "r" ? { f: add(nv(name, F), off), c: nv(name, X) }
                                              : { f: nv(name, F), c: add(nv(name, X), off) };
            },
            band: (id) => {
                const it = T.items.get(id), r = T.levels.get(it.level).nodes.get(id).rank;
                const k = `k${levelIndex.get(it.level)}_${r}`;
                bands.add(k);
                return { f0: nv(`${k}a`, F), f1: nv(`${k}b`, F), c: add(nv(`${index.get(id)}a`, X), off) };
            },
        };
        routes.push({ chain, ...route(T, chain, P) });
    }

    const anchor = (name) => ({ canvas: {
        componentValues: { [`${prefix}${name}x`]: "rootX", [`${prefix}${name}y`]: "rootY" },
        modifiers: [{ size: [0, 0] }], commands: [],
    } });
    // Along the flow: anchors a (in) and b (out); across it, when an edge leaves or enters by
    // the side: anchors l and r, at the middle.
    const wrap = (id, body) => {
        const i = index.get(id);
        const kids = [anchor(`${i}a`), body, anchor(`${i}b`)];
        const flow = tb ? { column: { horizontalAlignment: "center", children: kids } }
                        : { row: { verticalAlignment: "center", children: kids } };
        if (!sides.has(id)) return flow;
        const across = [anchor(`${i}l`), flow, anchor(`${i}r`)];
        return tb ? { row: { verticalAlignment: "center", children: across } }
                  : { column: { horizontalAlignment: "center", children: across } };
    };
    const sp = SPACING[dir];
    // A group's (or the whole graph's) ranks; only the top level fills the space. A rank a
    // dummy passes through gets anchors at its start and end: the dummy's run across the band.
    const ranksOf = (gid) => {
        const L = T.levels.get(gid), top = gid === ROOT, li = levelIndex.get(gid);
        const rank = (l, r) => {
            const body = tb
                ? { row: { verticalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: l.map(item) } }
                : { column: { horizontalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: l.map(item) } };
            const k = `k${li}_${r}`;
            if (!bands.has(k)) return body;
            const kids = [anchor(`${k}a`), body, anchor(`${k}b`)];
            return tb ? { column: { horizontalAlignment: "center", children: kids } }
                      : { row: { verticalAlignment: "center", children: kids } };
        };
        const body = { horizontalAlignment: "center", verticalAlignment: "center",
                       modifiers: [...(top ? ["fillMaxSize", { padding: [16, 16] }] : []), { spacedBy: sp.rank }],
                       children: L.layers.map(rank) };
        return tb ? { column: body } : { row: body };
    };
    function item(id) {
        const it = T.items.get(id);
        if (it.kind === "dummy") return anchor(`${index.get(id)}a`);
        if (it.kind === "node") {
            const { name, look, vars } = lookFor(graph, T.levels.get(it.level).nodes.get(id));
            if (!look.layout) throw new Error(`look "${name}" has no layout (needed by reflow mode)`);
            return wrap(id, fill(look.layout, vars, `node ${id}, look "${name}"`));
        }
        const { name, look, vars } = lookForGroup(graph, T.groups.get(id));
        if (!look.layout) throw new Error(`look "${name}" has no layout (needed by reflow mode)`);
        return wrap(id, fill(look.layout, { ...vars, content: ranksOf(id) }, `group ${id}, look "${name}"`));
    }
    const graphLayout = ranksOf(ROOT);

    // The edges, in the overlay's coordinates: translated once by its own root position.
    const xy = (p) => (tb ? [p.c, p.f] : [p.f, p.c]);
    const commands = [];
    for (const { chain, pts, segs, arrow } of routes) {
        commands.push(edgePaint(chain.edge.color ?? THEME.edge));
        segs.forEach((kind, k) => {
            const p = pts[k], q = pts[k + 1];
            if (kind === "line") {
                const [x1, y1] = xy(p), [x2, y2] = xy(q);
                commands.push({ drawLine: { x1, y1, x2, y2 } });
                return;
            }
            const cross = `${p.c} + ((${q.c}) - (${p.c})) * ${EASE}`;
            const along = `${p.f} + ((${q.f}) - (${p.f})) * ${ALONG}`;
            const id = `${prefix}e${chain.key}s${k}`;
            commands.push(
                { pathExpression: { id, expressionX: tb ? cross : along, expressionY: tb ? along : cross,
                                    start: 0, end: 1, count: 24 } },
                { drawPath: { path: id } });
        });
        const [tx, ty] = xy(arrow);
        commands.push({ save: { commands: [
            { translate: { dx: tx, dy: ty } },
            { paint: { ops: [{ style: "fill" }] } },
            { drawPath: { path: arrowPath(arrow.dir, tb) } },
        ] } });
    }

    return { box: {
        modifiers: ["fillMaxSize"],
        children: [
            graphLayout,
            { canvas: { componentValues: { [`${prefix}gx`]: "rootX", [`${prefix}gy`]: "rootY" },
                        modifiers: ["fillMaxSize"],
                        commands: [{ save: { commands: [
                            { translate: { dx: `0 - @${prefix}gx`, dy: `0 - @${prefix}gy` } }, ...commands] } }] } },
        ],
    } };
}

export function reflowDoc(graph, { width = 400, height = 500, direction, measure = measureLabel } = {}) {
    const T = compound(graph);
    const G = geometry(graph, T, measure);
    const dir = String(direction ?? graph.direction ?? "auto").toUpperCase();
    const doc = {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        root: [],
    };
    let children;
    if (dir === "TB" || dir === "LR") {
        children = [reflowVariant(graph, T, G, dir, "v")];
    } else {
        // 0: top to bottom, 1: left to right: whichever overflows the space less, from both
        // layouts' sizes estimated from the looks (the engine's own measure is not known when
        // the state is picked). The space is measured by a canvas filling the graph's box, not
        // windowWidth(): androidx's player keeps that at the document's declared size, while
        // Kobento's players give the viewport. Until that canvas is laid out its values hold
        // the 1.0 placeholder and the windowWidth() guess stands, so the usual case starts in
        // the right state with no cross-fade.
        const [tbW, tbH] = estimateSize(graph, T, "TB", measure), [lrW, lrH] = estimateSize(graph, T, "LR", measure);
        const pick = (w, h) => `step(max(${tbW} / ${w}, ${tbH} / ${h}), max(${lrW} / ${w}, ${lrH} / ${h}))`;
        doc.resources = { variables: { orientWindow: pick("max(windowWidth(), 1)", "max(windowHeight(), 1)") } };
        children = [
            { canvas: { modifiers: ["fillMaxSize"], commands: [], componentValues: {
                availW: "width", availH: "height",
                orientMeasured: { expression: pick("max(@availW, 1)", "max(@availH, 1)") },
                orient: { expression: "ifElse(@orientWindow, @orientMeasured, @availW - 1.5)" },
            } } },
            { stateLayout: { indexId: "@orient", modifiers: ["fillMaxSize"],
                             children: [reflowVariant(graph, T, G, "TB", "t"), reflowVariant(graph, T, G, "LR", "l")] } },
        ];
    }
    doc.root.push({ box: { modifiers: ["fillMaxSize", { background: THEME.bg }], children } });
    return doc;
}

/** Rough [width, height] of the reflow layout in `dir`, mirroring reflowVariant's spacing. */
function estimateSize(graph, T, dir, measure) {
    const sp = SPACING[dir], tb = dir === "TB";
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const level = (gid) => {
        const L = T.levels.get(gid);
        if (!L.layers.length) return { w: 0, h: 0 };
        const dim = (id) => {
            const it = T.items.get(id);
            if (it.kind === "dummy") return { w: 0, h: 0 };
            if (it.kind === "node") return lookSize(lookFor(graph, L.nodes.get(id)).look, L.nodes.get(id).label, measure);
            const grp = T.groups.get(id);
            return groupSize(lookForGroup(graph, grp).look, grp.label, level(id), measure);
        };
        const ranks = L.layers.map((l) => {
            const ds = l.map(dim);
            const across = sum(ds.map((d) => (tb ? d.w : d.h))) + sp.node * (l.length - 1);
            const along = Math.max(0, ...ds.map((d) => (tb ? d.h : d.w)));
            return { across, along };
        });
        const across = Math.max(...ranks.map((r) => r.across));
        const along = sum(ranks.map((r) => r.along)) + sp.rank * (L.layers.length - 1);
        return tb ? { w: across, h: along } : { w: along, h: across };
    };
    const { w, h } = level(ROOT);
    return [Math.ceil((w + 32) * 1.05), Math.ceil((h + 32) * 1.05)];
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
    const T = compound(graph);
    const { geo, groupOrder, looks, total } = geometry(graph, T, measure);

    const edgeCmds = [], arrowCmds = [];
    for (const chain of allChains(T)) {
        const off = chain.offset;
        const P = {
            add: (v, k) => v + k,
            crossOf: (id) => geo.get(id).cx,
            port: (id, p) => {
                const g = geo.get(id);
                return { a: { f: g.top, c: g.cx + off }, b: { f: g.bottom, c: g.cx + off },
                         l: { f: g.cy + off, c: g.left }, r: { f: g.cy + off, c: g.right } }[p];
            },
            band: (id) => { const g = geo.get(id); return { f0: g.top, f1: g.bottom, c: g.cx + off }; },
        };
        const { pts, segs, arrow } = route(T, chain, P);
        // TB: flow is y, cross is x.
        let d = `M${r1(pts[0].c)} ${r1(pts[0].f)}`;
        segs.forEach((kind, k) => {
            const p = pts[k], q = pts[k + 1];
            if (kind === "line") { d += ` L${r1(q.c)} ${r1(q.f)}`; return; }
            const mf = r1((p.f + q.f) / 2);
            d += ` C${r1(p.c)} ${mf} ${r1(q.c)} ${mf} ${r1(q.c)} ${r1(q.f)}`;
        });
        const color = chain.edge.color ?? THEME.edge;
        edgeCmds.push(edgePaint(color), { drawPath: { path: d } });
        arrowCmds.push({ paint: { ops: [{ color }, { style: "fill" }] } },
                       { save: { commands: [{ translate: { dx: r1(arrow.c), dy: r1(arrow.f) } },
                                            { drawPath: { path: arrowPath(arrow.dir, true) } }] } });
    }

    const drawn = (id) => {
        const { name, look, vars } = looks.get(id), b = geo.get(id);
        if (!look.canvas) throw new Error(`look "${name}" has no canvas drawing (needed by canvas mode)`);
        const all = { ...vars, left: r1(b.left), top: r1(b.top), right: r1(b.right), bottom: r1(b.bottom),
                      cx: r1(b.cx), cy: r1(b.cy), w: b.w, h: b.h, radius: r1(b.h / 2) };
        const where = `${T.items.get(id).kind} ${id}, look "${name}"`;
        return { body: fill(look.canvas.commands ?? [], all, where), label: fill(look.canvas.label ?? [], all, where) };
    };
    const groupCmds = [], nodeCmds = [], labelCmds = [];
    for (const id of groupOrder) { const { body, label } = drawn(id); groupCmds.push(...body); labelCmds.push(...label); }
    for (const [id, it] of T.items) {
        if (it.kind !== "node") continue;
        const { body, label } = drawn(id);
        nodeCmds.push(...body); labelCmds.push(...label);
    }

    const GW = Math.max(1, Math.ceil(total.w)), GH = Math.max(1, Math.ceil(total.h));
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
                            ...groupCmds, ...edgeCmds, ...arrowCmds, ...nodeCmds,
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
    const n = (graph.nodes ?? []).length, e = (graph.edges ?? []).length, g = countGroups(graph.groups ?? []);
    const s = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
    return `A graph of ${s(n, "node")}${g ? `, ${s(g, "group")}` : ""} and ${s(e, "edge")}`;
}
const countGroups = (gs) => gs.reduce((c, g) => c + 1 + countGroups(g.groups ?? []), 0);

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
