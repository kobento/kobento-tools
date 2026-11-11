// layered.mjs — the structural half of a layered (Sugiyama-style) graph layout, shared by
// both emitters: cycle breaking, ranking, long-edge dummies, crossing reduction, and (for the
// static canvas only) coordinate assignment.

import { fieldShare } from "./records.mjs";

/**
 * @param graph {nodes: [{id, label?, color?}], edges: [{from, to, color?}]}
 * @param dummyPrefix  ids of the dummies this call makes (unique across calls laying out
 *                     several graphs whose ids share one namespace, e.g. nested groups)
 * @returns {
 *   layers:  [[id]]                           ranks top to bottom, each in left-to-right order
 *   nodes:   Map<id, {id, label, src, dummy, edgeLabel?, rank}>
 *                                              src: the node's own JSON (an edge label: the edge's)
 *   chains:  [{edge, path: [id], reversed, offset, endPorts}]
 *                                              each edge as the node/dummy ids it passes through,
 *                                              from its upper end to its lower end; offset (px,
 *                                              across the edge) separates parallel edges; endPorts
 *                                              the record fields its two ends attach to, if any
 *   dropped: [edge]                            self-loops (compound.mjs takes them out first)
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
        // The record fields (records.mjs) its ends attach to, where an end is the node itself
        // here (not a group holding it): ordering and positions take them into account.
        const e = edges[i], rev = reversed.has(i);
        const real = rev ? [e.realTo ?? e.to, e.realFrom ?? e.from] : [e.realFrom ?? e.from, e.realTo ?? e.to];
        const ports = rev ? [e.realToPort, e.realFromPort] : [e.realFromPort, e.realToPort];
        const endPorts = [path[0], path[path.length - 1]].map((id, k) => (id === real[k] ? ports[k] : undefined));
        chains.push({ edge: e, path, reversed: rev, endPorts });
    });

    // Edges joining the same two nodes (either way: a 2-cycle becomes two edges in the same
    // direction) would draw on top of each other; spread them sideways.
    const groups = new Map();
    for (const c of chains) {
        const key = `${c.path[0]}\u0000${c.path[c.path.length - 1]}`;
        (groups.get(key) ?? groups.set(key, []).get(key)).push(c);
    }
    for (const g of groups.values()) g.forEach((c, k) => { c.offset = (k - (g.length - 1) / 2) * 16; });

    const layers = [];
    for (const n of nodes.values()) (layers[n.rank] ??= []).push(n.id);
    for (let r = 0; r < layers.length; r++) layers[r] ??= [];
    orderLayers(layers, chains, nodes);
    return { layers, nodes, chains, dropped };
}

/**
 * Each link of every chain from both its ends: Map<id, [{n, own, other}]> down (to the next
 * rank) and up, where own / other is what `at(chain, end)` gives at this end and the other
 * (end: 0 or 1 at the chain's ends, null between).
 */
function links(chains, at) {
    const up = new Map(), down = new Map();
    for (const chain of chains) {
        const { path } = chain, n = path.length;
        const v = (k) => at(chain, k === 0 ? 0 : k === n - 1 ? 1 : null);
        for (let k = 0; k + 1 < n; k++) {
            (down.get(path[k]) ?? down.set(path[k], []).get(path[k])).push({ n: path[k + 1], own: v(k), other: v(k + 1) });
            (up.get(path[k + 1]) ?? up.set(path[k + 1], []).get(path[k + 1])).push({ n: path[k], own: v(k + 1), other: v(k) });
        }
    }
    return { up, down };
}

/**
 * Crossing reduction: barycenter sweeps down and up, keeping the best order seen. An edge into
 * a record's field counts at that field's place across the record.
 */
