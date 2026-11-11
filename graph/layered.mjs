// layered.mjs — the structural half of a layered (Sugiyama-style) graph layout, shared by
// both emitters: cycle breaking, ranking, long-edge dummies, crossing reduction, and (for the
// static canvas only) coordinate assignment.

/**
 * @param graph {nodes: [{id, label?, color?}], edges: [{from, to, color?}]}
 * @param dummyPrefix  ids of the dummies this call makes (unique across calls laying out
 *                     several graphs whose ids share one namespace, e.g. nested groups)
 * @returns {
 *   layers:  [[id]]                           ranks top to bottom, each in left-to-right order
 *   nodes:   Map<id, {id, label, src, dummy, edgeLabel?, rank}>
 *                                              src: the node's own JSON (an edge label: the edge's)
 *   chains:  [{edge, path: [id], reversed, offset}]
 *                                              each edge as the node/dummy ids it passes through,
 *                                              from its upper end to its lower end; offset (px,
 *                                              across the edge) separates parallel edges
 *   dropped: [edge]                            self-loops, not drawn yet
 * }
 */
export function layered(graph, { dummyPrefix = "__d" } = {}) {
    const nodes = new Map();
    for (const n of graph.nodes ?? []) {
        if (nodes.has(n.id)) throw new Error(`duplicate node ${n.id}`);
        nodes.set(n.id, { id: n.id, label: String(n.label ?? n.id), src: n, dummy: false, rank: 0 });
    }
    const dropped = [];
    const edges = [];
    for (const e of graph.edges ?? []) {
        if (!nodes.has(e.from) || !nodes.has(e.to)) throw new Error(`edge ${e.from}->${e.to}: unknown node`);
        if (e.from === e.to) dropped.push(e); else edges.push(e);
    }

    // Cycle breaking: a DFS in input order; an edge back into the DFS stack is reversed.
    const reversed = new Set();
    const out = new Map([...nodes.keys()].map((id) => [id, []]));
    edges.forEach((e, i) => out.get(e.from).push(i));
    const state = new Map();   // 1 on stack, 2 done
    const dfs = (id) => {
        state.set(id, 1);
        for (const i of out.get(id)) {
            const to = edges[i].to;
            if (state.get(to) === 1) reversed.add(i);
            else if (!state.has(to)) dfs(to);
        }
        state.set(id, 2);
    };
    for (const id of nodes.keys()) if (!state.has(id)) dfs(id);
    // A labelled edge spans at least two ranks: its label sits in a rank of its own between
    // the ends (Graphviz's approach), as a dummy with a size.
    const hasLabel = (e) => e.label !== undefined && e.label !== null && String(e.label) !== "";
    const dag = edges.map((e, i) => ({ ...(reversed.has(i) ? { u: e.to, v: e.from } : { u: e.from, v: e.to }),
                                       len: hasLabel(e) ? 2 : 1 }));

    // Longest-path ranking.
    const preds = new Map([...nodes.keys()].map((id) => [id, []]));
    for (const { u, v, len } of dag) preds.get(v).push({ u, len });
    const rank = new Map();
    const visit = (id) => {
        if (!rank.has(id)) rank.set(id, preds.get(id).reduce((m, p) => Math.max(m, visit(p.u) + p.len), 0));
        return rank.get(id);
    };
    for (const id of nodes.keys()) nodes.get(id).rank = visit(id);

    // Long edges get one dummy per rank they cross, so every segment spans exactly one rank.
    const chains = [];
    let dummyCount = 0;
    dag.forEach(({ u, v }, i) => {
        const path = [u];
        const r0 = rank.get(u), r1 = rank.get(v);
        const labelRank = hasLabel(edges[i]) ? r0 + Math.floor((r1 - r0) / 2) : -1;
        for (let r = r0 + 1; r < r1; r++) {
            const id = `${dummyPrefix}${dummyCount++}`;
            nodes.set(id, r === labelRank
                ? { id, label: String(edges[i].label), src: edges[i], dummy: true, edgeLabel: true, rank: r }
                : { id, label: "", src: {}, dummy: true, rank: r });
            path.push(id);
        }
        path.push(v);
        chains.push({ edge: edges[i], path, reversed: reversed.has(i) });
    });

    // Edges joining the same two nodes (either way: a 2-cycle becomes two edges in the same
    // direction) would draw on top of each other; spread them sideways.
    const groups = new Map();
    for (const c of chains) {
        const key = `${c.path[0]}\u0000${c.path[c.path.length - 1]}`;
        (groups.get(key) ?? groups.set(key, []).get(key)).push(c);
    }
    for (const g of groups.values()) g.forEach((c, k) => { c.offset = (k - (g.length - 1) / 2) * 10; });

    const layers = [];
    for (const n of nodes.values()) (layers[n.rank] ??= []).push(n.id);
    for (let r = 0; r < layers.length; r++) layers[r] ??= [];
    orderLayers(layers, chains);
    return { layers, nodes, chains, dropped };
}

