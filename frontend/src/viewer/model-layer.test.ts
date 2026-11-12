import assert from "node:assert/strict";
import { test } from "node:test";
import { AdditiveBlending, NormalBlending } from "three";
import { floorOf, modelEdges, modelKind, ModelLayer, modelShade, needsMeshopt, readModel, shadedColour, type LayerFloor, type ModelPart } from "./model-layer.ts";

// ------------------------------------------------------------------ an invented GLB, written here

interface TestNode {
  name: string;
  box: [number, number, number, number, number, number];
  translation?: number[];
  scale?: number[];
  extras?: Record<string, string>;
  material?: number;
}

/** A GLB with one box per node (positions as floats, or as normalised int16 with `quantize`). */
function glb(nodes: TestNode[], opts: { required?: string[]; used?: string[]; quantize?: boolean; meshoptView?: boolean } = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const add = (bytes: Uint8Array) => {
    const pad = (4 - (bytes.length % 4)) % 4;
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.length + pad;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };
  const meshes = nodes.map((n) => {
    const [x0, y0, z0, x1, y1, z1] = n.box;
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ].flat();
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    const index = new Uint16Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
    const pos = opts.quantize ? new Int16Array(corners.map((v) => Math.round(v * 32767))) : new Float32Array(corners);
    const pv = add(new Uint8Array(pos.buffer));
    accessors.push({ bufferView: pv, componentType: opts.quantize ? 5122 : 5126, normalized: opts.quantize || undefined, count: 8, type: "VEC3" });
    const iv = add(new Uint8Array(index.buffer));
    accessors.push({ bufferView: iv, componentType: 5123, count: index.length, type: "SCALAR" });
    return { primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, material: n.material }] };
  });
  if (opts.meshoptView) (bufferViews[0] as { extensions?: object }).extensions = { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: 4, byteStride: 12, count: 8, mode: "ATTRIBUTES" } };
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map((n, i) => ({ name: n.name, mesh: i, translation: n.translation, scale: n.scale, extras: n.extras })),
    meshes,
    materials: [{ name: "Concrete", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }, { name: "Window glass", alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.8, 0.9, 0.3] } }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    extensionsUsed: opts.used,
    extensionsRequired: opts.required,
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(Math.ceil(enc.length / 4) * 4).fill(0x20);
  jsonBytes.set(enc);
  const bin = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    bin.set(c, p);
    p += c.length;
  }
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  dv.setUint32(20 + jsonBytes.length, bin.length, true);
  dv.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  out.set(bin, 28 + jsonBytes.length);
  return out;
}

/** An invented two-storey house: a ground floor wall, an upper slab, a glass pane and a roof. */
const HOUSE: TestNode[] = [
  { name: "Basic Wall", box: [0, 0, 0, 6, 2.7, 0.3], extras: { category: "Walls", level: "Ground floor" }, material: 0 },
  { name: "Floor 250", box: [0, 0, 0, 6, 0.25, 5], translation: [0, 2.8, 0], extras: { category: "OST_Floors", level: "Upper floor" }, material: 0 },
  { name: "Pane", box: [1, 1, 0.1, 2, 2, 0.12], extras: { category: "Curtain Panels", level: "Ground floor" }, material: 1 },
  { name: "Roof", box: [0, 0, 0, 1, 1, 1], translation: [-0.5, 5.6, -0.5], scale: [7, 1.5, 6], extras: { category: "IfcRoof" }, material: 0 },
];
const FLOORS: LayerFloor[] = [
  { id: "eg", name: "Ground floor", elevation: 0, height: 2.8 },
  { id: "og", name: "Upper floor", elevation: 2.8, height: 2.6 },
];
const minY = (p: ModelPart) => p.positions.filter((_, i) => i % 3 === 1).reduce((a, b) => Math.min(a, b), Infinity);

test("reads boxes with node transforms, extras and colours", () => {
  const parts = readModel(glb(HOUSE));
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((p) => p.kind), ["wall", "slab", "glass", "roof"]);
  assert.deepEqual(parts.map((p) => p.level), ["Ground floor", "Upper floor", "Ground floor", ""]);
  assert.ok(Math.abs(minY(parts[1]) - 2.8) < 1e-6, "translation applied");
  assert.ok(Math.abs(minY(parts[3]) - 5.6) < 1e-6);
  const roofX = parts[3].positions.filter((_, i) => i % 3 === 0);
  assert.ok(Math.abs(Math.max(...roofX) - 6.5) < 1e-6, "scale applied");
  assert.equal(parts[2].opacity, 0.3);
  assert.equal(parts[0].index.length, 36);
});

