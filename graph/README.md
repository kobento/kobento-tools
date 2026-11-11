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

Edges are straight segments through the dummies (no engine-side routing).

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
