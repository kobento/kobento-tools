// geometry.mjs — fixed positions for every node, group and dummy (top to bottom).
//
// Canvas mode draws with these. Reflow mode lets the engine place things, but uses these to
// make the few choices it must make up front (which side an edge leaves a group by), since
// the order across each rank -- all that choice depends on -- is the same.

import { coordinates } from "./layered.mjs";
import { ROOT } from "./compound.mjs";
import { lookFor, lookForGroup, lookSize, groupSize } from "./looks.mjs";

export const SPACING = { TB: { node: 24, rank: 56 }, LR: { node: 16, rank: 72 } };

/**
 * @returns {geo: Map<id, box>, groupOrder: [id] (parents first), looks: Map<id, look>, total: {w, h}}
 *   box: {left, top, right, bottom, cx, cy, w, h} for nodes and groups, {cx, top, bottom} for
 *   dummies (their rank band).
 */
export function geometry(graph, T, measure) {
    const sp = SPACING.TB;
    const levelGeo = new Map(), looks = new Map();
    // Bottom-up sizes: a group's card is its own layout plus padding and title.
    const layoutLevel = (gid) => {
        if (levelGeo.has(gid)) return levelGeo.get(gid).size;
        const L = T.levels.get(gid);
        const C = L.layers.length ? coordinates(L, itemSize, { nodeSep: sp.node, rankSep: sp.rank }) : null;
        const size = C ? { w: C.width, h: C.height } : { w: 0, h: 0 };
        levelGeo.set(gid, { L, C, size });
        return size;
    };
    function itemSize(id) {
        const it = T.items.get(id);
        if (it.kind === "node") {
            const n = T.levels.get(it.level).nodes.get(id);
            looks.set(id, lookFor(graph, n));
            return lookSize(looks.get(id).look, n.label, measure);
        }
        const grp = T.groups.get(id);
        looks.set(id, lookForGroup(graph, grp));
        return groupSize(looks.get(id).look, grp.label, layoutLevel(id), measure);
    }
    const total = layoutLevel(ROOT);

    // Top-down absolute boxes; groups recorded parent first, so they draw under their insides.
    const geo = new Map(), groupOrder = [];
    const place = (gid, ox, oy) => {
        const { L, C } = levelGeo.get(gid);
        if (!C) return;
        for (const [id, n] of L.nodes) {
            const cx = ox + C.x.get(id), top = oy + C.rankTop[n.rank], bandH = C.rankH[n.rank];
            if (n.dummy) { geo.set(id, { cx, top, bottom: top + bandH }); continue; }
            const { w, h } = C.dim.get(id), cy = top + bandH / 2;
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
    return { geo, groupOrder, looks, total };
}
