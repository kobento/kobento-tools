// records.mjs — record nodes: a node with fields, each a port an edge can attach to (Graphviz's
// record shape, or a table in an entity diagram).
//
//   {"id": "users", "label": "users", "fields": ["id", {"id": "email", "label": "email address"}]}
//   {"from": "orders:user_id", "to": "users:id"}       or "fromPort" / "toPort"
//
// The cells run across the flow, so an edge comes into its field along the flow like into any
// node: side by side top to bottom (TB / BT), stacked left to right (LR / RL), the table shape.
// A header cell with the label comes first ("header": false leaves it out). Colours: "color",
// "border", "text", "headerColor", "headerText".

import { THEME } from "./looks.mjs";

const FS = 13, PX = 12, PY = 6;
const SLACK = 1.15;   // stacked cells share one width, fixed up front: room for the engine's text

export const isRecord = (src) => Array.isArray(src?.fields);

/** The cells, in order: [{field: id | null (the header), label}]. */
export function cellsOf(node) {
    const src = node.src, cells = [];
    if (src.header !== false) cells.push({ field: null, label: String(node.label) });
    for (const f of src.fields) {
        const id = typeof f === "object" && f !== null ? f.id : f;
        if (id === undefined || id === null) throw new Error(`node ${node.id}: a field needs an id`);
        cells.push({ field: String(id), label: String((typeof f === "object" ? f.label : undefined) ?? id) });
    }
    if (!cells.some((c) => c.field !== null)) throw new Error(`node ${node.id}: "fields" is empty`);
    return cells;
}

/** Whether node src has the field. */
export const hasField = (src, field) => isRecord(src) && src.fields.some((f) => String(typeof f === "object" && f !== null ? f.id : f) === String(field));

/** Where a field sits across the record, as a share of it from -0.5 to 0.5 (for ordering). */
export function fieldShare(node, field) {
    const cells = cellsOf(node), k = cells.findIndex((c) => c.field === field);
    return (k + 0.5) / cells.length - 0.5;
}

/**
 * The record's size (screen) and its cells across the flow.
 * @returns {w, h, cross: [{...cell, c0, c1}] (from the record's start across the flow),
 *           ports: Map<field, {off, ext}> (each field's centre from the record's centre, its extent)}
 */
export function recordSize(node, measure, tb) {
    const cells = cellsOf(node);
    const cw = cells.map((c) => Math.ceil(measure(c.label, FS) + 2 * PX)), ch = Math.ceil(FS * 1.25 + 2 * PY);
    const ext = tb ? cw : cells.map(() => ch);
    const cross = [];
    let at = 1;
    cells.forEach((c, k) => { cross.push({ ...c, c0: at, c1: at + ext[k] }); at += ext[k] + 1; });
    const total = at;   // 1 border + cells and 1px dividers + 1 border
    const ports = new Map(cross.filter((c) => c.field !== null).map((c) => [c.field, { off: (c.c0 + c.c1) / 2 - total / 2, ext: c.c1 - c.c0 }]));
    const along = tb ? ch + 2 : Math.ceil(Math.max(...cw) * SLACK) + 2;
    return { w: tb ? total : along, h: tb ? along : total, cross, ports, cellWidth: along - 2 };
}

const colours = (src) => ({
    fill: src.color ?? THEME.surface, border: src.border ?? THEME.outline, text: src.text ?? THEME.text,
    head: src.headerColor ?? THEME.outline, headText: src.headerText ?? THEME.text,
});

/**
 * Reflow mode's layout (rec: recordSize()): the cells in a row (TB) or column (LR) whose
 * background shows through 1px gaps as the dividers and border. Each field's cell is flanked by its own anchors along the
 * flow, named by `anchorFor(k, "a" | "b")` (k: the cell's index), in flow order (`flowOrder`).
 */
