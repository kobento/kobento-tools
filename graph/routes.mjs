// routes.mjs — the shape of every edge, shared by both modes and all four directions.
//
// A route is a list of points in flow/cross terms (TB/BT: flow is y, cross is x; LR/RL the
// other way; screen coordinates either way) joined by `curve`s (the cubic with both control
// points halfway along the flow, so it leaves and arrives along the flow), straight `line`s
// and `skip`s (no ink: across an edge label), plus its two ends and the way they point. The
// points come from a port provider: numbers in canvas mode, anchor expressions in reflow mode,
// so one routine serves both.
//
//   - Out of the source's far port (b), into the target's near port (a).
//   - Through each dummy as a straight run across its whole rank band, so a long edge passes
//     beside whatever else is in that rank, however tall (a group, say).
//   - Into an edge label's near port and out of its far one: the label sits on the line.
//   - An end deep inside a group -- not on the group's boundary rank, at every level up to
//     the group the edge leaves from -- goes out sideways: from the node's side, straight to
//     just past the group's border, then on along the flow. Going out through the far port
//     would cut across the group's later nodes.
//
// Each end stops its marker's length short of its port.

import { chainEnds } from "./compound.mjs";

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
 *               (from any layout with the right order) to pick a side with; P.fs -> +1 when the
 *               flow runs along increasing screen coordinates (TB, LR), -1 otherwise
 * @param lens   [start, end]: how far each end stops short (its marker's length)
 * @returns {pts: [{f, c}], segs: ["curve" | "line" | "skip"],
 *           ends: [start, end], each {f, c, dir: "+f" | "-f" | "+c" | "-c"} -- its port, and the
 *           way a marker there points (into the node)}
 */
export function route(T, chain, P, lens = [0, 0]) {
    const { path, real } = chain;
    const n = path.length;
    const pts = [], segs = [];
    const ends = [];

    // Start (path[0] is the level child the edge leaves; real[0] the node in it).
    if (real[0] !== path[0] && !onBoundary(T, real[0], path[0], true)) {
        const side = P.crossOf(path[1]) >= P.crossOf(path[0]) ? "r" : "l", s = side === "r" ? 1 : -1;
        const p = P.port(real[0], side);
        pts.push(p, { f: p.f, c: P.add(P.port(path[0], side).c, s * MARGIN) });
        segs.push("line");
        ends.push({ ...p, dir: s > 0 ? "-c" : "+c" });
    } else {
        const p = P.port(real[0], "b");
        pts.push(p);
        ends.push({ ...p, dir: "-f" });
    }
    // Dummies and labels.
    for (let k = 1; k < n - 1; k++) {
        if (T.items.get(path[k]).kind === "label") {
            pts.push(P.port(path[k], "a"), P.port(path[k], "b"));
            segs.push("curve", "skip");
        } else {
            const b = P.band(path[k]);
            pts.push({ f: b.f0, c: b.c }, { f: b.f1, c: b.c });
            segs.push("curve", "line");
        }
    }
    // End.
    if (real[n - 1] !== path[n - 1] && !onBoundary(T, real[n - 1], path[n - 1], false)) {
        const side = P.crossOf(path[n - 2]) >= P.crossOf(path[n - 1]) ? "r" : "l", s = side === "r" ? 1 : -1;
        const p = P.port(real[n - 1], side);
        pts.push({ f: p.f, c: P.add(P.port(path[n - 1], side).c, s * MARGIN) }, p);
        segs.push("curve", "line");
        ends.push({ ...p, dir: s > 0 ? "-c" : "+c" });
    } else {
        const p = P.port(real[n - 1], "a");
        pts.push(p);
        segs.push("curve");
        ends.push({ ...p, dir: "+f" });
    }

    // Each end stops short of its port, back along its marker.
    [[0, ends[0], lens[0]], [pts.length - 1, ends[1], lens[1]]].forEach(([i, e, len]) => {
        if (!len) return;
        const axis = e.dir[1], sign = e.dir[0] === "+" ? 1 : -1;
        const k = -sign * len * (axis === "f" ? P.fs : 1);
        pts[i] = { ...pts[i], [axis]: P.add(pts[i][axis], k) };
    });
    return { pts, segs, ends };
}

/** The screen unit vector a marker at `end` points along. */
export function endVector(end, tb, fs) {
    const sign = end.dir[0] === "+" ? 1 : -1;
    const flow = tb ? [0, fs] : [fs, 0], cross = tb ? [1, 0] : [0, 1];
    const u = end.dir[1] === "f" ? flow : cross;
    return [u[0] * sign, u[1] * sign];
}
