// geometry.mjs — fixed positions for every node, group, edge label and dummy, in any direction.
//
// Canvas mode draws with these. Reflow mode lets the engine place things, but uses these to
// make the few choices it must make up front (which side an edge leaves a group by), since
// the order across each rank -- all that choice depends on -- is the same.
//
// Each group's own layout is computed across/along its ranks (coordinates() in layered.mjs),
// then placed on the screen for the direction: TB and BT put the flow on y (BT upwards), LR
// and RL on x. A group's card keeps its title on top whatever the direction.

import { coordinates } from "./layered.mjs";
import { ROOT } from "./compound.mjs";
import { lookFor, lookForGroup, lookForLabel, lookSize, groupSize } from "./looks.mjs";

export const SPACING = { TB: { node: 24, rank: 56 }, LR: { node: 16, rank: 72 } };

/** The direction's axes: tb (flow on y), fs (+1 along increasing screen coordinates). */
export function axes(dir) {
    if (!["TB", "BT", "LR", "RL"].includes(dir)) throw new Error(`unknown direction "${dir}"`);
    const tb = dir === "TB" || dir === "BT";
    return { tb, fs: dir === "TB" || dir === "LR" ? 1 : -1, spacing: SPACING[tb ? "TB" : "LR"] };
}

/**
 * @returns {
 *   geo: Map<id, box>     box: {left, top, right, bottom, cx, cy, w, h} for nodes, groups and
 *                         edge labels; {c, f0, f1} for dummies (their run across the rank band,
 *                         in flow order, screen coordinates)
 *   groupOrder: [id]      parents first
 *   looks: Map<id, look>
 *   total: {w, h}         screen size
 *   port(id, p), band(id), crossOf(id)    in flow/cross screen terms (see routes.mjs)
 * }
 */
export function geometry(graph, T, measure, dir = "TB") {
    const { tb, fs, spacing } = axes(dir);
    const toFC = ({ w, h }) => (tb ? { w, h } : { w: h, h: w });     // screen -> (cross, flow)
    const toScreen = ({ w, h }) => (tb ? { w, h } : { w: h, h: w }); // (cross, flow) -> screen
    const levelGeo = new Map(), looks = new Map(), screenDim = new Map();

    // Bottom-up sizes: a group's card is its own layout plus padding and title.
    const layoutLevel = (gid) => {
        if (levelGeo.has(gid)) return levelGeo.get(gid).size;
        const L = T.levels.get(gid);
        const C = L.layers.length ? coordinates(L, itemSize, { nodeSep: spacing.node, rankSep: spacing.rank }) : null;
        const size = C ? toScreen({ w: C.width, h: C.height }) : { w: 0, h: 0 };
        levelGeo.set(gid, { L, C, size });
        return size;
    };
    function itemSize(id) {
        const it = T.items.get(id), n = T.levels.get(it.level).nodes.get(id);
        let d;
        if (it.kind === "node") { looks.set(id, lookFor(graph, n)); d = lookSize(looks.get(id).look, n.label, measure); }
        else if (it.kind === "label") { looks.set(id, lookForLabel(graph, n)); d = lookSize(looks.get(id).look, n.label, measure); }
        else {
            const grp = T.groups.get(id);
            looks.set(id, lookForGroup(graph, grp));
            d = groupSize(looks.get(id).look, grp.label, layoutLevel(id), measure);
        }
        screenDim.set(id, d);
        return toFC(d);
    }
    const total = layoutLevel(ROOT);

    // Top-down screen boxes; groups recorded parent first, so they draw under their insides.
    const geo = new Map(), groupOrder = [];
    const place = (gid, ox, oy) => {
        const { L, C, size } = levelGeo.get(gid);
        if (!C) return;
        const o = tb ? oy : ox, extent = tb ? size.h : size.w;      // flow origin and extent
        const along = (t) => (fs > 0 ? o + t : o + extent - t);     // flow offset -> screen
        for (const [id, n] of L.nodes) {
            const c = (tb ? ox : oy) + C.x.get(id), t = C.rankTop[n.rank], bh = C.rankH[n.rank];
            if (n.dummy && !n.edgeLabel) { geo.set(id, { c, f0: along(t), f1: along(t + bh) }); continue; }
            const mid = along(t + bh / 2);
            const { w, h } = screenDim.get(id);
            const [cx, cy] = tb ? [c, mid] : [mid, c];
            const box = { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, cx, cy, w, h };
            geo.set(id, box);
            if (T.items.get(id).kind === "group") {
                groupOrder.push(id);
                const look = looks.get(id).look, [px, py] = look.padding ?? [14, 10];
                const inner = levelGeo.get(id).size;
                place(id, box.left + px + (w - 2 * px - inner.w) / 2, box.top + py + (look.title ?? 24));
            }
        }
    };
    place(ROOT, 0, 0);

    // Ports in flow/cross terms: a where edges come in (the box's start along the flow), b where
    // they leave, l / r its sides across the flow (the lower and higher cross coordinate).
    const port = (id, p) => {
        const g = geo.get(id);
        if (!("left" in g)) return { f: g.f0, c: g.c };
        const [fLo, fHi, fMid, cLo, cHi, cMid] = tb
            ? [g.top, g.bottom, g.cy, g.left, g.right, g.cx]
            : [g.left, g.right, g.cx, g.top, g.bottom, g.cy];
        const [fIn, fOut] = fs > 0 ? [fLo, fHi] : [fHi, fLo];
        return { a: { f: fIn, c: cMid }, b: { f: fOut, c: cMid }, l: { f: fMid, c: cLo }, r: { f: fMid, c: cHi } }[p];
    };
    const band = (id) => geo.get(id);
    const crossOf = (id) => { const g = geo.get(id); return "left" in g ? (tb ? g.cx : g.cy) : g.c; };
    return { geo, groupOrder, looks, total, port, band, crossOf, tb, fs };
}
