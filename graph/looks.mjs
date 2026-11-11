// looks.mjs — how nodes draw themselves.
//
// A look is plain JSON, so a graph can bring its own next to the built-in ones:
//
//   "looks": {
//     "status": {
//       "defaults": {"color": "#FF1E293B", "dot": "#FF22C55E"},  values placeholders fall back to
//       "fontSize": 15, "padding": [16, 10],                        auto size: label + padding
//       "size": [180, 52],                                          or a fixed size ("auto" per axis)
//       "layout": { ...one RemoteCompose component... },            reflow mode
//       "canvas": { "commands": [...], "label": [...] }             canvas mode
//     }
//   },
//   "style": {"look": "status"},                                    the graph's default look
//   "nodes": [{"id": "a", "label": "Build", "look": "pill", "data": {"sub": "2 min"}}]
//
// Placeholders: "{{name}}" anywhere in a string. A string that is exactly one placeholder takes
// the value's own type (a number stays a number). Names are the node's fields (id, label,
// color, ...), "data.<key>", and the look's defaults; canvas mode adds the node's box: left,
// top, right, bottom, cx, cy, w, h and radius (h / 2). A name with no value is an error.
//
// `layout` is laid out by the engine (reflow mode), so it can be anything a document can hold.
// `canvas.commands` draw the node in canvas mode; `canvas.label` draws its text, kept apart so
// it can be dropped when zoomed out too far to read.

export const THEME = {
    bg: "#FF0B1120", edge: "#FF64748B", text: "#FFE2E8F0", muted: "#FF94A3B8",
    surface: "#FF1E293B", outline: "#FF334155", accent: "#FF60A5FA",
    button: "#E61E293B", buttonFg: "#FFE2E8F0", group: "#99131C2E", header: "#FF334155",
};

/**
 * The colours a graph draws with: THEME, with the graph's own "theme" over it (any colour
 * value the document understands: "#AARRGGBB", or a named colour such as "@colors.surface").
 * Looks read them as {{theme.<name>}}.
 */
export const themeOf = (graph) => ({ ...THEME, ...(graph?.theme ?? {}) });

const rect = { left: "{{left}}", top: "{{top}}", right: "{{right}}", bottom: "{{bottom}}" };
const centredLabel = (size, weight) => [
    { paint: { ops: [{ color: "{{text}}" }, { style: "fill" }, { textSize: size }] } },
    { drawTextAnchored: { text: "{{label}}", x: "{{cx}}", y: "{{cy}}", panX: 0, panY: 0 } },
];

/**
 * A rounded box with a hairline border, the label centred; the shared shape of the built-ins.
 * In reflow mode the border is the outer box's background showing around the inner one (a
 * border modifier's colour is a literal for the Java parser: no named theme colour).
 */
function boxLook(radius, { fill, border, text, borderWidth = 1, weight = 500 }) {
    const r = radius === "pill" ? 100 : radius;
    const cr = radius === "pill" ? "{{radius}}" : radius;
    const pad = radius === "pill" ? [20, 10] : [16, 10];
    return {
        defaults: { color: fill, border, text },
        fontSize: 15, padding: pad,
        layout: { box: {
            modifiers: [{ clip: r }, { background: "{{border}}" }, { padding: borderWidth }],
            children: [{ box: {
                horizontalAlignment: "center", verticalAlignment: "center",
                modifiers: [{ clip: radius === "pill" ? 100 : r - borderWidth }, { background: "{{color}}" },
                            { padding: pad.map((p) => p - borderWidth) }],
                children: [{ text: { value: "{{label}}", fontSize: 15, color: "{{text}}",
                                     ...(weight !== 400 ? { fontWeight: weight } : {}) } }],
            } }],
        } },
        canvas: {
            commands: [
                { paint: { ops: [{ color: "{{color}}" }, { style: "fill" }] } },
                { drawRoundRect: { ...rect, rx: cr, ry: cr } },
                { paint: { ops: [{ color: "{{border}}" }, { style: "stroke" }, { width: borderWidth }] } },
                { drawRoundRect: { ...rect, rx: cr, ry: cr } },
            ],
            label: centredLabel(15, weight),
        },
    };
}

/**
 * A group's card: its title, then its sub-layout. A group look is a node look with a
 * "{{content}}" slot in its layout (reflow mode: the group's own ranks go there) and `title`,
 * the height its canvas drawing keeps above the content (canvas mode puts the content at
 * padding + title, and sizes the card from the content plus padding and title).
 */
const groupLook = {
    defaults: { color: "{{theme.group}}", border: "{{theme.outline}}", text: "{{theme.muted}}" },
    fontSize: 12, padding: [14, 10], title: 24,
    layout: { box: {
        modifiers: [{ clip: 14 }, { background: "{{border}}" }, { padding: 1 }],
        children: [{ box: {
            modifiers: [{ clip: 13 }, { background: "{{color}}" }, { padding: [13, 9] }],
            children: [{ column: {
                horizontalAlignment: "start", modifiers: [{ spacedBy: 10 }],
                children: [{ text: { value: "{{label}}", fontSize: 12, fontWeight: 600, color: "{{text}}" } }, "{{content}}"],
            } }],
        } }],
    } },
    canvas: {
        commands: [
            { paint: { ops: [{ color: "{{color}}" }, { style: "fill" }] } },
            { drawRoundRect: { ...rect, rx: 14, ry: 14 } },
            { paint: { ops: [{ color: "{{border}}" }, { style: "stroke" }, { width: 1 }] } },
            { drawRoundRect: { ...rect, rx: 14, ry: 14 } },
        ],
        label: [
            { paint: { ops: [{ color: "{{text}}" }, { style: "fill" }, { textSize: 12 }] } },
            { drawTextAnchored: { text: "{{label}}", x: "{{left}} + 14", y: "{{top}} + 17", panX: -1, panY: 0 } },
        ],
    },
};

