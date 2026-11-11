// The fixed layout (canvas mode's, and the one reflow mode's choices come from), checked for
// every example and fixture in every direction:
//   - nothing overlaps: siblings keep apart, a group holds its insides
//   - long edges are straight through their middle
//   - edges keep out of nodes and labels they do not end at
//   - edges running side by side keep a gap
//   - self-loops and their labels keep clear of everything else
//
//   node --test graph/test

import { test } from "node:test";
import assert from "node:assert/strict";
import { graphs } from "./harness.mjs";
import { compound, chainPorts, ROOT } from "../compound.mjs";
import { layout } from "../geometry.mjs";
import { route } from "../routes.mjs";
import { loopRoute, loopLabels } from "../loops.mjs";
import { measureLabel } from "../graph2rc.mjs";
import { edgeStyle, markerLength } from "../edges.mjs";

const DIRS = ["TB", "BT", "LR", "RL"];
const MIN_RUN_GAP = 6;   // between two edges running side by side
const MIN_PORT_GAP = 4;  // between two edges' ends on one node

/** The layout, and every edge (and loop) as points sampled along it, in screen coordinates. */
function laidOut(graph, dir) {
    const T = compound(graph);
    const laid = layout(graph, T, measureLabel, dir);
    const { G, chains, room, loops } = laid;
    const xy = (p) => (G.tb ? [p.c, p.f] : [p.f, p.c]);
    const edges = [];
    for (const chain of chains) {
        const st = edgeStyle(graph, chain.edge);
        const [first, last] = chain.reversed ? [st.head, st.tail] : [st.tail, st.head];
        const P = {
            add: (v, k) => v + k, fs: G.fs, crossOf: (id) => G.crossOf(id), port: (id, p, f) => G.port(id, p, f),
            band: (id) => { const g = G.band(id); return { f0: g.f0, f1: g.f1, c: g.c + chain.offset }; },
        };
        const { pts, segs, ends } = route(T, chain, P, [markerLength(first), markerLength(last)], room.get(chain.key));
        const samples = [], runs = [];
        segs.forEach((kind, k) => {
            const p = pts[k], q = pts[k + 1];
            if (kind === "skip") return;
            if (kind === "line") {
                if (Math.abs(p.c - q.c) < 0.01) runs.push({ c: p.c, f0: Math.min(p.f, q.f), f1: Math.max(p.f, q.f) });
                for (let i = 0; i <= 8; i++) samples.push(xy({ f: p.f + ((q.f - p.f) * i) / 8, c: p.c + ((q.c - p.c) * i) / 8 }));
                return;
            }
            const mf = (p.f + q.f) / 2;
            const ctl = [p, { f: mf, c: p.c }, { f: mf, c: q.c }, q];
            for (let i = 0; i <= 16; i++) samples.push(xy(bezier(ctl, i / 16)));
        });
        const [e0, e1] = chain.reversed ? [chain.edge.realTo, chain.edge.realFrom] : [chain.edge.realFrom, chain.edge.realTo];
        const fields = chainPorts(chain);
        edges.push({ chain, samples, runs, name: `${chain.edge.realFrom}->${chain.edge.realTo}`,
                     ends: [{ id: e0, at: xy(ends[0]), field: fields[0], f: ends[0] }, { id: e1, at: xy(ends[1]), field: fields[1], f: ends[1] }] });
    }
    const loopPaths = [], loopBoxes = [];
    const P = { add: (v, k) => v + k, fs: G.fs, port: (id, p) => G.port(id, p) };
    for (const [id, list] of loops) {
        for (const loop of list) {
            const { pts } = loopRoute(graph, id, loop, P);
            const samples = [];
            for (let i = 0; i <= 16; i++) samples.push(xy(bezier(pts, i / 16)));
            loopPaths.push({ id, samples });
        }
        for (const { loop, f, c } of loopLabels(id, list, P, G.tb)) {
            const [cx, cy] = xy({ f, c }), { w, h } = loop.label;
            loopBoxes.push({ id, box: { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 } });
        }
    }
    return { T, G, edges, loopPaths, loopBoxes };
}

function bezier([a, b, c, d], t) {
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return { f: k[0] * a.f + k[1] * b.f + k[2] * c.f + k[3] * d.f, c: k[0] * a.c + k[1] * b.c + k[2] * c.c + k[3] * d.c };
}

const overlap = (a, b, gap = 0) =>
    a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
const inside = ([x, y], b, inset) => x > b.left + inset && x < b.right - inset && y > b.top + inset && y < b.bottom - inset;
const show = (b) => `[${[b.left, b.top, b.right, b.bottom].map((v) => v.toFixed(1)).join(", ")}]`;