test("dequantises normalised int16 positions", () => {
  const [part] = readModel(glb([{ name: "q", box: [0, 0, 0, 0.5, 0.25, 1] }], { quantize: true }));
  assert.ok(Math.abs(Math.max(...part.positions) - 1) < 1e-4);
  assert.ok(Math.abs(part.positions[3] - 0.5) < 1e-4);
});

test("names what an export must leave out, and asks for the meshopt decoder", () => {
  assert.throws(() => readModel(glb(HOUSE, { required: ["KHR_draco_mesh_compression"] })), /model_needs_draco/);
  const compressed = glb(HOUSE, { used: ["EXT_meshopt_compression"], meshoptView: true });
  assert.equal(needsMeshopt(compressed), true);
  assert.equal(needsMeshopt(glb(HOUSE)), false);
  assert.throws(() => readModel(compressed), /model_needs_meshopt/);
  // a decoder is handed the compressed bytes and fills the view
  let called = 0;
  readModel(compressed, { ready: Promise.resolve(), decodeGltfBuffer: (target) => (called++, target.fill(0)) });
  assert.equal(called, 1);
});

test("Revit categories and IFC classes map to kinds", () => {
  assert.equal(modelKind("Walls"), "wall");
  assert.equal(modelKind("OST_Roofs"), "roof");
  assert.equal(modelKind("IfcWallStandardCase"), "wall");
  assert.equal(modelKind("IfcSlab"), "slab");
  assert.equal(modelKind("Railings"), "rail");
  assert.equal(modelKind("Planting"), "plant");
  assert.equal(modelKind("Mass"), "other");
  assert.equal(modelKind(undefined), "other");
});

test("parts find their floor: file first, then the level's name, then their height", () => {
  const part = { level: "", positions: new Float32Array(), index: new Uint32Array(), color: [1, 1, 1], opacity: 1, kind: "wall", name: "" } as ModelPart;
  assert.equal(floorOf({ ...part, floorId: "og" }, FLOORS, 0), "og");
  assert.equal(floorOf({ ...part, level: "upper FLOOR " }, FLOORS, 0), "og");
  assert.equal(floorOf(part, FLOORS, 2.75), "og", "a slab starting a little under the level");
  assert.equal(floorOf(part, FLOORS, 1), "eg");
  assert.equal(floorOf(part, FLOORS, -3), "eg", "below the lowest floor");
  assert.equal(floorOf(part, [], 1), null);
});

test("the layer batches per floor, follows the floors and cuts above the opened one", () => {
  const parts = readModel(glb(HOUSE));
  const layer = new ModelLayer(parts, { offset: [2, 0, 1] }, FLOORS, { theme: { value: 0 }, lineBlending: AdditiveBlending, low: false });
  assert.equal(layer.triangles, 48);
  // the roof has no level: by its height it belongs to the upper floor
  const holders = layer.group.children;
  assert.equal(holders.length, 2);
  assert.equal(holders[1].position.y, 2.8, "the upper floor's parts stand on its level");
  layer.placeFloor("og", 2.8 + 6, 0);
  assert.equal(holders[1].visible, false, "flown away with its floor");
  layer.placeFloor("eg", -0.4, 0.22);
  assert.equal(holders[0].position.y, -0.4);
  // the offset moves the model in the plan: the wall starts at x = 2
  const wall = holders[0].children.find((o) => o.name === "fp3d-model-wall") as unknown as { geometry: { attributes: { position: { array: Float32Array } } } };
  assert.equal(Math.min(...wall.geometry.attributes.position.array.filter((_, i) => i % 3 === 0)), 2);
  layer.setCut(2.8);
  layer.dispose();
  // the tablet level draws no edges
  const low = new ModelLayer(parts, {}, FLOORS, { theme: { value: 0 }, lineBlending: AdditiveBlending, low: true });
  assert.equal(low.lines.length, 0);
  low.dispose();
});

// ------------------------------------------------------------------ the shaded look

