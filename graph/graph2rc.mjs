// graph2rc — a JSON graph description -> RemoteCompose JSON (for json2rc).
//
//   node graph/graph2rc.mjs graph.json out.json [--mode reflow|canvas]
//        [--direction TB|BT|LR|RL|auto] [--overflow pan|clip] [--width N] [--height N]
//
// Input (README.md has it all):
//   { "nodes": [{"id": "a", "label": "Start", "color": "#FF1E293B", "look": "pill", "group": "g",
//                "action": "open"},                                         (taps)
//               {"id": "t", "fields": ["id", "name"]}],                    (a record, records.mjs)
//     "edges": [{"from": "a", "to": "t:id", "label": "yes", "style": "dashed"},  (an end may be a
//               {"from": "a", "to": "a"}, ...],              group, or a record's field; a loop)
//     "groups": [{"id": "g", "label": "Front end", "nodes": [...], "groups": [...]}],
//     "direction": "TB" | "BT" | "LR" | "RL" | "auto",            (auto: reflow only, the default)
//     "overflow": "pan" | "clip",                                 (reflow only; default pan)
//     "style": {"look": "card", "groupLook": "group", "action": ...}, "looks": {...} }  (looks.mjs)
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
//   orientations in a StateLayout and shows the one that overflows the space less; a graph that
//   fits in neither shows as the canvas picture instead (overflow "pan").
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
import { loopRoute, loopLabels } from "./loops.mjs";
import { isRecord, cellsOf, recordLayout, recordCanvas } from "./records.mjs";
import { edgeStyle, markerLength, strokePaint, markerCommands } from "./edges.mjs";
import { themeOf, fill, lookFor, lookForGroup, lookForLabel } from "./looks.mjs";

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

/**
 * What tapping a node, group or edge (its label) does: its "onClick" (RemoteCompose actions, as
 * json2rc reads them), or its "action" -- a host named action with its id as the value -- or the
 * graph's style.action (nodes) / style.edgeAction (edges). Null when nothing.
 */
function actionsFor(graph, kind, src, id) {
    if (src.onClick !== undefined) return src.onClick;
    const name = src.action ?? (kind === "node" ? graph.style?.action : kind === "edge" ? graph.style?.edgeAction : undefined);
    return name === undefined || name === null ? null : [{ type: "hostNamedAction", name: String(name), value: String(id) }];
}

/** An edge's id for its actions: its own "id", or "from->to". */
const edgeId = (e) => String(e.id ?? `${e.realFrom ?? e.from}->${e.realTo ?? e.to}`);

// ───────────────────────────────── reflow ─────────────────────────────────