for (const { name, graph } of graphs()) {
    for (const dir of DIRS) {
        test(`${name} ${dir}`, async (t) => {
            const { T, G, edges, loopPaths, loopBoxes } = laidOut(graph, dir);
            const boxed = (id) => "left" in G.geo.get(id);

            await t.test("siblings do not overlap", () => {
                for (const [gid, L] of T.levels) {
                    const ids = [...L.nodes.keys()].filter(boxed);
                    for (let i = 0; i < ids.length; i++) {
                        for (let j = i + 1; j < ids.length; j++) {
                            const a = G.geo.get(ids[i]), b = G.geo.get(ids[j]);
                            assert.ok(!overlap(a, b), `${ids[i]} ${show(a)} overlaps ${ids[j]} ${show(b)} (in ${gid || "the graph"})`);
                        }
                    }
                }
            });

            await t.test("groups hold their insides", () => {
                for (const [gid, L] of T.levels) {
                    if (gid === ROOT) continue;
                    const g = G.geo.get(gid);
                    for (const id of L.nodes.keys()) {
                        const b = G.geo.get(id);
                        const box = boxed(id) ? b : (G.tb ? { left: b.c, right: b.c, top: Math.min(b.f0, b.f1), bottom: Math.max(b.f0, b.f1) }
                                                         : { left: Math.min(b.f0, b.f1), right: Math.max(b.f0, b.f1), top: b.c, bottom: b.c });
                        assert.ok(box.left >= g.left - 0.5 && box.right <= g.right + 0.5 && box.top >= g.top - 0.5 && box.bottom <= g.bottom + 0.5,
                                  `${id} ${show(box)} is outside its group ${gid} ${show(g)}`);
                    }
                }
            });

            await t.test("long edges are straight", () => {
                for (const { chain, name: e } of edges) {
                    const mids = chain.path.slice(1, -1);
                    if (mids.length < 2) continue;
                    const cs = mids.map((id) => G.crossOf(id));
                    assert.ok(Math.max(...cs) - Math.min(...cs) < 0.5, `${e} bends through its middle: ${cs.map((c) => c.toFixed(1)).join(", ")}`);
                }
            });

            await t.test("edges keep out of nodes and labels", () => {
                const obstacles = [...T.items].filter(([id, it]) => it.kind === "node" || it.kind === "label").map(([id]) => id);
                for (const { chain, samples, name: e } of edges) {
                    const own = new Set([chain.edge.realFrom, chain.edge.realTo, ...chain.path]);
                    for (const id of obstacles) {
                        if (own.has(id)) continue;
                        const b = G.geo.get(id), hit = samples.find((p) => inside(p, b, 2));
                        assert.ok(!hit, `${e} runs through ${id} ${show(b)} at (${hit?.map((v) => v.toFixed(1))})`);
                    }
                }
            });

            await t.test("edges side by side keep a gap", () => {
                for (let i = 0; i < edges.length; i++) {
                    for (let j = i + 1; j < edges.length; j++) {
                        for (const r of edges[i].runs) {
                            for (const s of edges[j].runs) {
                                const shared = Math.min(r.f1, s.f1) - Math.max(r.f0, s.f0);
                                if (shared <= 2) continue;
                                assert.ok(Math.abs(r.c - s.c) >= MIN_RUN_GAP,
                                          `${edges[i].name} and ${edges[j].name} run ${Math.abs(r.c - s.c).toFixed(1)}px apart for ${shared.toFixed(0)}px`);
                            }
                        }
                    }
                }
            });

            await t.test("edges on one node attach apart", () => {
                const at = new Map();
                for (const e of edges) for (const end of e.ends) (at.get(end.id) ?? at.set(end.id, []).get(end.id)).push({ e, end });
                for (const [id, list] of at) {
                    for (let i = 0; i < list.length; i++) {
                        for (let j = i + 1; j < list.length; j++) {
                            const [a, b] = [list[i].end.at, list[j].end.at];
                            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
                            assert.ok(d >= MIN_PORT_GAP, `${list[i].e.name} and ${list[j].e.name} attach to ${id} ${d.toFixed(1)}px apart`);
                        }
                    }
                }
            });

            await t.test("an edge naming a record's field attaches to it", () => {
                for (const { ends, name: e } of edges) {
                    for (const end of ends) {
                        if (end.field === undefined) continue;
                        const b = G.geo.get(end.id), { off, ext } = G.records.get(end.id).ports.get(end.field);
                        const mid = (G.tb ? b.cx : b.cy) + off;
                        assert.ok(Math.abs(end.f.c - mid) <= ext / 2, `${e} attaches ${(end.f.c - mid).toFixed(1)}px off ${end.id}:${end.field} (${ext}px)`);
                    }
                }
            });

            await t.test("self-loops keep clear", () => {
                const others = [...T.items].filter(([, it]) => it.kind === "node" || it.kind === "label").map(([id]) => id);
                for (const { id, samples } of loopPaths) {
                    for (const o of others) {
                        if (o === id) continue;
                        const b = G.geo.get(o), hit = samples.find((p) => inside(p, b, 0));
                        assert.ok(!hit, `the loop on ${id} runs through ${o} ${show(b)}`);
                    }
                }
                for (const { id, box } of loopBoxes) {
                    for (const o of others) {
                        assert.ok(!overlap(box, G.geo.get(o)), `the loop label on ${id} ${show(box)} overlaps ${o} ${show(G.geo.get(o))}`);
                    }
                    for (const { samples, name: e } of edges) {
                        assert.ok(!samples.some((p) => inside(p, box, 1)), `${e} runs through the loop label on ${id}`);
                    }
                }
            });
        });
    }
}
