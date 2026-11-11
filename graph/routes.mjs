// routes.mjs — the shape of every edge, shared by both modes.
//
// A route is a list of points in flow/cross terms (TB: flow is y, cross is x; LR the other
// way) joined by `curve`s (the cubic with both control points halfway along the flow, so it
// leaves and arrives along the flow) and straight `line`s, plus where its arrowhead sits.
// The points come from a port provider: numbers in canvas mode, anchor expressions in reflow
// mode, so one routine serves both.
//
//   - Out of the source's far port (b), into the target's near port (a).
//   - Through each dummy as a straight run across its whole rank band, so a long edge passes
//     beside whatever else is in that rank, however tall (a group, say).
//   - An end deep inside a group -- not on the group's boundary rank, at every level up to
//     the group the edge leaves from -- goes out sideways: from the node's side, straight to
//     just past the group's border, then on along the flow. Going out through the bottom would
//     cut across the group's later nodes.
//
// The end with the arrowhead stops ARROW short of its port.

import { chainEnds } from "./compound.mjs";

export const ARROW = 9;
const MARGIN = 12;   // how far past a group's border a side exit runs before turning

/** Every edge chain of every group, its path's ends replaced by the real nodes. */
export function* allChains(T) {
    let li = 0;
    for (const L of T.levels.values()) {
        let ci = 0;
        for (const c of L.chains) {
            const [from, to] = chainEnds(c);
            yield { ...c, real: [from, ...c.path.slice(1, -1), to], key: `${li}_${ci++}` };
        }
        li++;
    }
}

/** Whether `id` is on its level's first (or last) rank, and so on up to (not including) `top`. */
function onBoundary(T, id, top, last) {
    for (let x = id; x !== top; x = T.items.get(x).level) {
        const L = T.levels.get(T.items.get(x).level);
        if (L.nodes.get(x).rank !== (last ? L.layers.length - 1 : 0)) return false;
    }
    return true;
}

/**
 * @param chain  from allChains
 * @param P      port provider: P.port(id, "a" | "b" | "l" | "r") -> {f, c};
 *               P.band(dummyId) -> {f0, f1, c}; P.add(v, k) -> v + k; P.crossOf(id) -> a number
 *               (from any layout with the right order) to pick a side with
 * @returns {pts: [{f, c}], segs: ["curve" | "line"], arrow: {f, c, dir: "+f" | "-f" | "+c" | "-c"}}
 */
export function route(T, chain, P) {
    const { path, real, reversed } = chain;
    const n = path.length;
    const pts = [], segs = [];
    let arrow = null;

    // Source end (path[0] is the level child the edge leaves; real[0] the node in it).
    const srcDeep = real[0] !== path[0] && !onBoundary(T, real[0], path[0], true);
    if (srcDeep) {
        const side = P.crossOf(path[1]) >= P.crossOf(path[0]) ? "r" : "l", s = side === "r" ? 1 : -1;
        const p = P.port(real[0], side);
        pts.push(p, { f: p.f, c: P.add(P.port(path[0], side).c, s * MARGIN) });
        segs.push("line");
        if (reversed) arrow = { ...p, dir: s > 0 ? "-c" : "+c" };
    } else {
        const p = P.port(real[0], "b");
        pts.push(p);
        if (reversed) arrow = { ...p, dir: "-f" };
    }
    // Dummies.
    for (let k = 1; k < n - 1; k++) {
        const b = P.band(path[k]);
        pts.push({ f: b.f0, c: b.c }, { f: b.f1, c: b.c });
        segs.push("curve", "line");
    }
    // Target end.
    const dstDeep = real[n - 1] !== path[n - 1] && !onBoundary(T, real[n - 1], path[n - 1], false);
    if (dstDeep) {
        const side = P.crossOf(path[n - 2]) >= P.crossOf(path[n - 1]) ? "r" : "l", s = side === "r" ? 1 : -1;
        const p = P.port(real[n - 1], side);
        pts.push({ f: p.f, c: P.add(P.port(path[n - 1], side).c, s * MARGIN) }, p);
        segs.push("curve", "line");
        if (!reversed) arrow = { ...p, dir: s > 0 ? "-c" : "+c" };
    } else {
        const p = P.port(real[n - 1], "a");
        pts.push(p);
        segs.push("curve");
        if (!reversed) arrow = { ...p, dir: "+f" };
    }

    // Stop short of the arrowhead's port, along the arrow.
    const i = reversed ? 0 : pts.length - 1;
    const back = { "+f": ["f", -1], "-f": ["f", 1], "+c": ["c", -1], "-c": ["c", 1] }[arrow.dir];
    pts[i] = { ...pts[i], [back[0]]: P.add(pts[i][back[0]], back[1] * ARROW) };
    return { pts, segs, arrow };
}

/** SVG path of an arrowhead with its tip at the origin pointing along `dir` (TB: f = y). */
export function arrowPath(dir, tb) {
    const a = ARROW, h = 4.5;
    // In flow/cross terms the base is a back along the arrow and ±h across it.
    const [axis, sign] = [dir[1], dir[0] === "+" ? 1 : -1];
    const base = (along, across) => {
        const fc = axis === "f" ? { f: along, c: across } : { f: across, c: along };
        return tb ? [fc.c, fc.f] : [fc.f, fc.c];
    };
    const [x1, y1] = base(-a * sign, -h), [x2, y2] = base(-a * sign, h);
    return `M0 0 L${x1} ${y1} L${x2} ${y2} Z`;
}
