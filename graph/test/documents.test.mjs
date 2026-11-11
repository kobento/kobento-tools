// The documents graph2rc writes, end to end:
//   - every example and fixture converts (json2rc refuses what Android would: an expression
//     past 32 entries, an unknown key...) in both modes, every direction and auto
//   - played in Kobento's TypeScript player (skipped without it): the reflowed layout's anchors
//     are all laid out, the overflow fallback picks the right state, taps reach the host
//   - with RC_JAVA=1, the Java reference player (conformance/java-layout.sh) lays out each
//     reflow document without an exception and refreshes every anchor
//
//   node --test graph/test            RC_JAVA=1 node --test graph/test

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { graphs, graph, toRc, play, haveTs, GRAPH_DIR } from "./harness.mjs";
import { reflowDoc, canvasDoc, measureLabel } from "../graph2rc.mjs";
import { compound } from "../compound.mjs";
import { layout } from "../geometry.mjs";

const DIRS = ["TB", "BT", "LR", "RL"];

for (const { name, graph: g } of graphs()) {
    test(`${name} converts`, () => {
        for (const direction of [...DIRS, "auto"]) {
            for (const overflow of ["pan", "clip"]) {
                assert.doesNotThrow(() => toRc(reflowDoc(g, { direction, overflow })), `reflow ${direction} ${overflow}`);
            }
        }
        for (const direction of DIRS) assert.doesNotThrow(() => toRc(canvasDoc(g, { direction })), `canvas ${direction}`);
    });
}

const ts = await haveTs();

// A reflow document's anchors: the names ending in x / y that its variant's prefix starts.
const anchors = (p, prefix) => Object.keys(p.vars).filter((k) => k.startsWith(prefix) && /^[a-z]\d+[a-z0-9_]*[xy]$/.test(k));

for (const { name, graph: g } of graphs()) {
    for (const dir of DIRS) {
        test(`${name} ${dir} reflows`, { skip: !ts && "no TypeScript player" }, async () => {
            const W = 1600, H = 1600;   // room for every graph: the reflowed state shows
            const p = await play(reflowDoc(g, { direction: dir, overflow: "clip" }), W, H);
            const names = anchors(p, "v");
            assert.ok(names.length > 0, "no anchors");
            for (const n of names) {
                const v = p.float(n);
                assert.ok(Number.isFinite(v) && v >= -1 && v <= Math.max(W, H) + 1, `${n} = ${v}`);
            }
            // Every node's two flow anchors are laid out apart (the node between them).
            const T = compound(g), index = new Map([...T.items.keys()].map((id, i) => [id, i]));
            const F = dir === "TB" || dir === "BT" ? "y" : "x";
            for (const [id, it] of T.items) {
                if (it.kind !== "node") continue;
                const i = index.get(id), a = p.float(`v${i}a${F}`), b = p.float(`v${i}b${F}`);
                assert.ok(Math.abs(b - a) >= 10, `${id}: its anchors are ${Math.abs(b - a)}px apart along the flow`);
            }
        });
    }
}

test("overflow: a graph too big for the space is panned instead", { skip: !ts && "no TypeScript player" }, async () => {
    // States: 0 / 1 reflowed top to bottom / left to right, 2 / 3 the same panned.
    const state = async (name, w, h, opts = {}) => (await play(reflowDoc(graph(name), opts), w, h)).float("orient");
    assert.equal(await state("flow", 360, 800), 0, "flow fits a tall phone, top to bottom");
    assert.equal(await state("flow", 1500, 400), 1, "flow fits a wide screen, left to right");
    assert.equal(await state("wide", 360, 640), 3, "wide does not fit a phone: panned, left to right");
    assert.ok(await state("wide", 1600, 900) < 2, "wide fits a big screen: reflowed");
    assert.equal(await state("wide", 360, 640, { overflow: "clip" }), 1, "clip keeps the reflowed state");
});

test("taps: reflow mode sends the node's host action", { skip: !ts && "no TypeScript player" }, async () => {
    const g = graph("states");
    const p = await play(reflowDoc(g, { direction: "TB", overflow: "clip" }), 600, 900);
    const T = compound(g), index = new Map([...T.items.keys()].map((id, i) => [id, i]));
    const centre = (id) => { const i = index.get(id); return [p.float(`v${i}ax`), (p.float(`v${i}ay`) + p.float(`v${i}by`)) / 2]; };
    assert.deepEqual(p.click(...centre("online")), [{ name: "open", value: "online" }], "style.action");
    assert.deepEqual(p.click(...centre("error")), [{ name: "details", value: "error" }], "the node's own action");
    const label = [...T.items].find(([, it]) => it.kind === "label" && it.src.id === "fail")[0];
    assert.deepEqual(p.click(...centre(label)), [{ name: "why", value: "fail" }], "an edge, by its label");
    assert.deepEqual(p.click(5, 5), [], "nothing there");
});

/** Where canvas mode draws a node's centre at view size W x H, zoomed `steps` times. */
function canvasAt(g, W, H, steps = 0) {
    const T = compound(g), { G } = layout(g, T, measureLabel, "TB");
    const GW = Math.ceil(G.total.w), GH = Math.ceil(G.total.h);
    const scale = Math.min((W - 32) / GW, (H - 32) / GH, 1.5) * 1.25 ** steps;
    return { T, at: (id) => { const b = G.geo.get(id); return [W / 2 + scale * (b.cx - GW / 2), H / 2 + scale * (b.cy - GH / 2)]; } };
}

