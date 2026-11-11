# graph2rc — graphs as RemoteCompose documents

A JSON graph description in, a RemoteCompose JSON document out (then `json2rc` for the `.rc`).

```sh
node graph/graph2rc.mjs graph/examples/pipeline.json out.json --mode reflow --direction auto
node graph/graph2rc.mjs graph/examples/pipeline.json out.json --mode canvas
node json2rc/build/cli.js out.json out.rc
```

Options: `--direction TB|BT|LR|RL|auto`, `--overflow pan|clip` (reflow mode, below),
`--width` / `--height` (the document's declared size).

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

### Theme

`"theme": {"surface": "#FF1E293B", "edge": "@colors.muted", ...}` overrides the colours the
built-in looks, edges, records and buttons draw with (`THEME` in `looks.mjs`: `bg`, `edge`,
`text`, `muted`, `surface`, `outline`, `accent`, `button`, `buttonFg`, `group`, `header`). A
value is any colour the document understands, a named one too, so a document can follow light,
dark and mono themes. Looks read them anywhere (defaults, layout, canvas drawing) as
`{{theme.surface}}`. The built-in
looks draw a border as the background of an outer box around the inner one, since a border
modifier's colour is a literal for the Java parser.

## Embedding

`reflowView(graph, opts)` and `canvasGraphView(graph, opts)` return the graph as one component
(it fills what it is given) and the variables it reads (`resources.variables` entries), for a
document that has more in it; `reflowDoc` / `canvasDoc` wrap them in a document. Options:
`direction`, `overflow`, `ns` (a prefix for every name it declares, so several graphs can share a
document) and `guess` (`{width, height}` expressions: the space reflow mode plans its first frame
for, before it is measured; the window by default). kobento-mcp's `GraphDiagram` component is
built on them (its `layered` generator), with the library's theme colours.

Both drop the anchor values nothing reads (a node with no edge out needs neither of its out
anchor's): every player computes a value at every layout whether it is used or not.

## Groups

```json
"groups": [{"id": "middle", "label": "MIDDLE END", "nodes": ["types", "ir"],
            "groups": [{"id": "optim", "label": "OPTIMISER", "nodes": ["inline", "dce"]}]}]
```

or `"group": "middle"` on a node. Groups nest, can be an edge's end, and draw with a group
look (built in: `group`; per group `"look"`, or `style.groupLook`): a node look whose layout has
a `"{{content}}"` slot for the group's own ranks and a `title` height for canvas mode.

A group is a **compound node** (`compound.mjs`): it is laid out as its own layered graph and is
one node of its parent's, so in reflow mode it is a real container and reflows like any node.
An edge is laid out at the deepest group holding both its ends, between the children that hold
them, and drawn to the real nodes. Unlike Graphviz's clusters, a group does not share ranks
with the outside: it sits whole in one rank of its parent.

## Edges

```json
{"from": "check", "to": "back", "label": "no", "color": "#FFF87171", "width": 1.75,
 "style": "dashed", "arrowhead": "diamond", "arrowtail": "dot", "dir": "both"}
```

- `style`: `solid`, `dashed` or `dotted` (RemoteCompose's dash path effect).
- `arrowhead` (at `to`) and `arrowtail` (at `from`): `normal`, `open`, `diamond`, `dot`,
  `none`; `dir` (`forward`, `back`, `both`, `none`) sets both as in Graphviz. `"directed": false`
  on the graph makes edges default to no arrows; `"style": {"edge": {...}}` sets defaults.
- `label`: the edge spans at least two ranks and its label sits on the line in the rank
  between (Graphviz's approach). It is drawn with the `edgeLabel` look (override it like any
  look, or per edge with `labelLook`), so in reflow mode it is a real, engine-measured
  component.

- `lhead` / `ltail` (Graphviz's): laid out to the node, drawn to the border of a group holding
  it -- `{"from": "dce", "to": "emit", "ltail": "middle"}` leaves the whole MIDDLE END group.
  `test/fixtures/lhead.json`.

`examples/flow.json` uses most of these.

### Self-loops

An edge from a node to itself leaves the node's side across the flow (its right in TB, its
bottom in LR), swings out and comes back a little further along: a cubic whose control points
sit at the same distance out, so it leaves and returns square to the side. Several loops on one
node nest; a label goes beyond the outermost loop. The layout keeps that room clear beside the
node (`loops.mjs`). `examples/states.json`.

### Records and ports

A node with `fields` is a record (Graphviz's record shape, or a table): a header cell with its
label (`"header": false` drops it), then one cell per field, each a port an edge can name:

```json
{"id": "orders", "label": "orders", "fields": ["id", "user_id", {"id": "total", "label": "total ($)"}]}
{"from": "orders:user_id", "to": "users:id"}          or "fromPort" / "toPort"
```

The cells run across the flow, so an edge comes into its field along the flow like into any
node: side by side in TB / BT, stacked in LR / RL (the table shape). Crossing reduction and
positions count an edge at its field, so in canvas mode a field lines up with the one it points
at; edges sharing a field spread across it. In reflow mode every field cell has its own
anchors. Stacked cells share one width, fixed from the label estimate with some slack (no
player agrees on intrinsic widths). Colours: `color`, `border`, `text`, `headerColor`,
`headerText`. `examples/schema.json`.

### Taps

`"action": "open"` on a node, group or edge -- or `style.action` for every node,
`style.edgeAction` for every edge -- sends a host named action, the name given and the node's
id (an edge's `id`, or `from->to`) as its value; `"onClick": [...]` takes RemoteCompose actions
as json2rc reads them instead. An edge is tapped by its label.

Either way the tap is a component's click modifier, with semantics for accessibility:

- Reflow mode: the node's (or label's) own component. A label drawn on a lane or beside a
  self-loop is not a component and cannot be tapped.
- Canvas mode (and reflow mode's pan fallback): a transparent component per tappable item,
  over the canvas, kept where the item is drawn as the graph pans and zooms: `computePosition`
  places it (json2rc's extension: the Kotlin DSL's `Modifier.computePosition { x = ...; y = ... }`,
  expressions the player evaluates at layout time), its size is the scaled box. An `offset`
  modifier would only move the drawing; a tap still lands where it was laid out. The pan is the
  canvas's touch expression, which gets every drag, so a drag that starts on a node still pans.
  The web player needed a fix for it (kobento-ts: `LayoutComputeOperation.evaluateInLayout`, so
  a position that changes alone is laid out again); androidx and the C++ player had it. (Canvas
  click areas were the first try: androidx's `ClickArea.updateVariables` stores an expression's
  right edge in `mRight` instead of `mOutRight`, so an area that moves never matches, and
  androidx keeps an area once added.)

## Structure

`layered.mjs` is the shared structural layout: cycles broken by reversing back edges (drawn
with the arrow at their real target), longest-path ranks, one dummy per rank a long edge
crosses, barycenter crossing reduction, parallel edges spread sideways. Self-loops are drawn
apart (above).

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

### Overflow

A reflowed graph gives way across the flow (its labels wrap) but not along it. When even the
orientation that fits better would overflow -- from the same size estimates, with some slack
across the flow -- the document shows the graph as canvas mode's picture instead, fitted to
the space, with pan and zoom: one more StateLayout state per orientation, picked by the same
measured-space expression. `--overflow clip` keeps the reflowed graph whatever its size.
(Scrolling the reflowed layout was the first idea: the TypeScript player drew nothing inside
nested scrolls and the C++ one opened at the start, away from the graph's centre.)

When a long edge's side is taken where it runs and a nearer lane is free on the other side,
it runs there instead, rather than further out (and off the screen).

## `--mode canvas`

All geometry computed here (text widths estimated by `measureLabel`, labels drawn centred so
an error shows as uneven margins), drawn as one picture: cubic edges with vertical tangents
running straight through dummies, rounded nodes. Drag pans (touchExpression, coasting), the
+ / - buttons zoom (animated, about the graph's centre), the graph starts fitted to the view,
and labels drop out below ~6px. RemoteCompose has no pinch, hence the buttons.

## Checking

```sh
node --test graph/test/*.test.mjs                 # layout and documents
RC_JAVA=1 node --test graph/test/*.test.mjs       # and the Java reference (needs a JDK, ~/androidx)
```

- `test/layout.test.mjs`: the fixed layout of every example and fixture in all four directions
  -- siblings do not overlap, groups hold their insides, long edges are straight through their
  middle, edges keep out of nodes and labels, edges side by side keep 6px apart, edges on one
  node attach 4px apart, an edge naming a field attaches inside it, self-loops and their labels
  keep clear.
- `test/documents.test.mjs`: every graph converts (json2rc refuses an expression Android
  would) in both modes, every direction and auto; played in Kobento's TypeScript player, every
  reflow anchor is laid out, the overflow fallback picks the expected state, and taps reach the
  host in both modes, canvas mode's following a zoom and a pan (a drag that starts on a node);
  with `RC_JAVA=1`, the Java reference lays out each reflow document with no exception and no
  anchor left at its placeholder, and taps send their actions in both modes.

By eye:

Renders in both Kobento engines (`kobento-ts/render.mjs`, `cpp/build/rc2image/rc2image`, which
needs `--duration` to see a StateLayout switch after the first frame) and the Java reference:

```sh
conformance/java-layout.sh out.rc 1100 360 --frames 5 --remeasure --floats
```

`--floats` traces every float the document loads; `--remeasure` measures before each paint, as
a player does when a StateLayout invalidates (the mock has no layout callback).
