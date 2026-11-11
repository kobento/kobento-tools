// compound.mjs — groups (sub-graphs) as compound nodes.
//
//   "groups": [{"id": "front", "label": "Front end", "nodes": ["lex", "parse"],
//               "groups": [{"id": "...", ...}],                  nested, or
//               "parent": "outer", "look": "group", "color": ...}],
//   "nodes": [{"id": "ast", "group": "front"}, ...]                or the node names its group
//   "edges": [{"from": "lex", "to": "ir", "lhead": "middle"}]      drawn to the group's border
//
// Each group is laid out as its own layered graph and drawn as one node of its parent's: a
// card holding its sub-layout. In reflow mode that card is a real container, so a group
// reflows like any node. An edge is laid out at the deepest group holding both its ends,
// between the children of that group that contain them, then drawn to the real nodes; an end
// can also be a group itself. Groups do not share ranks with the outside (Graphviz's clusters
// do): the whole group sits in one rank of its parent.

import { layered } from "./layered.mjs";
import { hasField } from "./records.mjs";

export const ROOT = "";

/**
 * @returns {
 *   levels: Map<groupId, L>     layered() of each group's children ("" is the top level);
 *                                chain.edge is the level edge: {from, to, realFrom, realTo,
 *                                realFromPort, realToPort (a record's field, records.mjs), color}
 *   items:  Map<id, {kind: "node" | "group" | "dummy" | "label", src, level}>   (label: an edge label)
 *   groups: Map<groupId, {id, label, src, parent, children: [id]}>
 *   dropped: [edge]              edges between a group and something inside it
 *   loops:   [edge]              self-loops (loops.mjs draws them)
 * }
 */
export function compound(graph) {
    const groups = new Map([[ROOT, { id: ROOT, label: "", src: {}, parent: null, children: [] }]]);
    const items = new Map();
    const parentOf = new Map();

    const addGroup = (g, parent) => {
        if (!g || g.id === undefined) throw new Error("a group needs an id");
        if (groups.has(g.id) || g.id === ROOT) throw new Error(`duplicate group ${g.id}`);
        groups.set(g.id, { id: g.id, label: String(g.label ?? g.id), src: g, parent: null, children: [] });
        if (parent !== undefined) parentOf.set(g.id, parent);
        else if (g.parent !== undefined) parentOf.set(g.id, g.parent);
        for (const sub of g.groups ?? []) addGroup(sub, g.id);
        for (const n of g.nodes ?? []) parentOf.set(n, g.id);
    };
    for (const g of graph.groups ?? []) addGroup(g);

    for (const n of graph.nodes ?? []) {
        if (items.has(n.id) || groups.has(n.id)) throw new Error(`duplicate id ${n.id}`);
        items.set(n.id, { kind: "node", src: n });
        if (n.group !== undefined) parentOf.set(n.id, n.group);
    }
    for (const g of groups.values()) if (g.id !== ROOT) items.set(g.id, { kind: "group", src: g.src });

    for (const id of items.keys()) {
        const p = parentOf.get(id) ?? ROOT;
        if (!groups.has(p)) throw new Error(`${id}: unknown group ${p}`);
        groups.get(p).children.push(id);
        if (groups.has(id)) groups.get(id).parent = p;
        items.get(id).level = p;
    }
    for (const id of parentOf.keys()) if (!items.has(id)) throw new Error(`group member ${id} is not a node`);
    // A group inside itself would loop forever below.
    for (const g of groups.values()) {
        const seen = new Set();
        for (let p = g.id; p !== null; p = groups.get(p).parent) {
            if (seen.has(p)) throw new Error(`group ${g.id} is inside itself`);
            seen.add(p);
        }
    }

    // Each edge at the deepest group holding both ends, between that group's children.
    const chainUp = (id) => {
        const up = [id];
        for (let p = items.get(id).level; p !== null; p = groups.get(p).parent) up.push(p);
        return up;   // id, its group, ..., ROOT
    };
    const levelEdges = new Map([...groups.keys()].map((g) => [g, []]));
    const dropped = [], loops = [];
    // An end can name a record's field: "node:field" (when that is not itself an id), or fromPort
    // / toPort.
    const endOf = (e, key) => {
        let id = e[key], port = e[`${key}Port`];
        if (!items.has(id) && typeof id === "string" && id.includes(":")) {
            const at = id.lastIndexOf(":");
            if (items.has(id.slice(0, at))) [id, port] = [id.slice(0, at), id.slice(at + 1)];
        }
        if (port !== undefined && port !== null) {
            if (!items.has(id) || !hasField(items.get(id).src, port)) throw new Error(`edge ${e.from}->${e.to}: ${id} has no field "${port}"`);
            port = String(port);
        } else port = undefined;
        return [id, port];
    };
    for (const raw of graph.edges ?? []) {
        const [from, fromPort] = endOf(raw, "from"), [to, toPort] = endOf(raw, "to");
        const e = { ...raw, from, to };
        if (!items.has(e.from) || !items.has(e.to)) throw new Error(`edge ${e.from}->${e.to}: unknown node or group`);
        if (e.from === e.to) { loops.push(e); continue; }                            // loops.mjs
        const a = chainUp(e.from), b = chainUp(e.to);
        if (a.includes(e.to) || b.includes(e.from)) { dropped.push(e); continue; }   // group <-> its own member
        const inB = new Set(b);
        const lca = a.find((x) => inB.has(x) && groups.has(x) && x !== e.from && x !== e.to);
        const cu = a[a.indexOf(lca) - 1], cv = b[b.indexOf(lca) - 1];
        // lhead / ltail (Graphviz's): laid out to the node, drawn to the border of a group
        // holding it (and not the other end).
        const clip = (end, g, up, other, key) => {
            if (g === undefined || g === null) return end;
            if (!groups.has(g) || !up.includes(g)) throw new Error(`edge ${e.from}->${e.to}: ${key} "${g}" is not a group holding ${end}`);
            if (other.includes(g)) throw new Error(`edge ${e.from}->${e.to}: ${key} "${g}" holds both ends`);
            return g;
        };
        const realFrom = clip(e.from, e.ltail, a, b, "ltail"), realTo = clip(e.to, e.lhead, b, a, "lhead");
        levelEdges.get(lca).push({ ...e, from: cu, to: cv, realFrom, realTo,
                                   realFromPort: realFrom === e.from ? fromPort : undefined,
                                   realToPort: realTo === e.to ? toPort : undefined });
    }

    const levels = new Map();
    let n = 0;
    for (const g of groups.values()) {
        const nodes = g.children.map((id) => {
            const it = items.get(id);
            return it.kind === "group" ? { id, label: groups.get(id).label } : it.src;
        });
        const L = layered({ nodes, edges: levelEdges.get(g.id) }, { dummyPrefix: `__g${n++}d` });
        dropped.push(...L.dropped);
        levels.set(g.id, L);
        for (const [id, node] of L.nodes) {
            if (node.dummy) items.set(id, { kind: node.edgeLabel ? "label" : "dummy", src: node.src, level: g.id });
        }
    }
    return { levels, items, groups, dropped, loops };
}

/** A chain's real ends, in path order (a reversed chain runs from the edge's target). */
export function chainEnds({ edge, reversed }) {
    return reversed ? [edge.realTo, edge.realFrom] : [edge.realFrom, edge.realTo];
}

/** The fields (records.mjs) a chain's real ends attach to, in path order; undefined: none. */
export function chainPorts({ edge, reversed }) {
    return reversed ? [edge.realToPort, edge.realFromPort] : [edge.realFromPort, edge.realToPort];
}