/** Crossing reduction: barycenter sweeps down and up, keeping the best order seen. */
function orderLayers(layers, chains) {
    const up = new Map(), down = new Map();
    for (const { path } of chains) {
        for (let k = 0; k + 1 < path.length; k++) {
            (down.get(path[k]) ?? down.set(path[k], []).get(path[k])).push(path[k + 1]);
            (up.get(path[k + 1]) ?? up.set(path[k + 1], []).get(path[k + 1])).push(path[k]);
        }
    }
    const pos = new Map();
    const reindex = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
    const crossings = () => {
        let c = 0;
        for (let r = 0; r + 1 < layers.length; r++) {
            const segs = [];
            for (const id of layers[r]) for (const t of down.get(id) ?? []) segs.push([pos.get(id), pos.get(t)]);
            for (let i = 0; i < segs.length; i++) {
                for (let j = i + 1; j < segs.length; j++) {
                    const [a, b] = segs[i], [c2, d] = segs[j];
                    if ((a - c2) * (b - d) < 0) c++;
                }
            }
        }
        return c;
    };
    reindex();
    let best = layers.map((l) => [...l]), bestC = crossings();
    for (let it = 0; it < 12 && bestC > 0; it++) {
        const goingDown = it % 2 === 0;
        const ranks = goingDown ? [...layers.keys()].slice(1) : [...layers.keys()].slice(0, -1).reverse();
        for (const r of ranks) {
            const bc = (id) => {
                const ns = (goingDown ? up : down).get(id) ?? [];
                return ns.length ? ns.reduce((s, n) => s + pos.get(n), 0) / ns.length : pos.get(id);
            };
            const keyed = layers[r].map((id) => [bc(id), pos.get(id), id]);
            keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            layers[r] = keyed.map((k) => k[2]);
            reindex();
        }
        const c = crossings();
        if (c < bestC) { bestC = c; best = layers.map((l) => [...l]); }
    }
    best.forEach((l, r) => { layers[r] = l; });
}

/**
 * Coordinates for the static canvas (TB): each node's centre x, and each rank's top and
 * height. Nodes are pulled toward the mean x of their neighbours in alternating sweeps;
 * within a rank the order and the minimum gaps are kept by isotonic regression (PAV), so each
 * sweep gives the closest legal placement to what the neighbours want.
 *
 * @param size (id) => {w, h} for real nodes and edge labels (other dummies are dummyW wide);
 *             w is the extent across the ranks, h along them
 */
export function coordinates(L, size, { nodeSep = 28, rankSep = 64, dummyW = 6 } = {}) {
    const { layers, nodes, chains } = L;
    const dim = new Map();
    for (const n of nodes.values()) dim.set(n.id, n.dummy && !n.edgeLabel ? { w: dummyW, h: 0 } : size(n.id));
    const up = new Map(), down = new Map();
    for (const { path } of chains) {
        for (let k = 0; k + 1 < path.length; k++) {
            (down.get(path[k]) ?? down.set(path[k], []).get(path[k])).push(path[k + 1]);
            (up.get(path[k + 1]) ?? up.set(path[k + 1], []).get(path[k + 1])).push(path[k]);
        }
    }
    const x = new Map();
    const gap = (a, b) => (dim.get(a).w + dim.get(b).w) / 2 + nodeSep;
    const place = (layer, want) => {
        // x_i >= x_{i-1} + gap_i. With off_i the summed gaps, y_i = x_i - off_i is nondecreasing:
        // fit y to (want_i - off_i) by pool-adjacent-violators.
        const off = [0];
        for (let i = 1; i < layer.length; i++) off.push(off[i - 1] + gap(layer[i - 1], layer[i]));
        const blocks = [];
        layer.forEach((id, i) => {
            blocks.push({ sum: want[i] - off[i], n: 1 });
            while (blocks.length > 1) {
                const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
                if (a.sum / a.n <= b.sum / b.n) break;
                blocks.pop(); a.sum += b.sum; a.n += b.n;
            }
        });
        let i = 0;
        for (const b of blocks) for (let k = 0; k < b.n; k++, i++) x.set(layer[i], b.sum / b.n + off[i]);
    };
    for (const l of layers) place(l, l.map(() => 0));
    for (let it = 0; it < 16; it++) {
        const goingDown = it % 2 === 0;
        const ranks = goingDown ? [...layers.keys()] : [...layers.keys()].reverse();
        for (const r of ranks) {
            const want = layers[r].map((id) => {
                const ns = [...((goingDown ? up : down).get(id) ?? []), ...(it > 8 ? ((goingDown ? down : up).get(id) ?? []) : [])];
                return ns.length ? ns.reduce((s, n) => s + x.get(n), 0) / ns.length : x.get(id);
            });
            place(layers[r], want);
        }
    }
    const rankTop = [], rankH = [];
    let y = 0;
    for (const l of layers) {
        const h = Math.max(0, ...l.map((id) => dim.get(id).h));
        rankTop.push(y); rankH.push(h);
        y += h + rankSep;
    }
    let minX = Infinity, maxX = -Infinity;
    for (const [id, cx] of x) { minX = Math.min(minX, cx - dim.get(id).w / 2); maxX = Math.max(maxX, cx + dim.get(id).w / 2); }
    for (const [id, cx] of x) x.set(id, cx - minX);
    return { x, dim, rankTop, rankH, width: maxX - minX, height: y - rankSep };
}
