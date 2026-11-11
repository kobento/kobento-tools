// loops.mjs — self-loops: an edge from a node (or group) to itself.
//
// A loop leaves the node's far side across the flow (r), swings out and comes back in a little
// further along the flow: a cubic whose two control points sit at the same distance out, so it
// leaves and arrives square to the side. Several loops on one node nest, each reaching further
// out and attaching further apart. A label goes beyond the outermost loop, at the node's middle.
// The room all that takes is kept clear beside the node (geometry's pad, reflow's padding), the
// same way as a group's side exits.

import { lookForLabel, lookSize } from "./looks.mjs";
import { edgeStyle, markerLength } from "./edges.mjs";

const REACH = 20;      // how far the first loop reaches out from the side
const REACH_STEP = 12; // each further loop on the same node
const SPREAD = 8;      // half the distance between a loop's two ends, along the flow
const SPREAD_STEP = 4;
const LABEL_GAP = 6;   // between the outermost loop and the labels
const AFTER = 8;       // kept clear beyond everything

/**
 * Every self-loop, per node: Map<id, [{edge, k, label: {name, look, vars, w, h} | null}]>.
 * Its edges come from compound() (T.loops).
 */
export function loopsOf(graph, T, measure) {
    const out = new Map();
    for (const edge of T.loops) {
        const list = out.get(edge.from) ?? out.set(edge.from, []).get(edge.from);
        let label = null;
        if (edge.label !== undefined && edge.label !== null && String(edge.label) !== "") {
            const node = { id: `${edge.from}~loop${list.length}`, label: String(edge.label), src: edge };
            const lk = lookForLabel(graph, node);
            label = { ...lk, text: node.label, ...lookSize(lk.look, node.label, measure) };
        }
        list.push({ edge, k: list.length, label });
    }
    return out;
}

/** How far out the loops reach: the outermost one's reach. */
const reachOf = (list) => REACH + REACH_STEP * (list.length - 1);

/** The room a node's loops take beside it, across the flow (screen width for TB, height for LR). */
export function loopRoom(list, tb) {
    const labels = list.filter((l) => l.label);
    const lw = Math.max(0, ...labels.map((l) => (tb ? l.label.w : l.label.h)));
    return reachOf(list) + (labels.length ? LABEL_GAP + lw : 0) + AFTER;
}

/**
 * One loop's shape. P is the port provider of routes.mjs (P.port(id, "r") gives the side's
 * middle; P.add adds a constant to a value, number or expression).
 *
 * @returns {pts: [start, control, control, end] in flow/cross terms, ends: [start, end] (the
 *          ports, each {f, c, dir}), markers, st; and the same as numbers off the side's middle:
 *          side, d (each end's distance along the flow), out (the controls' distance out), lens}
 */
export function loopRoute(graph, id, loop, P) {
    const st = edgeStyle(graph, loop.edge);
    const lens = [markerLength(st.tail), markerLength(st.head)];
    const side = P.port(id, "r");
    const d = SPREAD + SPREAD_STEP * loop.k, reach = REACH + REACH_STEP * loop.k;
    const fs = P.fs;
    const f0 = P.add(side.f, -fs * d), f1 = P.add(side.f, fs * d);
    const out = P.add(side.c, Math.round((reach * 40) / 3) / 10);   // the control points: the curve peaks at `reach`
    return {
        st, markers: [st.tail, st.head], side, d, lens, out: Math.round((reach * 40) / 3) / 10,
        pts: [{ f: f0, c: P.add(side.c, lens[0]) }, { f: f0, c: out }, { f: f1, c: out }, { f: f1, c: P.add(side.c, lens[1]) }],
        ends: [{ f: f0, c: side.c, dir: "-c" }, { f: f1, c: side.c, dir: "-c" }],
    };
}

/**
 * Where a node's loop labels go: beyond the outermost loop, stacked along the flow about the
 * node's middle. @returns [{loop, f, c}] -- each label's centre, in flow/cross terms.
 */
export function loopLabels(id, list, P, tb) {
    const labels = list.filter((l) => l.label);
    if (!labels.length) return [];
    const side = P.port(id, "r");
    const lw = Math.max(...labels.map((l) => (tb ? l.label.w : l.label.h)));
    const along = (l) => (tb ? l.label.h : l.label.w);
    const total = labels.reduce((t, l) => t + along(l), 0) + 4 * (labels.length - 1);
    let at = -total / 2;
    return labels.map((l) => {
        const mid = at + along(l) / 2;
        at += along(l) + 4;
        return { loop: l, f: P.add(side.f, P.fs * mid), c: P.add(side.c, reachOf(list) + LABEL_GAP + lw / 2) };
    });
}
