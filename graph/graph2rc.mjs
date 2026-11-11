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
import { layout, axes } from "./geometry.mjs";
import { route, endVector } from "./routes.mjs";
import { edgeStyle, markerLength, strokePaint, markerCommands } from "./edges.mjs";
import { THEME, fill, lookFor, lookForGroup, lookForLabel } from "./looks.mjs";

/**
 * The flow and cross shapes of a curve, t in [0, 1]: across the flow it eases (t²(3 - 2t),
 * the control points' cross coordinate equals the end's), along it it is the cubic with both
 * control points at the midpoint: 1.5 t (1 - t) + t³.
 */
const EASE = "a[0] * a[0] * (3 - 2 * a[0])";
const ALONG = "(1.5 * a[0] * (1 - a[0]) + a[0] * a[0] * a[0])";

/** A chain's style, and its markers' lengths in path order (a reversed chain starts at "to"). */
function chainStyle(graph, chain) {
    const st = edgeStyle(graph, chain.edge);
    const [first, last] = chain.reversed ? [st.head, st.tail] : [st.tail, st.head];
    return { st, markers: [first, last], lens: [markerLength(first), markerLength(last)] };
}

// ───────────────────────────────── reflow ─────────────────────────────────

function reflowVariant(graph, T, { G, chains, room }, dir, prefix) {
    const { tb, fs, spacing: sp } = axes(dir);
    const [F, X] = tb ? ["y", "x"] : ["x", "y"];          // flow axis, cross axis
    // Variable names from an index, not the id: ids are user strings.
    const index = new Map([...T.items.keys()].map((id, i) => [id, i]));
    const levelIndex = new Map([...T.levels.keys()].map((g, i) => [g, i]));
    const nv = (name, axis) => `@${prefix}${name}${axis}`;

    // Long edges get a lane. The engine places dummies by packing each rank's row, so a long
    // edge through their slots snakes from rank to rank. The one corridor free in every rank is
    // beside the rows: an edge through two or more ranks runs its whole middle there, straight,
    // beyond the farthest row end it passes -- computed live from anchors at the rows' ends.
    // Its dummies then take no room in the rows. A label goes on the lane, drawn by the overlay
    // at its rank's middle (the look's canvas drawing), and the lane stands far enough out for
    // it. The side is the one the dummies lean to in the fixed layout; per side, shorter spans
    // run nearer the rows and overlapping ones get lanes of their own, each as wide as its
    // widest label.
    const laneOf = new Map(), laneDummies = new Set(), rowEnds = new Set(), laneVars = {};
    const laneLabels = [];   // {chain, id, lane: "@var", bandKey}
    {
        const cand = [];
        for (const chain of chains) {
            const mid = chain.path.slice(1, -1);
            if (mid.length < 2) continue;
            const labels = mid.filter((id) => T.items.get(id).kind === "label");
            const level = T.items.get(mid[0]).level, L = T.levels.get(level);
            const cs = [...L.nodes.keys()].map((id) => G.crossOf(id));
            const middle = (Math.min(...cs) + Math.max(...cs)) / 2;
            const mean = mid.reduce((t, id) => t + G.crossOf(id), 0) / mid.length;
            const ranks = mid.map((id) => L.nodes.get(id).rank);
            const width = Math.max(0, ...labels.map((id) => { const g = G.geo.get(id); return tb ? g.w : g.h; }));
            cand.push({ chain, mid, labels, level, side: mean >= middle ? 1 : -1, width,
                        lo: Math.min(...ranks), hi: Math.max(...ranks) });
        }
        cand.sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo));
        // Lanes first, then how far out each stands: past the ones nearer the rows.
        const taken = new Map(), laneWidth = new Map();
        for (const c of cand) {
            const key = `${c.level}|${c.side}`, t = taken.get(key) ?? taken.set(key, []).get(key);
            let lane = 0;
            while (t.some((u) => u.lane === lane && u.lo <= c.hi && c.lo <= u.hi)) lane++;
            t.push({ lo: c.lo, hi: c.hi, lane });
            c.lane = lane;
            const wk = `${key}|${lane}`;
            laneWidth.set(wk, Math.max(laneWidth.get(wk) ?? 0, c.width));
        }
        const GAP = 16;
        const outAt = (c) => {
            let d = GAP;
            for (let j = 0; j < c.lane; j++) d += (laneWidth.get(`${c.level}|${c.side}|${j}`) ?? 0) + GAP;
            return d + (laneWidth.get(`${c.level}|${c.side}|${c.lane}`) ?? 0) / 2;
        };
        for (const c of cand) {
            const li = levelIndex.get(c.level), ends = [];
            for (let r = c.lo; r <= c.hi; r++) {
                rowEnds.add(`k${li}_${r}`);
                ends.push(nv(`k${li}_${r}${c.side > 0 ? "r" : "l"}`, X));
            }
            c.mid.forEach((id) => laneDummies.add(id));
            // max (or min) over the rows' ends, folded in chunks so no expression grows past
            // what Android reads.
            const name = `${prefix}lane${laneOf.size}`, fn = c.side > 0 ? "max" : "min";
            let terms = ends, j = 0;
            while (terms.length > 12) {
                const next = [];
                for (let i = 0; i < terms.length; i += 12) {
                    const part = `${name}p${j++}`;
                    laneVars[part] = { expression: terms.slice(i, i + 12).reduce((acc, v) => `${fn}(${acc}, ${v})`) };
                    next.push(`@${part}`);
                }
                terms = next;
            }
            laneVars[name] = { expression: `${terms.reduce((acc, v) => `${fn}(${acc}, ${v})`)} ${c.side > 0 ? "+" : "-"} ${Math.round(outAt(c))}` };
            laneOf.set(c.chain.key, `@${name}`);
            for (const id of c.labels) {
                const r = T.levels.get(c.level).nodes.get(id).rank;
                laneLabels.push({ chain: c.chain, id, lane: `@${name}`, band: `k${li}_${r}` });
            }
        }
    }

    // Routes first: they say which items need side anchors and which ranks need band anchors.
    const sides = new Set(), bands = new Set();
    const routes = [];
    for (const chain of chains) {
        // Each edge's attachment points come from the spacing plan; parallel edges also keep
        // apart through their dummies (chain.offset).
        const add = (v, k) => (k ? `${v} ${k < 0 ? "-" : "+"} ${Math.abs(k)}` : v);
        const P = {
            add, fs,
            crossOf: (id) => G.crossOf(id),
            lane: (c) => laneOf.get(c.key) ?? null,
            port: (id, p) => {
                if (T.items.get(id).kind === "dummy") p = "a";
                if (p === "l" || p === "r") sides.add(id);
                const name = `${index.get(id)}${p}`;
                return { f: nv(name, F), c: nv(name, X) };
            },
            band: (id) => {
                const it = T.items.get(id), r = T.levels.get(it.level).nodes.get(id).rank;
                const k = `k${levelIndex.get(it.level)}_${r}`;
                bands.add(k);
                return { f0: nv(`${k}a`, F), f1: nv(`${k}b`, F), c: add(nv(`${index.get(id)}a`, X), chain.offset) };
            },
        };
        const cs = chainStyle(graph, chain);
        routes.push({ chain, ...cs, ...route(T, chain, P, cs.lens, room.get(chain.key)) });
    }

    for (const l of laneLabels) bands.add(l.band);

    const anchor = (name) => ({ canvas: {
        componentValues: { [`${prefix}${name}x`]: "rootX", [`${prefix}${name}y`]: "rootY" },
        modifiers: [{ size: [0, 0] }], commands: [],
    } });
    // Children in flow order: reversed on screen for BT and RL.
    const flowOrder = (kids) => (fs > 0 ? kids : [...kids].reverse());
    // Along the flow: anchors a (in) and b (out); across it, when an edge leaves or enters by
    // the side: anchors l and r, at the middle.
    const wrap = (id, body) => {
        const i = index.get(id);
        const kids = flowOrder([anchor(`${i}a`), body, anchor(`${i}b`)]);
        const flow = tb ? { column: { horizontalAlignment: "center", children: kids } }
                        : { row: { verticalAlignment: "center", children: kids } };
        if (!sides.has(id)) return flow;
        const across = [anchor(`${i}l`), flow, anchor(`${i}r`)];
        // Room for a group's side exits to run in: the row (and its end anchors, which the
        // lanes go by) leaves it clear.
        const r = room.exitRoom.get(id), mods = [];
        // [start, top, end, bottom]: json2rc's object form takes start / end, not left / right.
        if (r) mods.push({ padding: tb ? [r.l, 0, r.r, 0] : [0, r.l, 0, r.r] });
        return tb ? { row: { verticalAlignment: "center", modifiers: mods, children: across } }
                  : { column: { horizontalAlignment: "center", modifiers: mods, children: across } };
    };
    // A group's (or the whole graph's) ranks; only the top level fills the space. A rank a
    // dummy passes through gets anchors at its start and end: the dummy's run across the band.
    const ranksOf = (gid) => {
        const L = T.levels.get(gid), top = gid === ROOT, li = levelIndex.get(gid);
        const rank = (l, r) => {
            const members = l.filter((id) => !laneDummies.has(id)).map(item);
            let body = tb
                ? { row: { verticalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: members } }
                : { column: { horizontalAlignment: "center", modifiers: [{ spacedBy: sp.node }], children: members } };
            const k = `k${li}_${r}`;
            if (rowEnds.has(k)) {
                // The row's two ends across the flow, for the lanes beside it.
                const across = [anchor(`${k}l`), body, anchor(`${k}r`)];
                body = tb ? { row: { verticalAlignment: "center", children: across } }
                          : { column: { horizontalAlignment: "center", children: across } };
            }
            if (!bands.has(k)) return body;
            const kids = flowOrder([anchor(`${k}a`), body, anchor(`${k}b`)]);
            return tb ? { column: { horizontalAlignment: "center", children: kids } }
                      : { row: { verticalAlignment: "center", children: kids } };
        };
        const body = { horizontalAlignment: "center", verticalAlignment: "center",
                       modifiers: [...(top ? ["fillMaxSize", { padding: [16, 16] }] : []), { spacedBy: sp.rank }],
                       children: flowOrder(L.layers.map(rank)) };
        return tb ? { column: body } : { row: body };
    };
    function item(id) {
        const it = T.items.get(id);
        if (it.kind === "dummy") return anchor(`${index.get(id)}a`);
        const node = T.levels.get(it.level).nodes.get(id);
        const [{ name, look, vars }, what] = it.kind === "node" ? [lookFor(graph, node), "node"]
            : it.kind === "label" ? [lookForLabel(graph, node), "edge label"]
            : [lookForGroup(graph, T.groups.get(id)), "group"];
        if (!look.layout) throw new Error(`look "${name}" has no layout (needed by reflow mode)`);
        const v = it.kind === "group" ? { ...vars, content: ranksOf(id) } : vars;
        return wrap(id, fill(look.layout, v, `${what} ${id}, look "${name}"`));
    }
    const graphLayout = ranksOf(ROOT);

    // The edges, in the overlay's coordinates: translated once by its own root position.
    const xy = (p) => (tb ? [p.c, p.f] : [p.f, p.c]);
    const commands = [];
    for (const { chain, st, markers, pts, segs, ends } of routes) {
        commands.push(strokePaint(st));
        segs.forEach((kind, k) => {
            const p = pts[k], q = pts[k + 1];
            if (kind === "skip") return;
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
        ends.forEach((e, i) => {
            const cmds = markerCommands(markers[i], st, endVector(e, tb, fs));
            if (!cmds.length) return;
            const [tx, ty] = xy(e);
            commands.push({ save: { commands: [{ translate: { dx: tx, dy: ty } }, ...cmds] } });
        });
    }

    // Labels on lanes: the look's canvas drawing, centred on the lane at the middle of the
    // label's rank band, over the line. Its size is the layout's estimate; the text is centred.
    for (const { id, lane, band } of laneLabels) {
        const node = T.levels.get(T.items.get(id).level).nodes.get(id);
        const { name, look, vars } = lookForLabel(graph, node);
        if (!look.canvas) throw new Error(`look "${name}" has no canvas drawing (needed for a label on a lane)`);
        const g = G.geo.get(id), mid = `(${nv(`${band}a`, F)} + ${nv(`${band}b`, F)}) * 0.5`;
        const [cx, cy] = tb ? [lane, mid] : [mid, lane];
        const box = { left: `${cx} - ${g.w / 2}`, right: `${cx} + ${g.w / 2}`,
                      top: `${cy} - ${g.h / 2}`, bottom: `${cy} + ${g.h / 2}`,
                      cx, cy, w: g.w, h: g.h, radius: g.h / 2 };
        const all = { ...vars, ...box }, where = `edge label ${id}, look "${name}"`;
        commands.push({ paint: { ops: [{ pathEffect: null }] } },
                      ...fill(look.canvas.commands ?? [], all, where), ...fill(look.canvas.label ?? [], all, where));
    }

    return { box: {
        modifiers: ["fillMaxSize"],
        children: [
            graphLayout,
            { canvas: { componentValues: { [`${prefix}gx`]: "rootX", [`${prefix}gy`]: "rootY", ...laneVars },
                        modifiers: ["fillMaxSize"],
                        commands: [{ save: { commands: [
                            { translate: { dx: `0 - @${prefix}gx`, dy: `0 - @${prefix}gy` } }, ...commands] } }] } },
        ],
    } };
}

export function reflowDoc(graph, { width = 400, height = 500, direction, measure = measureLabel } = {}) {
    const T = compound(graph);
    const dir = String(direction ?? graph.direction ?? "auto").toUpperCase();
    const doc = {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        root: [],
    };
    let children;
    if (dir !== "AUTO") {
        children = [reflowVariant(graph, T, layout(graph, T, measure, dir), dir, "v")];
    } else {
        // 0: top to bottom, 1: left to right: whichever overflows the space less, from both
        // layouts' sizes estimated from the looks (canvas mode's geometry; the engine's own
        // measure is not known when the state is picked). The space is measured by a canvas
        // filling the graph's box, not windowWidth(): androidx's player keeps that at the
        // document's declared size, while Kobento's players give the viewport. Until that
        // canvas is laid out its values hold the 1.0 placeholder and the windowWidth() guess
        // stands, so the usual case starts in the right state with no cross-fade.
        const gTB = layout(graph, T, measure, "TB"), gLR = layout(graph, T, measure, "LR");
        const est = ({ G: { total } }) => [Math.ceil((total.w + 32) * 1.05), Math.ceil((total.h + 32) * 1.05)];
        const [tbW, tbH] = est(gTB), [lrW, lrH] = est(gLR);
        const pick = (w, h) => `step(max(${tbW} / ${w}, ${tbH} / ${h}), max(${lrW} / ${w}, ${lrH} / ${h}))`;
        doc.resources = { variables: { orientWindow: pick("max(windowWidth(), 1)", "max(windowHeight(), 1)") } };
        children = [
            { canvas: { modifiers: ["fillMaxSize"], commands: [], componentValues: {
                availW: "width", availH: "height",
                orientMeasured: { expression: pick("max(@availW, 1)", "max(@availH, 1)") },
                orient: { expression: "ifElse(@orientWindow, @orientMeasured, @availW - 1.5)" },
            } } },
            { stateLayout: { indexId: "@orient", modifiers: ["fillMaxSize"],
                             children: [reflowVariant(graph, T, gTB, "TB", "t"), reflowVariant(graph, T, gLR, "LR", "l")] } },
        ];
    }
    doc.root.push({ box: { modifiers: ["fillMaxSize", { background: THEME.bg }], children } });
    return doc;
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

export function canvasDoc(graph, { width = 400, height = 500, direction, measure = measureLabel } = {}) {
    const T = compound(graph);
    let dir = String(direction ?? graph.direction ?? "TB").toUpperCase();
    if (dir === "AUTO") dir = "TB";
    const { G, chains, room } = layout(graph, T, measure, dir);
    const { geo, groupOrder, looks, total, tb, fs } = G;
    const xy = (p) => (tb ? [p.c, p.f] : [p.f, p.c]);

    const edgeCmds = [], arrowCmds = [];
    for (const chain of chains) {
        const off = chain.offset;
        const P = {
            add: (v, k) => v + k, fs,
            crossOf: (id) => G.crossOf(id),
            // Attachment points come from the spacing plan; parallel edges also keep apart
            // through their dummies.
            port: (id, p) => G.port(id, p),
            band: (id) => { const g = G.band(id); return { f0: g.f0, f1: g.f1, c: g.c + off }; },
        };
        const { st, markers, lens } = chainStyle(graph, chain);
        const { pts, segs, ends } = route(T, chain, P, lens, room.get(chain.key));
        const at = (p) => xy(p).map(r1).join(" ");
        let d = `M${at(pts[0])}`;
        segs.forEach((kind, k) => {
            const p = pts[k], q = pts[k + 1];
            if (kind === "skip") { d += ` M${at(q)}`; return; }
            if (kind === "line") { d += ` L${at(q)}`; return; }
            const mf = (p.f + q.f) / 2;
            d += ` C${at({ f: mf, c: p.c })} ${at({ f: mf, c: q.c })} ${at(q)}`;
        });
        edgeCmds.push(strokePaint(st), { drawPath: { path: d } });
        ends.forEach((e, i) => {
            const cmds = markerCommands(markers[i], st, endVector(e, tb, fs));
            if (!cmds.length) return;
            const [tx, ty] = xy(e);
            arrowCmds.push({ save: { commands: [{ translate: { dx: r1(tx), dy: r1(ty) } }, ...cmds] } });
        });
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
        if (it.kind !== "node" && it.kind !== "label") continue;
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
                            ...groupCmds, ...edgeCmds, ...arrowCmds,
                            // The edges' dash must not reach the nodes' strokes.
                            { paint: { ops: [{ pathEffect: null }] } },
                            ...nodeCmds,
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