test("taps: canvas mode sends the same actions, following the zoom", { skip: !ts && "no TypeScript player" }, async () => {
    const g = graph("states"), W = 600, H = 900;
    const p = await play(canvasDoc(g, { direction: "TB" }), W, H);
    const { T, at } = canvasAt(g, W, H);
    assert.deepEqual(p.click(...at("online")), [{ name: "open", value: "online" }]);
    assert.deepEqual(p.click(...at("error")), [{ name: "details", value: "error" }]);
    const label = [...T.items].find(([, it]) => it.kind === "label" && it.src.id === "fail")[0];
    assert.deepEqual(p.click(...at(label)), [{ name: "why", value: "fail" }], "an edge, by its label");
    // Zoom in twice (the + button, bottom right); the node moves out from the centre, its target too.
    for (let i = 0; i < 2; i++) assert.deepEqual(p.click(W - 32, H - 84), []);
    const zoomed = canvasAt(g, W, H, 2);
    assert.deepEqual(p.click(...zoomed.at("error")), [{ name: "details", value: "error" }], "where the zoom drew it");
    const [x0, y0] = at("error"), [x1, y1] = zoomed.at("error");
    assert.ok(Math.hypot(x1 - x0, y1 - y0) > 40, "the zoom moved it");
    // A drag that starts on a node still pans, and the node's target goes with it.
    p.drag(x1, y1, x1 - 120, y1 - 60);
    assert.deepEqual(p.click(x1 - 120, y1 - 60), [{ name: "details", value: "error" }], "where the pan took it");
    assert.deepEqual(p.click(x1, y1), [], "not where it was");
});

test("taps: reflow mode's pan fallback", { skip: !ts && "no TypeScript player" }, async () => {
    const g = graph("states"), W = 360, H = 400;   // too small: panned
    const p = await play(reflowDoc(g, { direction: "TB" }), W, H);
    assert.equal(p.float("orient") ?? 1, 1);
    const { at } = canvasAt(g, W, H);
    assert.deepEqual(p.click(...at("online")), [{ name: "open", value: "online" }]);
});

const java = process.env.RC_JAVA === "1";
const JAVA_SH = path.join(GRAPH_DIR, "..", "conformance", "java-layout.sh");
for (const { name, graph: g } of graphs()) {
    for (const dir of ["TB", "LR", "auto"]) {
        test(`${name} ${dir} in the Java reference`, { skip: !java && "set RC_JAVA=1" }, () => {
            const W = 1600, H = 1600;
            const { bytes, vars } = toRc(reflowDoc(g, { direction: dir, overflow: "clip" }));
            const file = path.join(mkdtempSync(path.join(tmpdir(), "graph2rc-")), "doc.rc");
            writeFileSync(file, bytes);
            const out = execFileSync(JAVA_SH, [file, String(W), String(H), "--frames", "3", "--floats"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            assert.ok(!/Exception/.test(out), out.split("\n").find((l) => /Exception/.test(l)));
            const floats = new Map([...out.matchAll(/^FLOAT id=(\d+) v=(\S+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
            const prefix = dir === "auto" ? "t" : "v";
            // An anchor still at 1.0 kept json2rc's placeholder: the player never refreshed it.
            const stuck = anchors({ vars }, prefix).filter((n) => floats.get(vars[n]) === 1);
            assert.deepEqual(stuck, [], "anchors left at the placeholder");
        });
    }
}

/** Runs the Java reference on a document; @returns {out, floats: Map<id, value>}. */
function javaRun(doc, W, H, ...steps) {
    const { bytes, vars } = toRc(doc);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "graph2rc-")), "doc.rc");
    writeFileSync(file, bytes);
    const out = execFileSync(JAVA_SH, [file, String(W), String(H), "--frames", "3", "--floats", ...steps.map(String)],
                             { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const floats = new Map([...out.matchAll(/^FLOAT id=(\d+) v=(\S+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
    return { out, vars, float: (n) => floats.get(vars[n]) };
}

test("taps: reflow mode in the Java reference", { skip: !java && "set RC_JAVA=1" }, () => {
    const g = graph("states"), doc = reflowDoc(g, { direction: "TB", overflow: "clip" });
    const T = compound(g), i = [...T.items.keys()].indexOf("online");
    const first = javaRun(doc, 600, 900);
    const x = first.float(`v${i}ax`), y = (first.float(`v${i}ay`) + first.float(`v${i}by`)) / 2;
    const { out } = javaRun(doc, 600, 900, "--click", x, y);
    assert.match(out, /^ACTION name=open value=online$/m);
});

test("taps: canvas mode in the Java reference", { skip: !java && "set RC_JAVA=1" }, () => {
    const g = graph("states"), W = 600, H = 900, { at } = canvasAt(g, W, H);
    const { out } = javaRun(canvasDoc(g, { direction: "TB" }), W, H, "--click", ...at("online"));
    assert.match(out, /^ACTION name=open value=online$/m);
});
