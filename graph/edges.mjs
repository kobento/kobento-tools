// edges.mjs — how an edge is stroked and how its ends are marked.
//
//   {"from": "a", "to": "b",
//    "label": "yes",                          drawn with the "edgeLabel" look (looks.mjs)
//    "color": "#FF64748B", "width": 1.75,
//    "style": "solid" | "dashed" | "dotted",
//    "arrowhead": "normal" | "open" | "diamond" | "dot" | "none",    at "to"
//    "arrowtail": ...same...,                                          at "from" (default none)
//    "dir": "forward" | "back" | "both" | "none"}                    Graphviz's shorthand
//
// Defaults come from the graph's "style": {"edge": {...}}, and "directed": false makes edges
// default to no arrowheads. An explicit arrowhead / arrowtail wins over dir.

import { THEME } from "./looks.mjs";

/** Marker shapes: points in (along, across), tip at the origin, the body behind it. */
const MARKERS = {
    normal: { len: 9, fill: true, pts: [[0, 0], [-9, -4.5], [-9, 4.5]] },
    open: { len: 1, fill: false, pts: [[-9, -4.5], [0, 0], [-9, 4.5]] },
    diamond: { len: 12, fill: true, pts: [[0, 0], [-6, -4], [-12, 0], [-6, 4]] },
    dot: { len: 8, fill: true, circle: { at: -4, r: 4 } },
    none: { len: 0 },
};

/** The resolved stroke and ends of an edge. */
export function edgeStyle(graph, edge) {
    const d = { ...(graph.style?.edge ?? {}), ...stripUndefined(edge) };
    const directed = graph.directed !== false;
    const dir = d.dir ?? (directed ? "forward" : "none");
    let head = dir === "forward" || dir === "both" ? "normal" : "none";
    let tail = dir === "back" || dir === "both" ? "normal" : "none";
    if (d.arrowhead !== undefined) head = d.arrowhead;
    if (d.arrowtail !== undefined) tail = d.arrowtail;
    for (const m of [head, tail]) if (!MARKERS[m]) throw new Error(`edge ${edge.from}->${edge.to}: unknown arrow "${m}"`);
    const width = Number(d.width ?? 1.75);
    const style = d.style ?? "solid";
    const dash = style === "dashed" ? [6, 4] : style === "dotted" ? [0.5, 3 + width] : style === "solid" ? null : undefined;
    if (dash === undefined) throw new Error(`edge ${edge.from}->${edge.to}: unknown style "${style}"`);
    return { color: d.color ?? THEME.edge, width, dash, head, tail };
}
const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** How far the line stops short of a port for this marker. */
export const markerLength = (kind) => MARKERS[kind].len;

/** The stroke paint for the line. */
export const strokePaint = (s) => ({ paint: { ops: [
    { color: s.color }, { style: "stroke" }, { width: s.width }, { strokeCap: "round" },
    { pathEffect: s.dash },
] } });

/**
 * Commands drawing a marker at the origin (the caller translates to the tip), pointing along
 * the unit vector `u` (screen); `v` is the perpendicular.
 */
export function markerCommands(kind, s, u) {
    const m = MARKERS[kind];
    if (kind === "none") return [];
    const v = [-u[1], u[0]];
    const at = ([a, c]) => [r2(a * u[0] + c * v[0]), r2(a * u[1] + c * v[1])];
    if (m.circle) {
        const [cx, cy] = at([m.circle.at, 0]);
        return [{ paint: { ops: [{ color: s.color }, { style: "fill" }, { pathEffect: null }] } },
                { drawCircle: { cx, cy, radius: m.circle.r } }];
    }
    const pts = m.pts.map(at);
    const d = `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")}${m.fill ? " Z" : ""}`;
    return [{ paint: { ops: m.fill
                ? [{ color: s.color }, { style: "fill" }, { pathEffect: null }]
                : [{ color: s.color }, { style: "stroke" }, { width: s.width }, { strokeCap: "round" },
                   { strokeJoin: "round" }, { pathEffect: null }] } },
            { drawPath: { path: d } }];
}
const r2 = (x) => Math.round(x * 100) / 100 + 0;