test("the shaded look lights every face direction differently, tops brightest, undersides darkest", () => {
  const up = modelShade([0, 1, 0]);
  const down = modelShade([0, -1, 0]);
  const sides = [modelShade([-1, 0, 0]), modelShade([0, 0, 1]), modelShade([1, 0, 0]), modelShade([0, 0, -1])];
  for (const s of sides) {
    assert.ok(s < up, "a side is darker than a top");
    assert.ok(s > down, "a side is lighter than an underside");
  }
  // the sun stands front left: the two sides turned to it differ from each other and from the two turned away
  assert.ok(sides[0] > sides[1] && sides[1] > sides[2]);
  assert.equal(sides[2], sides[3], "faces turned away from the sun only get the sky");
  assert.ok(up > 0.85 && up <= 1.05, "a top stays about as light as its colour");
  assert.ok(down > 0.1 && down < 0.35, "an underside is dark, not black");
  for (const n of [[0.6, 0.8, 0], [0, -0.6, 0.8], [0.48, 0.6, 0.64]] as [number, number, number][]) {
    const k = modelShade(n);
    assert.ok(k >= down && k <= up + 1e-9, `${n} lies between underside and top`);
  }
});

test("the feet of walls are darker, fading out within 60 cm; floors and ceilings are not", () => {
  const side: [number, number, number] = [1, 0, 0];
  const free = modelShade(side);
  assert.ok(modelShade(side, 0) < free * 0.75);
  assert.ok(modelShade(side, 0.3) > modelShade(side, 0) && modelShade(side, 0.3) < free);
  assert.equal(modelShade(side, 0.6), free);
  assert.equal(modelShade(side, 2), free);
  assert.equal(modelShade([0, 1, 0], 0), modelShade([0, 1, 0]), "a floor is not darkened");
});

test("the shaded look lifts light greys to white, keeps dark greys and real colours", () => {
  const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const grey = shadedColour([0.5, 0.5, 0.5]);
  assert.ok(grey[0] > 0.8 && grey[0] < 1, "Revit's default grey turns light grey");
  assert.ok(Math.abs(grey[0] - grey[2]) < 1e-9, "a grey stays grey");
  assert.ok(close(shadedColour([0.06, 0.06, 0.07]), [0.06, 0.06, 0.07]), "solar panels stay black");
  assert.ok(close(shadedColour([0.75, 0.525, 0.415]), [0.75, 0.525, 0.415]), "wood stays brown");
  assert.ok(close(shadedColour([1, 1, 1]), [1, 1, 1]));
  assert.ok(shadedColour([0.8, 0.8, 0.8])[0] > shadedColour([0.5, 0.5, 0.5])[0], "the order of greys is kept");
});

test("edges: a box shows its 12 edges, a flat quad its border, a smooth curve none of its seams", () => {
  // a box with shared corners
  const box = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
  const index = new Uint32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  assert.equal(modelEdges(box, index).length / 6, 12, "no diagonals of the faces");
  // the same box with every face's corners on their own (as exporters write flat shading): welded, the same edges
  const split: number[] = [];
  const splitIndex: number[] = [];
  for (const q of quads) {
    const base = split.length / 3;
    for (const v of q) split.push(box[v * 3], box[v * 3 + 1], box[v * 3 + 2]);
    splitIndex.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  assert.equal(modelEdges(new Float32Array(split), new Uint32Array(splitIndex)).length / 6, 12);
  // one flat quad: its four borders
  assert.equal(modelEdges(new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2, 0, 2, 3])).length / 6, 4);
  // a half cylinder in 10° steps: the seams between its strips stay hidden, its two ends and long borders show
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= 18; i++) {
    const a = (i * Math.PI) / 18;
    pos.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 2);
    if (i) idx.push((i - 1) * 2, i * 2, i * 2 + 1, (i - 1) * 2, i * 2 + 1, (i - 1) * 2 + 1);
  }
  assert.equal(modelEdges(new Float32Array(pos), new Uint32Array(idx)).length / 6, 18 * 2 + 2);
  // degenerate input
  assert.equal(modelEdges(new Float32Array(0), new Uint32Array(0)).length, 0);
});

test("the layer finds its edges after it is shown and draws them dark in the shaded look", async () => {
  const parts = readModel(glb(HOUSE));
  let changes = 0;
  const layer = new ModelLayer(parts, {}, FLOORS, { theme: { value: 0 }, lineBlending: AdditiveBlending, low: false, onChange: () => changes++ });
  await layer.edgesDone;
  assert.ok(layer.lines.length > 0 && changes === layer.lines.length);
  assert.ok(layer.lines.every((m) => m.blending === AdditiveBlending), "neon edges glow");
  layer.restyle(true, AdditiveBlending);
  assert.equal(layer.shaded, true);
  assert.ok(layer.lines.every((m) => m.blending === NormalBlending), "dark edges are drawn normally");
  layer.restyle(false, AdditiveBlending);
  assert.ok(layer.lines.every((m) => m.blending === AdditiveBlending));
  layer.dispose();
});
