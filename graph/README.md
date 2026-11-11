# graph2rc — graphs as RemoteCompose documents

A JSON graph description in, a RemoteCompose JSON document out (then `json2rc` for the `.rc`).

```sh
node graph/graph2rc.mjs graph/examples/pipeline.json out.json --mode reflow --direction auto
node graph/graph2rc.mjs graph/examples/pipeline.json out.json --mode canvas
node json2rc/build/cli.js out.json out.rc
```

```json
{ "nodes": [{"id": "a", "label": "Start", "color": "#FF2B3A55"}, ...],
  "edges": [{"from": "a", "to": "b", "color": "#FF8FA3BF"}, ...],
  "direction": "auto" }
```

## Looks

How a node draws itself is plain JSON (`looks.mjs`): a `layout` (one RemoteCompose component,
for reflow mode) and a `canvas` drawing (for canvas mode), with `{{label}}`, `{{data.key}}`,
any node field and the look's `defaults` as placeholders; canvas drawings also get the node's
box (`{{left}}`, `{{cx}}`, `{{w}}`, `{{radius}}`...). Built in: `card` (the default: rounded,
hairline border), `pill` and `outline`. A graph adds its own under `looks` and picks them per
node (`"look": "status"`) or for all (`"style": {"look": "status"}`); `examples/ci.json`
defines a status card with a coloured dot and a subtitle.

```json
"looks": {"tag": {
  "defaults": {"color": "#FF1E293B"},
  "layout": {"box": {"modifiers": [{"clip": 8}, {"background": "{{color}}"}, {"padding": [12, 6]}],
                     "children": [{"text": {"value": "{{label}}", "fontSize": 13, "color": "#FFE2E8F0"}}]}},
  "canvas": {"commands": [{"paint": {"ops": [{"color": "{{color}}"}]}},
                          {"drawRoundRect": {"left": "{{left}}", "top": "{{top}}", "right": "{{right}}", "bottom": "{{bottom}}", "rx": 8, "ry": 8}}],
             "label": [{"paint": {"ops": [{"color": "#FFE2E8F0"}, {"textSize": 13}]}},
                       {"drawTextAnchored": {"text": "{{label}}", "x": "{{cx}}", "y": "{{cy}}", "panX": 0, "panY": 0}}]},
  "fontSize": 13, "padding": [12, 6]}}
```

`size` / `fontSize` / `padding` give the node's size in canvas mode (and the reflow
orientation estimate): a fixed `[w, h]`, or `"auto"` per axis for the label plus padding.

## Edges

The same curve in both modes: a cubic whose control points sit halfway along the flow, so an
edge leaves and enters nodes (and crosses each dummy) along the flow and a long edge is one
smooth line. It stops short of its target for a fixed arrowhead. In reflow mode each segment
is a `pathExpression` over the anchors' live positions, so the curves follow the layout.

## Structure

`layered.mjs` is the shared structural layout: cycles broken by reversing back edges (drawn
with the arrow at their real target), longest-path ranks, one dummy per rank a long edge
crosses, barycenter crossing reduction, parallel edges spread sideways. Self-loops are
dropped for now.

## `--mode reflow`

The converter fixes the structure; the engine does the geometry. Ranks are Rows in a Column
(TB) or Columns in a Row (LR), nodes are real Box+Text, so sizes come from the device's own
text measurement and the graph relayouts on resize. Edges are drawn by a canvas over the
graph against each node's ports as laid out:

- Each node is flanked by two 0x0 **anchor canvases** on its ports (a dummy is one anchor),
  each binding its root position with json2rc's `componentValues` extension
  (COMPONENT_VALUE ops). Canvases, because androidx's player only refreshes component values
  for a canvas: on a box/row/column they keep the 1.0 placeholder from the data pass.
- `--direction auto` holds both orientations in a StateLayout and picks the one that
  overflows the space less, from sizes estimated from the labels. The space is measured by a
  fill-size canvas, not `windowWidth()`: androidx's player keeps that at the document's
  declared size, Kobento's players give the viewport. Until the canvas is laid out the
  `windowWidth()` guess stands, so Kobento's players start in the right state; androidx's may
  cross-fade once after its first layout.

## `--mode canvas`

All geometry computed here (text widths estimated by `measureLabel`, labels drawn centred so
an error shows as uneven margins), drawn as one picture: cubic edges with vertical tangents
running straight through dummies, rounded nodes. Drag pans (touchExpression, coasting), the
+ / - buttons zoom (animated, about the graph's centre), the graph starts fitted to the view,
and labels drop out below ~6px. RemoteCompose has no pinch, hence the buttons.

## Checking

Renders in both Kobento engines (`kobento-ts/render.mjs`, `cpp/build/rc2image/rc2image`, which
needs `--duration` to see a StateLayout switch after the first frame) and the Java reference:

```sh
conformance/java-layout.sh out.rc 1100 360 --frames 5 --remeasure --floats
```

`--floats` traces every float the document loads; `--remeasure` measures before each paint, as
a player does when a StateLayout invalidates (the mock has no layout callback).