export const BUILTIN_LOOKS = {
    card: boxLook(10, { fill: "{{theme.surface}}", border: "{{theme.outline}}", text: "{{theme.text}}" }),
    pill: boxLook("pill", { fill: "{{theme.surface}}", border: "{{theme.outline}}", text: "{{theme.text}}" }),
    outline: boxLook(10, { fill: "{{theme.bg}}", border: "{{theme.accent}}", text: "{{theme.accent}}", borderWidth: 1.5 }),
    group: groupLook,
    // An edge's label: small muted text on the background colour, sitting on the line.
    edgeLabel: {
        defaults: { bg: "{{theme.bg}}", text: "{{theme.muted}}" },
        fontSize: 12, padding: [6, 3],
        layout: { box: {
            modifiers: [{ clip: 6 }, { background: "{{bg}}" }, { padding: [6, 3] }],
            children: [{ text: { value: "{{label}}", fontSize: 12, color: "{{text}}" } }],
        } },
        canvas: {
            commands: [
                { paint: { ops: [{ color: "{{bg}}" }, { style: "fill" }] } },
                { drawRoundRect: { ...rect, rx: 6, ry: 6 } },
            ],
            label: [
                { paint: { ops: [{ color: "{{text}}" }, { style: "fill" }, { textSize: 12 }] } },
                { drawTextAnchored: { text: "{{label}}", x: "{{cx}}", y: "{{cy}}", panX: 0, panY: 0 } },
            ],
        },
    },
};

const WHOLE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Deep copy of `tpl` with every {{name}} replaced from `vars`. */
export function fill(tpl, vars, where) {
    const get = (name) => {
        const v = name.split(".").reduce((o, k) => (o == null ? undefined : o[k]), vars);
        if (v === undefined) throw new Error(`${where}: no value for {{${name}}}`);
        return v;
    };
    const walk = (x) => {
        if (typeof x === "string") {
            const m = WHOLE.exec(x);
            if (m) return get(m[1]);
            return x.replace(ANY, (_, name) => String(get(name)));
        }
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
        return x;
    };
    return walk(tpl);
}

/** A look's defaults, its {{theme.<name>}} placeholders filled from the graph's theme. */
const defaultsOf = (graph, look, where) => fill(look.defaults ?? {}, { theme: themeOf(graph) }, `${where}: the look's defaults`);

/** The look a node uses, and the values its placeholders see. */
export function lookFor(graph, node) {
    const name = node.src.look ?? graph.style?.look ?? "card";
    const look = graph.looks?.[name] ?? BUILTIN_LOOKS[name];
    if (!look) throw new Error(`node ${node.id}: unknown look "${name}"`);
    const vars = { ...defaultsOf(graph, look, `node ${node.id}`), ...node.src, label: node.label, id: node.id, data: node.src.data ?? {}, theme: themeOf(graph) };
    return { name, look, vars };
}

/** The look a group uses: its own "look", the graph's style.groupLook, or "group". */
export function lookForGroup(graph, group) {
    const name = group.src.look ?? graph.style?.groupLook ?? "group";
    const look = graph.looks?.[name] ?? BUILTIN_LOOKS[name];
    if (!look) throw new Error(`group ${group.id}: unknown look "${name}"`);
    const { nodes, groups, ...own } = group.src;
    const vars = { ...defaultsOf(graph, look, `group ${group.id}`), ...own, label: group.label, id: group.id, data: group.src.data ?? {}, theme: themeOf(graph) };
    return { name, look, vars };
}

/**
 * The look an edge label uses: the edge's "labelLook", the graph's style.edgeLabelLook, or
 * "edgeLabel". Its placeholders see the look's defaults, the edge's fields and {{label}}.
 */
export function lookForLabel(graph, node) {
    const edge = node.src;
    const name = edge.labelLook ?? graph.style?.edgeLabelLook ?? "edgeLabel";
    const look = graph.looks?.[name] ?? BUILTIN_LOOKS[name];
    if (!look) throw new Error(`edge ${edge.from}->${edge.to}: unknown label look "${name}"`);
    const vars = { ...defaultsOf(graph, look, `edge ${edge.from}->${edge.to}`), ...edge, label: node.label, data: edge.data ?? {}, theme: themeOf(graph) };
    return { name, look, vars };
}

/** A group's card size around content of `inner` {w, h}: padding, title, and the title's width. */
export function groupSize(look, label, inner, measure) {
    const [px, py] = look.padding ?? [14, 10];
    const title = look.title ?? 24;
    return {
        w: Math.ceil(Math.max(inner.w, measure(label, look.fontSize ?? 12)) + 2 * px),
        h: Math.ceil(inner.h + title + 2 * py),
    };
}

/**
 * A node's size for canvas mode and for the reflow orientation estimate: the look's fixed
 * size per axis, or "auto" -- the label at the look's font size plus its padding.
 */
export function lookSize(look, label, measure) {
    const fs = look.fontSize ?? 15;
    const [px, py] = look.padding ?? [16, 10];
    const [sw, sh] = look.size ?? ["auto", "auto"];
    return {
        w: Math.ceil(sw === "auto" ? measure(label, fs) + 2 * px : Number(sw)),
        h: Math.ceil(sh === "auto" ? fs * 1.25 + 2 * py : Number(sh)),
    };
}
