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
//     beside whatever else is in that rank, however tall (a group, say). Or, given a lane,
//     the whole middle as one straight run beside the ranks (reflow mode's long edges).
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
 * How a chain's two ends attach: {id, port} -- the far port (b) at the start and the near one
 * (a) at the end, or a side (l / r) for an end deep inside the group the edge leaves (`via`).
 */
export function attachEnds(T, chain, crossOf) {
    const { path, real } = chain, n = path.length;
    const end = (k, other, flowPort, last) => {
        if (real[k] !== path[k] && !onBoundary(T, real[k], path[k], last)) {
            return { id: real[k], port: crossOf(path[other]) >= crossOf(path[k]) ? "r" : "l", via: path[k] };
        }
        return { id: real[k], port: flowPort };
    };
    return [end(0, 1, "b", true), end(n - 1, n - 2, "a", false)];
}

const SLOT = 16;      // the most room between two edges sharing a port
const EXIT_STEP = 14; // between side exits from one group's side
const EXIT_GAP = 14;  // kept clear beyond a group's farthest side exit

/**
 * Room between edges, decided over all of them at once (both modes use it):
 *   - Edges sharing a port get attachment points of their own, spread across the node (along
 *     it for a side port), up to SLOT apart and less on a narrow node. Ordered by where each
 *     edge goes next, so spreading them adds no crossing.
 *   - Side exits through the same side of the same group turn at different distances past its
 *     border: an exit from further along the flow runs nearer the group (and an entry the
 *     other way round), so no exit's stub crosses another's run.
 *
 * @param chains  from allChains
 * @param G       geometry (geometry.mjs) for the direction: boxes, crossOf, tb
 * @returns Map<chain.key, {attach: [start, end], margin: [start, end]}>, and .exitRoom:
 *          Map<groupId, {l, r}> -- the room to keep beside a group for its side exits
 */
export function spacing(T, chains, G) {
    const plan = new Map(chains.map((c) => [c.key, { attach: [0, 0], margin: [MARGIN, MARGIN] }]));
    const byPort = new Map(), byExit = new Map();
    const flowPos = (id) => { const g = G.geo.get(id); return (G.tb ? g.cy : g.cx) * G.fs; };
    for (const c of chains) {
        const n = c.path.length;
        attachEnds(T, c, G.crossOf).forEach((e, i) => {
            const toward = c.path[i === 0 ? 1 : n - 2], far = c.path[i === 0 ? n - 1 : 0];
            const key = `${e.id}|${e.port}`;
            (byPort.get(key) ?? byPort.set(key, []).get(key)).push({
                c, i, order: [G.crossOf(toward), G.crossOf(far), c.key] });
            if (e.via) {
                const xk = `${e.via}|${e.port}`;
                (byExit.get(xk) ?? byExit.set(xk, []).get(xk)).push({ c, i, at: flowPos(e.id) });
            }
        });
    }
    const cmp = (a, b) => {
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
        return 0;
    };
    for (const [key, list] of byPort) {
        if (list.length < 2) continue;
        const [id, port] = key.split("|");
        const g = G.geo.get(id);
        const flowPort = port === "a" || port === "b";
        const extent = flowPort ? (G.tb ? g.w : g.h) : (G.tb ? g.h : g.w);
        const step = Math.max(4, Math.min(SLOT, (extent - 12) / (list.length - 1)));
        list.sort((a, b) => cmp(a.order, b.order));
        list.forEach((e, k) => { plan.get(e.c.key).attach[e.i] = (k - (list.length - 1) / 2) * step; });
    }
    // The room a group needs beside it, per side, for the runs of its side exits: the farthest
    // one plus a gap. The layout keeps that clear (geometry's pad, reflow's padding), so a
    // neighbour, a dummy or a lane never runs alongside an exit.
    plan.exitRoom = new Map();
    for (const [key, list] of byExit) {
        // Exits (i = 0): further along the flow nearer the group; entries (i = 1): the reverse.
        list.sort((a, b) => (a.i - b.i) || (a.i === 0 ? b.at - a.at : a.at - b.at));
        list.forEach((e, k) => { plan.get(e.c.key).margin[e.i] = MARGIN + EXIT_STEP * k; });
        const [via, side] = key.split("|");
        const r = plan.exitRoom.get(via) ?? plan.exitRoom.set(via, { l: 0, r: 0 }).get(via);
        r[side] = MARGIN + EXIT_STEP * (list.length - 1) + EXIT_GAP;
    }
    return plan;
}

/**
 * @param chain  from allChains
 * @param P      port provider: P.port(id, "a" | "b" | "l" | "r") -> {f, c};
 *               P.band(dummyId) -> {f0, f1, c}; P.add(v, k) -> v + k; P.crossOf(id) -> a number
 *               (from any layout with the right order) to pick a side with; P.fs -> +1 when the
 *               flow runs along increasing screen coordinates (TB, LR), -1 otherwise; optional
 *               P.lane(chain) -> a cross position for the edge's middle, or null
 * @param lens   [start, end]: how far each end stops short (its marker's length)
 * @param room   from spacing(): this chain's attachment offsets and side-exit margins
 * @returns {pts: [{f, c}], segs: ["curve" | "line" | "skip"],
 *           ends: [start, end], each {f, c, dir: "+f" | "-f" | "+c" | "-c"} -- its port, and the
 *           way a marker there points (into the node)}
 */
export function route(T, chain, P, lens = [0, 0], room = { attach: [0, 0], margin: [MARGIN, MARGIN] }) {
    const { path } = chain;
    const n = path.length;
    const pts = [], segs = [];
    const ends = [];
    const [a0, a1] = attachEnds(T, chain, P.crossOf);
    // A port, moved to this edge's own attachment point: across a flow port, along a side one.
    const at = (e, k) => {
        const p = P.port(e.id, e.port), o = room.attach[k];
        return e.port === "a" || e.port === "b" ? { f: p.f, c: P.add(p.c, o) } : { f: P.add(p.f, o), c: p.c };
    };

    // Start (path[0] is the level child the edge leaves; a0.id the node in it).
    const p0 = at(a0, 0);
    if (a0.via) {
        const s = a0.port === "r" ? 1 : -1;
        pts.push(p0, { f: p0.f, c: P.add(P.port(a0.via, a0.port).c, s * room.margin[0]) });
        segs.push("line");
        ends.push({ ...p0, dir: s > 0 ? "-c" : "+c" });
    } else {
        pts.push(p0);
        ends.push({ ...p0, dir: "-f" });
    }
    // Dummies and labels -- or, for an edge given a lane (P.lane), one straight run at the
    // lane's cross position from the first dummy's rank band to the last one's.
    const lane = P.lane ? P.lane(chain) : null;
    if (lane) {
        pts.push({ f: P.band(path[1]).f0, c: lane }, { f: P.band(path[n - 2]).f1, c: lane });
        segs.push("curve", "line");
    }
    for (let k = 1; k < n - 1 && !lane; k++) {
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
    const p1 = at(a1, 1);
    if (a1.via) {
        const s = a1.port === "r" ? 1 : -1;
        pts.push({ f: p1.f, c: P.add(P.port(a1.via, a1.port).c, s * room.margin[1]) }, p1);
        segs.push("curve", "line");
        ends.push({ ...p1, dir: s > 0 ? "-c" : "+c" });
    } else {
        pts.push(p1);
        segs.push("curve");
        ends.push({ ...p1, dir: "+f" });
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
