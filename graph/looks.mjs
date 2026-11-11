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
    button: "#E61E293B", buttonFg: "#FFE2E8F0",
};

const rect = { left: "{{left}}", top: "{{top}}", right: "{{right}}", bottom: "{{bottom}}" };
const centredLabel = (size, weight) => [
    { paint: { ops: [{ color: "{{text}}" }, { style: "fill" }, { textSize: size }] } },
    { drawTextAnchored: { text: "{{label}}", x: "{{cx}}", y: "{{cy}}", panX: 0, panY: 0 } },
];

/** A rounded box with a hairline border, the label centred; the shared shape of the built-ins. */
function boxLook(radius, { fill, border, text, borderWidth = 1, weight = 500 }) {
    const r = radius === "pill" ? 100 : radius;
    const cr = radius === "pill" ? "{{radius}}" : radius;
    return {
        defaults: { color: fill, border, text },
        fontSize: 15, padding: radius === "pill" ? [20, 10] : [16, 10],
        layout: { box: {
            horizontalAlignment: "center", verticalAlignment: "center",
            modifiers: [{ clip: r }, { background: "{{color}}" },
                        { border: { width: borderWidth, color: "{{border}}", cornerRadius: r, shape: 2 } },
                        { padding: radius === "pill" ? [20, 10] : [16, 10] }],
            children: [{ text: { value: "{{label}}", fontSize: 15, color: "{{text}}",
                                 ...(weight !== 400 ? { fontWeight: weight } : {}) } }],
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

export const BUILTIN_LOOKS = {
    card: boxLook(10, { fill: THEME.surface, border: THEME.outline, text: THEME.text }),
    pill: boxLook("pill", { fill: THEME.surface, border: THEME.outline, text: THEME.text }),
    outline: boxLook(10, { fill: THEME.bg, border: THEME.accent, text: THEME.accent, borderWidth: 1.5 }),
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

/** The look a node uses, and the values its placeholders see. */
export function lookFor(graph, node) {
    const name = node.src.look ?? graph.style?.look ?? "card";
    const look = graph.looks?.[name] ?? BUILTIN_LOOKS[name];
    if (!look) throw new Error(`node ${node.id}: unknown look "${name}"`);
    const vars = { ...(look.defaults ?? {}), ...node.src, label: node.label, id: node.id, data: node.src.data ?? {} };
    return { name, look, vars };
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