export function recordLayout(node, rec, tb, anchorFor, flowOrder) {
    const c = colours(node.src), { cross, cellWidth } = rec;
    const cell = (cl, k) => {
        const text = { text: { value: cl.label, fontSize: FS, color: cl.field === null ? c.headText : c.text,
                               ...(cl.field === null ? { fontWeight: 600 } : {}) } };
        const box = { box: { horizontalAlignment: tb ? "center" : "start", verticalAlignment: "center",
                             modifiers: [...(tb ? [] : [{ horizontalWeight: 1 }]), { padding: [PX, PY] }], children: [text] } };
        const bg = { background: cl.field === null ? c.head : c.fill };
        if (cl.field === null) return { box: { ...box.box, modifiers: [...(tb ? [] : ["fillMaxWidth"]), bg, ...box.box.modifiers.filter((m) => !m.horizontalWeight)] } };
        const kids = flowOrder([anchorFor(k, "a"), box, anchorFor(k, "b")]);
        return tb ? { column: { horizontalAlignment: "center", modifiers: [bg], children: kids } }
                  : { row: { verticalAlignment: "center", modifiers: ["fillMaxWidth", bg], children: kids } };
    };
    const mods = [...(tb ? [] : [{ width: cellWidth + 2 }]), { clip: 8 }, { background: c.border }, { padding: [1, 1] }, { spacedBy: 1 }];
    const kids = cross.map(cell);
    return tb ? { row: { verticalAlignment: "center", modifiers: mods, children: kids } }
              : { column: { horizontalAlignment: "start", modifiers: mods, children: kids } };
}

/** Canvas mode's drawing (rec: recordSize()) at box b: {body, label} commands. */
export function recordCanvas(node, rec, b, tb) {
    const c = colours(node.src), { cross } = rec;
    const r1 = (x) => Math.round(x * 10) / 10;
    const rect = { left: r1(b.left), top: r1(b.top), right: r1(b.right), bottom: r1(b.bottom) };
    const body = [
        { paint: { ops: [{ color: c.fill }, { style: "fill" }] } },
        { drawRoundRect: { ...rect, rx: 8, ry: 8 } },
    ];
    const label = [];
    const head = cross.find((cl) => cl.field === null);
    const span = (cl) => (tb ? { left: r1(b.left + cl.c0), right: r1(b.left + cl.c1), top: rect.top, bottom: rect.bottom }
                             : { left: rect.left, right: rect.right, top: r1(b.top + cl.c0), bottom: r1(b.top + cl.c1) });
    if (head) {
        // The header's fill, rounded on the record's outer corners only: clipped to the record.
        const s = span(head);
        body.push({ save: { commands: [
            { clipRect: s },
            { paint: { ops: [{ color: c.head }] } },
            { drawRoundRect: { ...rect, rx: 8, ry: 8 } },
        ] } });
    }
    body.push({ paint: { ops: [{ color: c.border }, { style: "stroke" }, { width: 1 }] } });
    for (const cl of cross.slice(1)) {
        const d = r1((tb ? b.left : b.top) + cl.c0 - 0.5);
        body.push(tb ? { drawLine: { x1: d, y1: rect.top, x2: d, y2: rect.bottom } } : { drawLine: { x1: rect.left, y1: d, x2: rect.right, y2: d } });
    }
    body.push({ drawRoundRect: { ...rect, rx: 8, ry: 8 } });
    for (const cl of cross) {
        const s = span(cl);
        label.push({ paint: { ops: [{ color: cl.field === null ? c.headText : c.text }, { style: "fill" }, { textSize: FS }] } },
                   tb ? { drawTextAnchored: { text: cl.label, x: r1((s.left + s.right) / 2), y: r1((s.top + s.bottom) / 2), panX: 0, panY: 0 } }
                      : { drawTextAnchored: { text: cl.label, x: r1(s.left + PX), y: r1((s.top + s.bottom) / 2), panX: -1, panY: 0 } });
    }
    return { body, label };
}