function orderLayers(layers, chains, nodes) {
    const share = (chain, end) => {
        const f = end === null ? undefined : chain.endPorts?.[end];
        return f === undefined ? 0 : fieldShare(nodes.get(chain.path[end === 0 ? 0 : chain.path.length - 1]), f);
    };
    const { up, down } = links(chains, share);
    const pos = new Map();
    const reindex = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
    const crossings = () => {
        let c = 0;
        for (let r = 0; r + 1 < layers.length; r++) {
            const segs = [];
            for (const id of layers[r]) for (const t of down.get(id) ?? []) segs.push([pos.get(id) + t.own, pos.get(t.n) + t.other]);
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
                return ns.length ? ns.reduce((s, l) => s + pos.get(l.n) + l.other - l.own, 0) / ns.length : pos.get(id);
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
 * @param pad  optional (id) => [before, after]: room kept clear on either side across the ranks
 * @param portOffset  optional (id, field) => a record field's centre from the record's, across
 *                    the ranks
 */
export function coordinates(L, size, { nodeSep = 28, rankSep = 64, dummyW = 6, pad = null, portOffset = null } = {}) {
    // pad(id) -> [before, after]: room to keep clear beside an item, across the ranks.
    const padOf = (id) => (pad && pad(id)) || [0, 0];
    const { layers, nodes, chains } = L;
    const dim = new Map();
    for (const n of nodes.values()) dim.set(n.id, n.dummy && !n.edgeLabel ? { w: dummyW, h: 0 } : size(n.id));
    // An edge into a record's field pulls at the field, not the record's middle.
    const offset = (chain, end) => {
        const f = end === null || !portOffset ? undefined : chain.endPorts?.[end];
        return f === undefined ? 0 : portOffset(chain.path[end === 0 ? 0 : chain.path.length - 1], f);
    };
    const { up, down } = links(chains, offset);
    const x = new Map();
    const gap = (a, b) => (dim.get(a).w + dim.get(b).w) / 2 + nodeSep + padOf(a)[1] + padOf(b)[0];
    // The closest legal placement of a rank to the positions wanted, each weighted.
    const place = (layer, want, weight) => {
        // x_i >= x_{i-1} + gap_i. With off_i the summed gaps, y_i = x_i - off_i is nondecreasing:
        // fit y to (want_i - off_i), weighted, by pool-adjacent-violators.
        const off = [0];
        for (let i = 1; i < layer.length; i++) off.push(off[i - 1] + gap(layer[i - 1], layer[i]));
        const blocks = [];
        layer.forEach((id, i) => {
            const w = weight ? weight[i] : 1;
            blocks.push({ sw: w, swy: w * (want[i] - off[i]), n: 1 });
            while (blocks.length > 1) {
                const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
                if (a.swy / a.sw <= b.swy / b.sw) break;
                blocks.pop(); a.sw += b.sw; a.swy += b.swy; a.n += b.n;
            }
        });
        let i = 0;
        for (const b of blocks) for (let k = 0; k < b.n; k++, i++) x.set(layer[i], b.swy / b.sw + off[i]);
    };
    // Links between two dummies pull hardest, so long edges come out straight (Graphviz's
    // omega weights: 1 between real nodes, 2 with one dummy, 8 between dummies).
    const isDummy = (id) => nodes.get(id).dummy;
    const omega = (a, b) => (isDummy(a) && isDummy(b) ? 8 : isDummy(a) || isDummy(b) ? 2 : 1);
    for (const l of layers) place(l, l.map(() => 0));
    for (let it = 0; it < 16; it++) {
        const goingDown = it % 2 === 0;
        const ranks = goingDown ? [...layers.keys()] : [...layers.keys()].reverse();
        for (const r of ranks) {
            const want = [], weight = [];
            for (const id of layers[r]) {
                const ns = [...((goingDown ? up : down).get(id) ?? []), ...(it > 8 ? ((goingDown ? down : up).get(id) ?? []) : [])];
                let sw = 0, swx = 0;
                for (const l of ns) { const w = omega(id, l.n); sw += w; swx += w * (x.get(l.n) + l.other - l.own); }
                want.push(sw ? swx / sw : x.get(id));
                weight.push(Math.max(1, sw));
            }
            place(layers[r], want, weight);
        }
    }
    // Then line up each long edge: its dummies (two or more) are pulled to one position, as far
    // as the ranks' order and gaps allow. It starts at the median of where they are; when a rank
    // cannot let one of them get there, the run moves to where that one could go instead (the
    // dummy farthest from the target), so it stays straight rather than jog around the crowded
    // rank. A run that still has to bend is straight wherever it can be.
    const runs = chains.map(({ path }) => path.slice(1, -1)).filter((d) => d.length >= 2);
    const runOf = new Map();
    runs.forEach((d, i) => d.forEach((id) => runOf.set(id, i)));
    const target = runs.map((d) => {
        const xs = d.map((id) => x.get(id)).sort((a, b) => a - b);
        return xs[Math.floor(xs.length / 2)];
    });
    for (let it = 0; it < 10 && runs.length; it++) {
        if (it > 0) {
            let moved = false;
            runs.forEach((d, i) => {
                let far = target[i], dev = 0.5;
                for (const id of d) if (Math.abs(x.get(id) - target[i]) > dev) { dev = Math.abs(x.get(id) - target[i]); far = x.get(id); }
                if (far !== target[i]) { target[i] = far; moved = true; }
            });
            if (!moved) break;
        }
        for (const l of layers) {
            if (!l.some((id) => runOf.has(id))) continue;
            place(l, l.map((id) => (runOf.has(id) ? target[runOf.get(id)] : x.get(id))),
                     l.map((id) => (runOf.has(id) ? 50 : 1)));
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
    for (const [id, cx] of x) {
        minX = Math.min(minX, cx - dim.get(id).w / 2 - padOf(id)[0]);
        maxX = Math.max(maxX, cx + dim.get(id).w / 2 + padOf(id)[1]);
    }
    for (const [id, cx] of x) x.set(id, cx - minX);
    return { x, dim, rankTop, rankH, width: maxX - minX, height: y - rankSep };
}