function reflowVariant(graph, T, { G, chains, room, loops }, dir, prefix) {
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
        // Lanes first, then how far out each stands: past the ones nearer the rows. An edge
        // whose side is taken where it runs goes to the other side if a nearer lane is free
        // there, rather than standing further out (and off the screen) beside the first --
        // unless that side has more nodes between the edge's ends and it in their ranks (each
        // one a crossing).
        const between = (c, side) => {
            const L = T.levels.get(c.level), { path } = c.chain;
            let n = 0;
            for (const end of [path[0], path[path.length - 1]]) {
                const at = G.crossOf(end);
                for (const id of L.layers[L.nodes.get(end).rank]) {
                    if (id !== end && T.items.get(id).kind !== "dummy" && (G.crossOf(id) - at) * side > 0) n++;
                }
            }
            return n;
        };
        const taken = new Map(), laneWidth = new Map();
        const laneOn = (c, side) => {
            const t = taken.get(`${c.level}|${side}`) ?? [];
            let lane = 0;
            while (t.some((u) => u.lane === lane && u.lo <= c.hi && c.lo <= u.hi)) lane++;
            return lane;
        };
        for (const c of cand) {
            let lane = laneOn(c, c.side);
            if (lane > 0 && laneOn(c, -c.side) < lane && between(c, -c.side) <= between(c, c.side)) {
                c.side = -c.side;
                lane = laneOn(c, c.side);
            }
            const key = `${c.level}|${c.side}`, t = taken.get(key) ?? taken.set(key, []).get(key);
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

    // A record's field has its own anchors: by the record's index and the cell's.
    const fieldAnchor = (id, field, p) => {
        const node = T.levels.get(T.items.get(id).level).nodes.get(id);
        return `${index.get(id)}f${cellsOf(node).findIndex((c) => c.field === field)}${p}`;
    };

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
            port: (id, p, field) => {
                if (T.items.get(id).kind === "dummy") p = "a";
                if (p === "l" || p === "r") sides.add(id);
                const name = field !== undefined ? fieldAnchor(id, field, p) : `${index.get(id)}${p}`;
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

    // Self-loops, off each node's side anchor.
    const loopShapes = [], loopLabelsAt = [];
    {
        const P = {
            add: (v, k) => (k ? `${v} ${k < 0 ? "-" : "+"} ${Math.abs(k)}` : v), fs,
            port: (id, p) => {
                sides.add(id);
                const name = `${index.get(id)}${p}`;
                return { f: nv(name, F), c: nv(name, X) };
            },
        };
        for (const [id, list] of loops) {
            for (const loop of list) loopShapes.push({ id, loop, ...loopRoute(graph, id, loop, P) });
            loopLabelsAt.push(...loopLabels(id, list, P, tb));
        }
    }

    const anchor = (name) => ({ canvas: {
        componentValues: { [`${prefix}${name}x`]: "rootX", [`${prefix}${name}y`]: "rootY" },
        modifiers: [{ size: [0, 0] }], commands: [],
    } });
    // Children in flow order: reversed on screen for BT and RL.
    const flowOrder = (kids) => (fs > 0 ? kids : [...kids].reverse());
    // Along the flow: anchors a (in) and b (out); across it, when an edge leaves or enters by
    // the side: anchors l and r, at the middle.
    // A node or group with an action is tappable (the anchors are 0x0, so this is its box).
    const wrap = (id, body) => {
        const i = index.get(id), it = T.items.get(id);
        const kids = flowOrder([anchor(`${i}a`), body, anchor(`${i}b`)]);
        const actions = it.kind === "label" ? actionsFor(graph, "edge", it.src, edgeId(it.src)) : actionsFor(graph, it.kind, it.src, id);
        const tap = actions ? [{ semantics: { contentDescription: labelOf(id), clickable: true } }, { onClick: actions }] : [];
        const flow = tb ? { column: { horizontalAlignment: "center", modifiers: tap, children: kids } }
                        : { row: { verticalAlignment: "center", modifiers: tap, children: kids } };
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
    const labelOf = (id) => T.levels.get(T.items.get(id).level).nodes.get(id).label;
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
        if (it.kind === "node" && isRecord(node.src)) {
            const i = index.get(id);
            return wrap(id, recordLayout(node, G.records.get(id), tb, (k, p) => anchor(`${i}f${k}${p}`), flowOrder, themeOf(graph)));
        }
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

    // Self-loops: along the flow the ends' eased blend, across it the cubic's own polynomial
    // (both control points the same distance out), off the side anchor.
    loopShapes.forEach(({ st, markers, side, d, out, lens, ends }, n) => {
        const id = `${prefix}loop${n}`;
        const along = `${side.f} + ${fs * d} * (2 * ${EASE} - 1)`;
        const u = "(1 - a[0])";
        const cross = `${side.c} + ${lens[0]} * ${u} * ${u} * ${u} + ${Math.round(out * 30) / 10} * a[0] * ${u} + ${lens[1]} * a[0] * a[0] * a[0]`;
        commands.push(strokePaint(st),
            { pathExpression: { id, expressionX: tb ? cross : along, expressionY: tb ? along : cross, start: 0, end: 1, count: 24 } },
            { drawPath: { path: id } });
        ends.forEach((e, i) => {
            const cmds = markerCommands(markers[i], st, endVector(e, tb, fs));
            if (!cmds.length) return;
            const [tx, ty] = xy(e);
            commands.push({ save: { commands: [{ translate: { dx: tx, dy: ty } }, ...cmds] } });
        });
    });

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

    // Loop labels the same way, beyond their node's loops.
    for (const { loop, f, c } of loopLabelsAt) {
        const { name, look, vars, w, h } = loop.label;
        if (!look.canvas) throw new Error(`look "${name}" has no canvas drawing (needed for a self-loop's label)`);
        const [cx, cy] = tb ? [c, f] : [f, c];
        const box = { left: `${cx} - ${w / 2}`, right: `${cx} + ${w / 2}`, top: `${cy} - ${h / 2}`, bottom: `${cy} + ${h / 2}`,
                      cx, cy, w, h, radius: h / 2 };
        const all = { ...vars, ...box }, where = `self-loop label on ${loop.edge.from}, look "${name}"`;
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

/**
 * How far past the space a reflowed graph's estimated size may go before it is panned instead:
 * across the flow a row gives way by wrapping its labels; along it nothing does.
 */
const SLACK = { cross: 1.25, flow: 1.08 };

/**
 * Drops the componentValues entries nothing reads (an anchor binds its x and y, and most anchors
 * need one of them; a node with no edge out needs neither of its out anchor's): a value nothing
 * uses is still computed by every player at every layout. Repeated, as a dropped expression may
 * have been the only reader of another.
 */
function pruneValues(view, variables) {
    for (;;) {
        const refs = new Set();
        const scan = (x) => {
            if (typeof x === "string") { for (const m of x.matchAll(/@([A-Za-z_][\w]*)/g)) refs.add(m[1]); }
            else if (Array.isArray(x)) x.forEach(scan);
            else if (x && typeof x === "object") Object.values(x).forEach(scan);
        };
        scan(view); scan(variables);
        let dropped = 0;
        const walk = (x) => {
            if (Array.isArray(x)) { x.forEach(walk); return; }
            if (!x || typeof x !== "object") return;
            if (x.componentValues && typeof x.componentValues === "object") {
                for (const k of Object.keys(x.componentValues)) if (!refs.has(k)) { delete x.componentValues[k]; dropped++; }
                if (!Object.keys(x.componentValues).length) delete x.componentValues;
            }
            Object.values(x).forEach(walk);
        };
        walk(view);
        if (!dropped) return { view, variables };
    }
}

export function reflowDoc(graph, { width = 400, height = 500, ...opts } = {}) {
    const { view, variables } = reflowView(graph, opts);
    return {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        ...(Object.keys(variables).length ? { resources: { variables } } : {}),
        root: [{ box: { modifiers: ["fillMaxSize", { background: themeOf(graph).bg }], children: [view] } }],
    };
}

/**
 * The reflowing graph as one component (it fills what it is given) and the variables it reads
 * (resources.variables entries: a value, an expression string or {value, anim}). `ns` starts
 * every name it declares, so several graphs can share a document. `guess` {width, height}
 * (expressions) is the space it is expected to get, for the first frame, before the space is
 * measured: the window by default; a graph under a title gets less.
 */
export function reflowView(graph, opts = {}) {
    const { view, variables } = reflowViewOf(graph, opts);
    return pruneValues(view, variables);
}

function reflowViewOf(graph, { direction, overflow, measure = measureLabel, ns = "", guess = {} } = {}) {
    const T = compound(graph);
    const dir = String(direction ?? graph.direction ?? "auto").toUpperCase();
    const pan = String(overflow ?? graph.overflow ?? "pan") !== "clip";
    const n = (name) => `${ns}${name}`;
    // The states: each orientation reflowing, then (with overflow "pan") the same orientations
    // as the fixed, pannable picture, for a graph too big to fit. Which one shows is picked from
    // sizes estimated from the looks (canvas mode's geometry; the engine's own measure is not
    // known when the state is picked) against the space. The space is measured by a canvas
    // filling the graph's box, not windowWidth(): androidx's player keeps that at the
    // document's declared size, while Kobento's players give the viewport. Until that canvas
    // is laid out its values hold the 1.0 placeholder and the windowWidth() guess stands, so
    // the usual case starts in the right state with no cross-fade.
    const dirs = dir === "AUTO" ? ["TB", "LR"] : [dir];
    const laid = dirs.map((d) => layout(graph, T, measure, d));
    const est = ({ G: { total } }) => [Math.ceil((total.w + 32) * 1.05), Math.ceil((total.h + 32) * 1.05)];
    // How much each orientation overflows (over 1: it does not fit) for a space w x h, as
    // named values (one expression for all would pass what Android reads).
    const over = (w, h, name, wrap) => Object.fromEntries(laid.map((l, i) => {
        const [ew, eh] = est(l), tb = axes(dirs[i]).tb;
        const [sw, sh] = tb ? [SLACK.cross, SLACK.flow] : [SLACK.flow, SLACK.cross];
        return [n(`${name}${i}`), wrap(`max(${Math.ceil(ew / sw)} / ${w}, ${Math.ceil(eh / sh)} / ${h})`)];
    }));
    const asVariable = (e) => e, asValue = (e) => ({ expression: e });
    // The state index: the orientation that overflows less (0 or 1), plus the orientations'
    // count when even that one does not fit (SLACK included).
    const pick = (name) => {
        const o = laid.map((_, i) => `@${n(`${name}${i}`)}`);
        const orient = o.length > 1 ? `step(${o[0]}, ${o[1]})` : "0";
        if (!pan) return orient;
        const least = o.length > 1 ? `min(${o[0]}, ${o[1]})` : o[0];
        return `${orient === "0" ? "" : `${orient} + `}${o.length} * step(${least}, 1)`;
    };
    const variants = laid.map((l, i) => reflowVariant(graph, T, l, dirs[i], n(dirs.length > 1 ? "tl"[i] : "v")));
    let variables = {};
    if (pan) {
        laid.forEach((l, i) => {
            const { view, variables: vs } = canvasView(graph, T, l, dirs[i], n(`c${i}`));
            variants.push(view);
            Object.assign(variables, vs);
        });
    }
    if (variants.length === 1) return { view: variants[0], variables };
    variables = { ...variables,
                  ...over(`max(${guess.width ?? "windowWidth()"}, 1)`, `max(${guess.height ?? "windowHeight()"}, 1)`, "overWindow", asVariable),
                  [n("orientWindow")]: pick("overWindow") };
    const view = { box: { modifiers: ["fillMaxSize"], children: [
        { canvas: { modifiers: ["fillMaxSize"], commands: [], componentValues: {
            [n("availW")]: "width", [n("availH")]: "height",
            ...over(`max(@${n("availW")}, 1)`, `max(@${n("availH")}, 1)`, "overMeasured", asValue),
            [n("orientMeasured")]: { expression: pick("overMeasured") },
            [n("orient")]: { expression: `ifElse(@${n("orientWindow")}, @${n("orientMeasured")}, @${n("availW")} - 1.5)` },
        } } },
        { stateLayout: { indexId: `@${n("orient")}`, modifiers: ["fillMaxSize"], children: variants } },
    ] } };
    return { view, variables };
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

export function canvasDoc(graph, { width = 400, height = 500, ...opts } = {}) {
    const { view, variables } = canvasGraphView(graph, opts);
    return {
        header: { apiLevel: 7, width, height, profiles: 513, contentDescription: describe(graph) },
        resources: { variables },
        root: [{ box: { modifiers: ["fillMaxSize", { background: themeOf(graph).bg }], children: [view] } }],
    };
}

/** Canvas mode as one component and its variables, as reflowView. */
export function canvasGraphView(graph, { direction, measure = measureLabel, ns = "" } = {}) {
    const T = compound(graph);
    let dir = String(direction ?? graph.direction ?? "TB").toUpperCase();
    if (dir === "AUTO") dir = "TB";
    const { view, variables } = canvasView(graph, T, layout(graph, T, measure, dir), dir, ns);
    return pruneValues(view, variables);
}

/**
 * The fixed picture with pan and zoom, as one component (canvas mode, and reflow mode's
 * fallback when the graph does not fit). `prefix` keeps its variables apart from another
 * view's in the same document.
 */
function canvasView(graph, T, { G, chains, room, loops }, dir, prefix) {
    const { geo, groupOrder, looks, total, tb, fs } = G;
    const xy = (p) => (tb ? [p.c, p.f] : [p.f, p.c]);

    const edgeCmds = [], arrowCmds = [], nodeLoopBodies = [];
    for (const chain of chains) {
        const off = chain.offset;
        const P = {
            add: (v, k) => v + k, fs,
            crossOf: (id) => G.crossOf(id),
            // Attachment points come from the spacing plan; parallel edges also keep apart
            // through their dummies.
            port: (id, p, field) => G.port(id, p, field),
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

    // Self-loops and their labels.
    const loopLabelCmds = [], loopLabelBoxes = [];
    {
        const P = { add: (v, k) => v + k, fs, port: (id, p) => G.port(id, p) };
        for (const [id, list] of loops) {
            for (const loop of list) {
                const { st, markers, pts, ends } = loopRoute(graph, id, loop, P);
                const at = (p) => xy(p).map(r1).join(" ");
                edgeCmds.push(strokePaint(st), { drawPath: { path: `M${at(pts[0])} C${at(pts[1])} ${at(pts[2])} ${at(pts[3])}` } });
                ends.forEach((e, i) => {
                    const cmds = markerCommands(markers[i], st, endVector(e, tb, fs));
                    if (!cmds.length) return;
                    const [tx, ty] = xy(e);
                    arrowCmds.push({ save: { commands: [{ translate: { dx: r1(tx), dy: r1(ty) } }, ...cmds] } });
                });
            }
            for (const { loop, f, c } of loopLabels(id, list, P, tb)) {
                const { name, look, vars, w, h } = loop.label;
                if (!look.canvas) throw new Error(`look "${name}" has no canvas drawing (needed by canvas mode)`);
                const [cx, cy] = xy({ f, c });
                const all = { ...vars, left: r1(cx - w / 2), top: r1(cy - h / 2), right: r1(cx + w / 2), bottom: r1(cy + h / 2),
                              cx: r1(cx), cy: r1(cy), w, h, radius: r1(h / 2) };
                loopLabelBoxes.push({ edge: loop.edge, box: all });
                const where = `self-loop label on ${loop.edge.from}, look "${name}"`;
                nodeLoopBodies.push(...fill(look.canvas.commands ?? [], all, where));
                loopLabelCmds.push(...fill(look.canvas.label ?? [], all, where));
            }
        }
    }

    const drawn = (id) => {
        if (G.records.has(id)) {
            const it = T.items.get(id);
            return recordCanvas(T.levels.get(it.level).nodes.get(id), G.records.get(id), geo.get(id), tb, themeOf(graph));
        }
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
    nodeCmds.push(...nodeLoopBodies); labelCmds.push(...loopLabelCmds);

    const GW = Math.max(1, Math.ceil(total.w)), GH = Math.max(1, Math.ceil(total.h));
    const v = (name) => `${prefix}${name}`, theme = themeOf(graph);
    // Fitted scale (never past 1.5x), times the user's zoom steps, animated.
    const scale = `min(min((width - 32) / ${GW}, (height - 32) / ${GH}), 1.5) * @${v("zoom")}`;
    const zoomButton = (step, label, glyph) => ({ canvas: {
        modifiers: [{ size: [40, 40] },
                    { semantics: { contentDescription: label, clickable: true } },
                    { onClick: { type: "valueFloatExpressionChange", target: `@${v("zoomSteps")}`,
                                 value: `clamp(-8, 8, @${v("zoomSteps")} + ${step})` } }],
        commands: [
            { paint: { ops: [{ color: theme.button }, { style: "fill" }] } },
            { drawRoundRect: { left: 0.5, top: 0.5, right: 39.5, bottom: 39.5, rx: 12, ry: 12 } },
            { paint: { ops: [{ color: theme.outline }, { style: "stroke" }, { width: 1 }] } },
            { drawRoundRect: { left: 0.5, top: 0.5, right: 39.5, bottom: 39.5, rx: 12, ry: 12 } },
            { paint: { ops: [{ color: theme.buttonFg }, { style: "stroke" }, { width: 2 }, { strokeCap: "round" }] } },
            ...glyph,
        ],
    } });
    const minus = { drawLine: { x1: 14, y1: 20, x2: 26, y2: 20 } };
    const plus = { drawLine: { x1: 20, y1: 14, x2: 20, y2: 26 } };

    // Tappable nodes, groups and edges (by their label): a transparent component each, with the
    // same click modifier and semantics as in reflow mode, kept over where the item is drawn as
    // the graph pans and zooms: computePosition places it (json2rc's computePosition: the
    // expressions run at layout time), its size is the scaled box. An offset modifier would
    // only move its drawing, not where a tap lands. The screen transform comes from the
    // canvas, as named values: its size, the scale, and where the graph's origin lands before
    // the pan (the pan's values come later, from the canvas's touch expressions).
    const taps = [];
    {
        const items = [];
        for (const id of groupOrder) items.push([id, actionsFor(graph, "group", T.items.get(id).src, id)]);
        for (const [id, it] of T.items) {
            if (it.kind === "node") items.push([id, actionsFor(graph, "node", it.src, id)]);
            else if (it.kind === "label") items.push([id, actionsFor(graph, "edge", it.src, edgeId(it.src))]);
        }
        const sc = `@${v("sc")}`;
        const target = (b, label, actions) => ({ box: { children: [], modifiers: [
            { computePosition: { x: `@${v("ox")} + @${v("panX")} + ${sc} * ${r1(b.left)}`,
                                 y: `@${v("oy")} + @${v("panY")} + ${sc} * ${r1(b.top)}` } },
            { width: `${sc} * ${r1(b.right - b.left)}` }, { height: `${sc} * ${r1(b.bottom - b.top)}` },
            { semantics: { contentDescription: label, clickable: true } }, { onClick: actions },
        ] } });
        for (const [id, actions] of items) {
            if (actions) taps.push(target(geo.get(id), T.levels.get(T.items.get(id).level).nodes.get(id).label, actions));
        }
        for (const { edge, box } of loopLabelBoxes) {
            const actions = actionsFor(graph, "edge", edge, edgeId(edge));
            if (actions) taps.push(target(box, String(edge.label), actions));
        }
    }
    const screen = taps.length ? {
        [v("cw")]: "width", [v("ch")]: "height",
        [v("sc")]: { expression: `min(min((@${v("cw")} - 32) / ${GW}, (@${v("ch")} - 32) / ${GH}), 1.5) * @${v("zoom")}` },
        [v("ox")]: { expression: `@${v("cw")} * 0.5 - @${v("sc")} * ${GW / 2}` },
        [v("oy")]: { expression: `@${v("ch")} * 0.5 - @${v("sc")} * ${GH / 2}` },
    } : null;

    const view = { box: {
        modifiers: ["fillMaxSize"],
        children: [
            { canvas: {
                modifiers: ["fillMaxSize", { semantics: { contentDescription: `${describe(graph)}. Drag to pan.` } }],
                ...(screen ? { componentValues: screen } : {}),
                commands: [
                    { touchExpression: { name: v("panX"), defaultValue: 0, min: -100000, max: 100000, stopMode: "gently", expression: "touchX()" } },
                    { touchExpression: { name: v("panY"), defaultValue: 0, min: -100000, max: 100000, stopMode: "gently", expression: "touchY()" } },
                    { save: { commands: [
                        { translate: { dx: `width * 0.5 + @${v("panX")}`, dy: `height * 0.5 + @${v("panY")}` } },
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
            // Later children take a tap first: inner nodes over their groups (taps' order),
            // the zoom buttons over everything.
            ...(taps.length ? [{ box: { modifiers: ["fillMaxSize"], children: taps } }] : []),
            { column: {
                horizontalAlignment: "end", verticalAlignment: "bottom",
                modifiers: ["fillMaxSize", { padding: [12, 12] }, { spacedBy: 8 }],
                children: [zoomButton(1, "Zoom in", [minus, plus]), zoomButton(-1, "Zoom out", [minus])],
            } },
        ],
    } };
    const variables = {
        [v("zoomSteps")]: 0,
        [v("zoom")]: { value: `pow(1.25, @${v("zoomSteps")})`, anim: 0.25 },
    };
    return { view, variables };
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
        console.error("usage: graph2rc.mjs graph.json out.json [--mode reflow|canvas] [--direction TB|BT|LR|RL|auto]\n" +
                      "                    [--overflow pan|clip] [--width N] [--height N]");
        process.exit(2);
    }
    const opt = {};
    for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
    for (const k of ["width", "height"]) if (k in opt) opt[k] = Number(opt[k]);
    const graph = JSON.parse(readFileSync(inPath, "utf8"));
    const doc = (opt.mode ?? "reflow") === "canvas" ? canvasDoc(graph, opt) : reflowDoc(graph, opt);
    writeFileSync(outPath, JSON.stringify(doc, null, 1));
}
