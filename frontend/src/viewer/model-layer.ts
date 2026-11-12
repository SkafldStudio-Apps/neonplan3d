// Model layer (spike, behind MODEL_LAYER in flags.ts): a detailed building model (GLB, e.g. exported from Revit or
// converted from IFC) shown with the plan. The plan's rooms stay the interactive, Home-Assistant-linked part; the
// model adds the real geometry (slabs, roof, pergola, pool, stairs, frames).
//
// No GLTFLoader (it would add ~71 KB to the 3D bundle, over its budget): a small reader for what NeonPlan draws –
// positions, indices, node transforms, base colours and the nodes' extras {category, level, name}. Its container and
// accessor logic follows the importer's readGltf (import/mesh.ts). Meshopt-compressed buffers (EXT_meshopt_compression)
// are decoded with meshoptimizer's decoder, which the caller loads lazily as a chunk of its own only when a file
// needs it. Textures, normals and PBR are ignored: the neon looks recolour surfaces in the shader (theme.ts); the light
// looks draw the model's own colours shaded like a CAD viewer (soft sun from one side, a sky above, darker undersides and
// wall feet), lit from the face's direction in the shader – no normals, no lights, no extra shader chunks.
//
// Parts are grouped per NeonPlan floor (from the file they came in, their extras' level, or else their height), so
// they rise, fade and fan out with that floor; a clipping plane cuts what reaches above the opened floor.

import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, NormalBlending, Plane, Quaternion, Uint32BufferAttribute, Vector3, type Blending, type Material } from "three";
import { floorLevelUniform, themed, type ThemeUniform } from "./theme.ts";

/** meshoptimizer's decoder (three/examples/jsm/libs/meshopt_decoder.module.js), as far as it is used here. */
export interface MeshoptDecoderLike {
  ready: Promise<void>;
  decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void;
}

/** One primitive of the model, baked into model space (metres, y up). */
export interface ModelPart {
  name: string;
  /** Revit category or IFC class from the node's extras, normalised to a kind ("other" when unknown). */
  kind: ModelKind;
  /** The level named in the extras (Revit level / IFC storey), "" when none. */
  level: string;
  /** NeonPlan floor id this part belongs to, when the file it came in was given one. */
  floorId?: string;
  positions: Float32Array;
  index: Uint32Array;
  /** Linear base colour and opacity of its material. */
  color: [number, number, number];
  opacity: number;
}

export type ModelKind = "wall" | "slab" | "roof" | "window" | "door" | "glass" | "frame" | "stair" | "rail" | "furniture" | "plant" | "ground" | "water" | "other";

/** Where the model sits in the plan: turned about the vertical (degrees), scaled, then moved (metres). */
export interface ModelPlacement {
  offset?: [number, number, number];
  rotation?: number;
  scale?: number;
}

export interface ModelFile {
  url: string;
  /** The NeonPlan floor this file shows (one GLB per level); without it the parts are sorted by level name or height. */
  floorId?: string;
}

export interface ModelLayerOptions extends ModelPlacement {
  files: ModelFile[];
}

// ------------------------------------------------------------------ reading

const COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** Extensions this reader cannot draw without: the export has to leave them out. */
const BLOCKING: Record<string, string> = { KHR_draco_mesh_compression: "Draco", KHR_texture_basisu: "KTX2" };
const MESHOPT = ["EXT_meshopt_compression", "KHR_meshopt_compression"];

interface Extras {
  category?: unknown;
  level?: unknown;
  name?: unknown;
}
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Extras;
}
interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
}
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: Record<string, { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }>;
}
interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; extras?: Extras; primitives: { attributes: { POSITION?: number }; indices?: number; mode?: number; material?: number }[] }[];
  materials?: { name?: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] }; extensions?: Record<string, unknown> }[];
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

/** The JSON and binary chunk of a GLB (or a .gltf with embedded buffers). */
function container(bytes: Uint8Array): { json: Gltf; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 12 && dv.getUint32(0, true) === 0x46546c67) {
    let json: Gltf | null = null;
    let bin: Uint8Array | null = null;
    for (let p = 12; p + 8 <= bytes.length; ) {
      const len = dv.getUint32(p, true);
      const type = dv.getUint32(p + 4, true);
      const chunk = bytes.subarray(p + 8, p + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
      else if (type === 0x004e4942) bin = chunk;
      p += 8 + len;
    }
    if (!json) throw new Error("model_invalid");
    return { json, bin };
  }
  return { json: JSON.parse(new TextDecoder().decode(bytes)) as Gltf, bin: null };
}

/** Whether a file needs the meshopt decoder (checked before loading the decoder's chunk). */
export function needsMeshopt(bytes: Uint8Array): boolean {
  const { json } = container(bytes);
  return (json.extensionsUsed ?? []).some((e) => MESHOPT.includes(e));
}

/** Revit category ("Walls", "OST_Walls", "Revit Walls") or IFC class ("IfcWallStandardCase") to what is drawn. */
export function modelKind(category: unknown): ModelKind {
  const c = String(category ?? "")
    .toLowerCase()
    .replace(/^(ost_|revit\s+)/, "")
    .replace(/^ifc/, "")
    .replace(/standardcase$|elementedcase$/, "")
    .trim();
  if (!c) return "other";
  if (/^(walls?|structural ?columns?|columns?|structural ?framing|beam|column)$/.test(c)) return "wall";
  if (/^(floors?|slab|ceilings?|covering|structural ?foundations?|footing)$/.test(c)) return "slab";
  if (/^(roofs?|roof|fascias?|gutters?|roof ?soffits?)$/.test(c)) return "roof";
  if (/^windows?$/.test(c)) return "window";
  if (/^doors?$/.test(c)) return "door";
  if (/^(curtain ?panels?|plate|glazing)$/.test(c)) return "glass";
  if (/^(curtain ?wall ?mullions?|member|mullions?)$/.test(c)) return "frame";
  if (/^(stairs?|stairflight|stair ?runs?|stair ?landings?|ramps?|ramp)$/.test(c)) return "stair";
  if (/^(railings?|railing|top ?rails?|handrails?)$/.test(c)) return "rail";
  if (/^(furniture|furniture ?systems|furnishingelement|casework|plumbing ?fixtures|specialty ?equipment|lighting ?fixtures|flowterminal|sanitaryterminal)$/.test(c)) return "furniture";
  if (/^(planting|entourage|geographicelement)$/.test(c)) return "plant";
  if (/^(topography|toposolid|site|hardscape|parking|roads?)$/.test(c)) return "ground";
  if (/^(water|pool|pools)$/.test(c)) return "water";
  return "other";
}

/**
 * The model's primitives in model space. Throws "model_needs_<ext>" for extensions it cannot draw and
 * "model_needs_meshopt" when compressed buffers come without a decoder.
 */
export function readModel(bytes: Uint8Array, decoder?: MeshoptDecoderLike | null): ModelPart[] {
  const { json, bin } = container(bytes);
  for (const e of json.extensionsRequired ?? []) if (BLOCKING[e]) throw new Error(`model_needs_${BLOCKING[e].toLowerCase()}`);
  const buffers = (json.buffers ?? []).map((b, i) => {
    if (i === 0 && bin && !b.uri) return bin;
    const m = b.uri?.match(/^data:[^;]*;base64,(.*)$/);
    // a meshopt fallback buffer has no data of its own; an external file is not supported (export as .glb)
    if (!m) return b.uri ? null : new Uint8Array(0);
    const raw = atob(m[1]);
    const out = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) out[k] = raw.charCodeAt(k);
    return out;
  });
  const views = new Map<number, Uint8Array>();
  const view = (vi: number): Uint8Array => {
    const hit = views.get(vi);
    if (hit) return hit;
    const bv = json.bufferViews![vi];
    const ext = bv.extensions && (bv.extensions.EXT_meshopt_compression ?? bv.extensions.KHR_meshopt_compression);
    let out: Uint8Array;
    if (ext) {
      if (!decoder) throw new Error("model_needs_meshopt");
      const src = buffers[ext.buffer];
      if (!src) throw new Error("model_external");
      out = new Uint8Array(ext.count * ext.byteStride);
      decoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength), ext.mode, ext.filter);
    } else {
      const src = buffers[bv.buffer];
      if (!src) throw new Error("model_external");
      out = src.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    }
    views.set(vi, out);
    return out;
  };
  /** An accessor as floats (normalised integers scaled to 0…1 / -1…1, as the glTF spec says). */
  const floats = (ai: number): { data: Float32Array; comps: number } => {
    const a = json.accessors![ai];
    const comps = COMPS[a.type] ?? 1;
    const data = new Float32Array(a.count * comps);
    if (a.bufferView === undefined) return { data, comps };
    const bytes = view(a.bufferView);
    const size = SIZE[a.componentType] ?? 4;
    const stride = json.bufferViews![a.bufferView].byteStride || comps * size;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = a.byteOffset ?? 0;
    const t = a.componentType;
    const norm = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[t as 5120] ?? 1 : 1;
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * size;
        const v = t === 5126 ? dv.getFloat32(o, true) : t === 5123 ? dv.getUint16(o, true) : t === 5122 ? dv.getInt16(o, true) : t === 5121 ? dv.getUint8(o) : t === 5120 ? dv.getInt8(o) : dv.getUint32(o, true);
        data[i * comps + c] = norm === 1 ? v : Math.max(v / norm, -1);
      }
    return { data, comps };
  };
  const indices = (ai: number): Uint32Array => {
    const a = json.accessors![ai];
    const out = new Uint32Array(a.count);
    if (a.bufferView === undefined) return out;
    const bytes = view(a.bufferView);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = a.byteOffset ?? 0;
    const size = SIZE[a.componentType] ?? 4;
    for (let i = 0; i < a.count; i++) {
      const o = base + i * size;
      out[i] = size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
    }
    return out;
  };
  const colourOf = (mi: number | undefined): { color: [number, number, number]; opacity: number } => {
    const m = mi === undefined ? undefined : json.materials?.[mi];
    const f = m?.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    const glassy = !!m?.extensions?.KHR_materials_transmission || /glass|glas|verglas/i.test(m?.name ?? "");
    const opacity = m?.alphaMode === "BLEND" ? (f[3] ?? 1) : glassy ? 0.35 : 1;
    return { color: [f[0], f[1], f[2]], opacity };
  };

  const parts: ModelPart[] = [];
  const tmp = new Vector3();
  const walk = (ni: number, parent: Matrix4, inherited: Extras) => {
    const n = json.nodes![ni];
    const local = n.matrix?.length === 16 ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])), new Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])), new Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])));
    const world = new Matrix4().multiplyMatrices(parent, local);
    const mesh = n.mesh !== undefined ? json.meshes?.[n.mesh] : undefined;
    // an element's node carries the extras; its geometry often sits in child nodes or in the mesh
    const extras: Extras = { ...inherited, ...(mesh?.extras ?? {}), ...(n.extras ?? {}) };
    if (mesh)
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
        const { data, comps } = floats(prim.attributes.POSITION);
        if (comps !== 3) continue;
        const count = data.length / 3;
        for (let i = 0; i < count; i++) {
          tmp.set(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]).applyMatrix4(world);
          data[i * 3] = tmp.x;
          data[i * 3 + 1] = tmp.y;
          data[i * 3 + 2] = tmp.z;
        }
        let index = prim.indices !== undefined ? indices(prim.indices) : Uint32Array.from({ length: count }, (_, i) => i);
        // a mirrored node turns its faces inside out: flipped back so the winding stays outward
        if (world.determinant() < 0) {
          index = index.slice();
          for (let i = 0; i + 2 < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
        }
        parts.push({ name: String(extras.name ?? n.name ?? mesh.name ?? ""), kind: modelKind(extras.category), level: String(extras.level ?? ""), positions: data, index, ...colourOf(prim.material) });
      }
    for (const c of n.children ?? []) walk(c, world, extras);
  };
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  for (const r of roots) walk(r, new Matrix4(), {});
  return parts;
}

// ------------------------------------------------------------------ sorting onto floors

export interface LayerFloor {
  id: string;
  name: string;
  elevation: number;
  height: number;
}

/** Where a model point lands in the plan (rotation about y, uniform scale, offset). */
export function placementMatrix(p: ModelPlacement): Matrix4 {
  const s = p.scale && p.scale > 0 ? p.scale : 1;
  const [x, y, z] = p.offset ?? [0, 0, 0];
  return new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (-(p.rotation ?? 0) * Math.PI) / 180), new Vector3(s, s, s));
}

/**
 * The floor a part belongs to: its file's floor, else the floor named like its level, else the highest floor
 * whose level lies at or under the part's lowest point (10 cm of slack for slabs that start a little lower).
 */
export function floorOf(part: ModelPart, floors: readonly LayerFloor[], minY: number): string | null {
  if (!floors.length) return null;
  if (part.floorId && floors.some((f) => f.id === part.floorId)) return part.floorId;
  const lv = part.level.trim().toLowerCase();
  if (lv) {
    const named = floors.find((f) => f.name.trim().toLowerCase() === lv || f.id === part.level);
    if (named) return named.id;
  }
  const sorted = [...floors].sort((a, b) => a.elevation - b.elevation);
  let hit = sorted[0];
  for (const f of sorted) if (f.elevation <= minY + 0.1) hit = f;
  return hit.id;
}

// ------------------------------------------------------------------ colours

/** Neon colours per kind (every look maps them in the shader, as for the plan's own geometry). */
const NEON_KIND: Record<ModelKind, number> = {
  wall: 0x131d31,
  slab: 0x0e1629,
  roof: 0x16223a,
  window: 0x1b2c4a,
  door: 0x1a2440,
  glass: 0x1d4b6b,
  frame: 0x22304d,
  stair: 0x15203a,
  rail: 0x2a3b5c,
  furniture: 0x1a2236,
  plant: 0x12391f,
  ground: 0x0b1424,
  water: 0x0d4f7a,
  other: 0x151e33,
};
/** Edges drawn per kind in neon (the plan's cyan, softer on what is not built). */
const EDGE_KIND: Partial<Record<ModelKind, number>> = { wall: 0x37e0ff, slab: 0x37e0ff, roof: 0x37e0ff, stair: 0x37e0ff, rail: 0x5b7cff, window: 0x5b7cff, door: 0x5b7cff, frame: 0x5b7cff, glass: 0x5b7cff, furniture: 0x3a4f80, other: 0x37e0ff, water: 0x37e0ff };

// Base colours are taken as display colours: Revit models converted through Autodesk's viewer format (svf-utils) carry
// the Revit appearance colours unconverted, and the Autodesk viewer shows them as such (wood doors #bf866a stay brown).
const hexOf = (c: readonly number[]) => (Math.round(Math.min(1, Math.max(0, c[0])) * 255) << 16) | (Math.round(Math.min(1, Math.max(0, c[1])) * 255) << 8) | Math.round(Math.min(1, Math.max(0, c[2])) * 255);

/**
 * A model colour as the shaded look draws it: greys from mid-tone up are lifted towards white (Revit's default grey
 * #7f7f7f reads as the light grey of a CAD viewer's solids), dark greys (glass frames, solar panels) and real colours
 * (wood, plaster tints) stay as they are.
 */
export function shadedColour(c: readonly [number, number, number]): [number, number, number] {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  const t = Math.min(1, Math.max(0, (mx - 0.2) / 0.25));
  const lift = 0.7 * t * t * (3 - 2 * t) * (1 - Math.min(1, Math.max(0, (sat - 0.08) / 0.12)));
  return [c[0] + (1 - c[0]) * lift, c[1] + (1 - c[1]) * lift, c[2] + (1 - c[2]) * lift];
}

/** Glass in the shaded look: dark and see-through, as a CAD viewer draws it. */
const SHADED_GLASS = 0x1f2429;
const SHADED_GLASS_OPACITY = 0.38;

// ------------------------------------------------------------------ shading

/** Where the sun comes from in the shaded look (unit vector, y up): high, from the front left. */
export const SHADE_SUN: readonly [number, number, number] = [-0.597, 0.697, 0.398];
/** Light of the sky on faces turned up, of the ground on faces turned down, and how much the sun adds (linear). */
export const SHADE_SKY = 0.7;
export const SHADE_GROUND = 0.2;
export const SHADE_SUN_K = 0.32;
/** How much darker the feet of walls are, fading out over this height (m). */
export const SHADE_AO = 0.3;
export const SHADE_AO_HEIGHT = 0.6;

/**
 * The light on a face of the shaded look (a factor on its linear colour): a sky from above, the ground's darker light
 * from below and a soft sun from one side, so every face direction reads differently. `n`: the face's unit normal;
 * `above`: how far the point lies above its floor (m), for the darker feet of walls (null: no floor). Mirrored by the
 * shader in SHADE_GLSL.
 */
export function modelShade(n: readonly [number, number, number], above: number | null = null): number {
  const sun = Math.max(0, n[0] * SHADE_SUN[0] + n[1] * SHADE_SUN[1] + n[2] * SHADE_SUN[2]);
  let k = SHADE_GROUND + (SHADE_SKY - SHADE_GROUND) * (0.5 + 0.5 * n[1]) + SHADE_SUN_K * sun;
  if (above !== null && Math.abs(n[1]) < 0.5) {
    const t = Math.min(1, Math.max(0, above / SHADE_AO_HEIGHT));
    k *= 1 - SHADE_AO * (1 - t * t * (3 - 2 * t));
  }
  return k;
}

const f = (v: number) => v.toFixed(4);
const SHADE_GLSL = `
uniform float uModelShade;
vec3 fp3dModelShade(vec3 c) {
  vec3 n = fp3dFaceNormal();
  float k = mix(${f(SHADE_GROUND)}, ${f(SHADE_SKY)}, 0.5 + 0.5 * n.y) + ${f(SHADE_SUN_K)} * max(dot(n, vec3(${SHADE_SUN.map(f).join(", ")})), 0.0);
  if (uFloorY > -999.0 && abs(n.y) < 0.5) k *= 1.0 - ${f(SHADE_AO)} * (1.0 - smoothstep(0.0, ${f(SHADE_AO_HEIGHT)}, vFp3dWorld.y - uFloorY));
  c *= k;
  // evening styles: the model dims warm like the house
  if (uStDim > 0.0) c *= mix(vec3(1.0), vec3(0.62, 0.52, 0.42), uStDim) * (1.0 - 0.75 * uStDim);
  return c;
}
`;

/**
 * A themed material that draws shaded (surfaces) or as thin dark lines (edges) while `shade` is 1, and in the look's
 * colours otherwise. Builds on themed()'s patch: same varyings and uniforms, one more branch.
 */
function shadable<T extends Material>(material: T, theme: ThemeUniform, shade: { value: number }, line: boolean): T {
  themed(material, theme, line);
  const before = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uModelShade = shade;
    const call = `fp3dThemed(diffuseColor.rgb, ${line}, true)`;
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", `${SHADE_GLSL}\nvoid main() {`).replace(call, `(uModelShade > 0.5 ? ${line ? "vec3(0.025)" : "fp3dModelShade(diffuseColor.rgb)"} : ${call})`);
  };
  material.customProgramCacheKey = () => `${key()}-model`;
  return material;
}

// ------------------------------------------------------------------ edges

/**
 * The edges worth drawing of one part (flat line pairs): where its faces meet at more than `angle` degrees, and its
 * open borders. Like three's EdgesGeometry, but with vertices welded on a 1 mm grid under number keys, which is several
 * times faster on a model of a million triangles.
 */
export function modelEdges(positions: Float32Array, index: Uint32Array, angle = 28): Float32Array {
  const nv = positions.length / 3;
  if (!nv || index.length < 3) return new Float32Array(0);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, ext = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < x0) x0 = positions[i];
    if (positions[i + 1] < y0) y0 = positions[i + 1];
    if (positions[i + 2] < z0) z0 = positions[i + 2];
  }
  for (let i = 0; i < positions.length; i += 3) ext = Math.max(ext, positions[i] - x0, positions[i + 1] - y0, positions[i + 2] - z0);
  // 1 mm, coarser for parts so big that three coordinates would not fit one safe integer
  const SPAN = 131071;
  const q = Math.max(0.001, ext / SPAN);
  const weld = new Map<number, number>();
  const id = new Uint32Array(nv);
  const first: number[] = [];
  for (let i = 0; i < nv; i++) {
    const k = (Math.round((positions[i * 3] - x0) / q) * (SPAN + 1) + Math.round((positions[i * 3 + 1] - y0) / q)) * (SPAN + 1) + Math.round((positions[i * 3 + 2] - z0) / q);
    let w = weld.get(k);
    if (w === undefined) {
      w = first.length;
      weld.set(k, w);
      first.push(i);
    }
    id[i] = w;
  }
  const cos = Math.cos((angle * Math.PI) / 180);
  const nt = Math.floor(index.length / 3);
  const normals = new Float32Array(nt * 3);
  /** edge key → triangle + 1 that has it so far; -1 once settled */
  const open = new Map<number, number>();
  const out: number[] = [];
  const nw = first.length;
  const emit = (a: number, b: number) => {
    const pa = first[a] * 3;
    const pb = first[b] * 3;
    out.push(positions[pa], positions[pa + 1], positions[pa + 2], positions[pb], positions[pb + 1], positions[pb + 2]);
  };
  for (let t = 0; t < nt; t++) {
    const ia = index[t * 3], ib = index[t * 3 + 1], ic = index[t * 3 + 2];
    const a = id[ia], b = id[ib], c = id[ic];
    if (a === b || b === c || a === c) continue;
    const ux = positions[ib * 3] - positions[ia * 3], uy = positions[ib * 3 + 1] - positions[ia * 3 + 1], uz = positions[ib * 3 + 2] - positions[ia * 3 + 2];
    const vx = positions[ic * 3] - positions[ia * 3], vy = positions[ic * 3 + 1] - positions[ia * 3 + 1], vz = positions[ic * 3 + 2] - positions[ia * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;
    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : e === 1 ? b : c;
      const r = e === 0 ? b : e === 1 ? c : a;
      const key = p < r ? p * nw + r : r * nw + p;
      const other = open.get(key);
      if (other === undefined) open.set(key, t + 1);
      else if (other > 0) {
        const o = (other - 1) * 3;
        if (normals[o] * nx + normals[o + 1] * ny + normals[o + 2] * nz <= cos) emit(p, r);
        open.set(key, -1);
      }
    }
  }
  // borders: edges only one face has
  for (const [key, t] of open) if (t > 0) emit(Math.floor(key / nw), key % nw);
  return new Float32Array(out);
}

// ------------------------------------------------------------------ the layer

interface Batch {
  floorId: string | null;
  kind: ModelKind;
  color: number;
  /** the model's own colour, used by the shaded look */
  own: number;
  opacity: number;
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  edges: LineSegments<BufferGeometry, LineBasicMaterial> | null;
  /** its parts in layer space, kept until its edges are found */
  parts: { pos: Float32Array; index: Uint32Array }[] | null;
  /** its floor's opacity, last set */
  fade: number;
}

export interface LayerOptions {
  theme: ThemeUniform;
  lineBlending: Blending;
  /** The tablet level: no edges (they double what is drawn). */
  low: boolean;
  /** Something new to draw (edges are found after the model is shown). */
  onChange?: () => void;
}

/** Edges are found a little at a time, so a big model never holds the page for long. */
const EDGE_SLICE_MS = 12;

export class ModelLayer {
  readonly group = new Group();
  private readonly perFloor = new Map<string | null, Group>();
  private readonly batches: Batch[] = [];
  /** Cuts what reaches above the opened floor (constant far away while no floor is open). */
  private readonly cut = new Plane(new Vector3(0, -1, 0), 1e6);
  /** 1 while the model is shaded in its own colours (light looks), 0 in the neon looks. */
  private readonly shade = { value: 0 };
  private readonly opt: LayerOptions;
  private blending: Blending;
  private disposed = false;
  readonly triangles: number;
  /** Resolves once every edge is found (at once on the tablet level). */
  readonly edgesDone: Promise<void>;

  constructor(parts: readonly ModelPart[], placement: ModelPlacement, floors: readonly LayerFloor[], opt: LayerOptions) {
    this.opt = opt;
    this.group.name = "fp3d-model-layer";
    this.blending = opt.lineBlending;
    const m = placementMatrix(placement);
    const tmp = new Vector3();
    // one batch per floor, kind and colour: a Revit model's thousands of nodes become a few dozen draw calls
    const groups = new Map<string, { floorId: string | null; kind: ModelKind; own: [number, number, number]; opacity: number; parts: { pos: Float32Array; index: Uint32Array }[] }>();
    let triangles = 0;
    const elevation = new Map(floors.map((f) => [f.id, f.elevation]));
    for (const part of parts) {
      const opacity = Math.round(part.opacity * 20) / 20;
      // fully transparent materials (hidden helpers of the export) are not drawn at all
      if (opacity <= 0) continue;
      const pos = new Float32Array(part.positions.length);
      let minY = Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        tmp.set(part.positions[i], part.positions[i + 1], part.positions[i + 2]).applyMatrix4(m);
        pos[i] = tmp.x;
        pos[i + 1] = tmp.y;
        pos[i + 2] = tmp.z;
        if (tmp.y < minY) minY = tmp.y;
      }
      const floorId = floorOf(part, floors, minY);
      // the floor groups are lifted to their floor's level (as the plan's floors are): parts are kept relative to it
      const base = floorId ? (elevation.get(floorId) ?? 0) : 0;
      if (base) for (let i = 1; i < pos.length; i += 3) pos[i] -= base;
      const own: [number, number, number] = [Math.round(part.color[0] * 64) / 64, Math.round(part.color[1] * 64) / 64, Math.round(part.color[2] * 64) / 64];
      const key = `${floorId}|${part.kind}|${own.join(",")}|${opacity}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { floorId, kind: part.kind, own, opacity, parts: [] }));
      g.parts.push({ pos, index: part.index });
      triangles += part.index.length / 3;
    }
    this.triangles = triangles;
    for (const g of groups.values()) {
      const nPos = g.parts.reduce((s, p) => s + p.pos.length, 0);
      const nIdx = g.parts.reduce((s, p) => s + p.index.length, 0);
      const pos = new Float32Array(nPos);
      const idx = new Uint32Array(nIdx);
      let pOff = 0;
      let iOff = 0;
      for (const p of g.parts) {
        pos.set(p.pos, pOff);
        const v0 = pOff / 3;
        for (let i = 0; i < p.index.length; i++) idx[iOff + i] = p.index[i] + v0;
        pOff += p.pos.length;
        iOff += p.index.length;
      }
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
      geo.setIndex(new Uint32BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const color = NEON_KIND[g.kind];
      const transparent = g.opacity < 0.999;
      const material = shadable(new MeshBasicMaterial({ color, transparent, opacity: g.opacity, depthWrite: !transparent, clippingPlanes: [this.cut], polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), opt.theme, this.shade, false);
      const mesh = new Mesh(geo, material);
      mesh.name = `fp3d-model-${g.kind}`;
      if (transparent) mesh.renderOrder = 4;
      let holder = this.perFloor.get(g.floorId);
      if (!holder) {
        holder = new Group();
        this.perFloor.set(g.floorId, holder);
        this.group.add(holder);
      }
      holder.add(mesh);
      const edged = !opt.low && EDGE_KIND[g.kind] !== undefined;
      this.batches.push({ floorId: g.floorId, kind: g.kind, color, own: hexOf(shadedColour(g.own)), opacity: g.opacity, mesh, edges: null, parts: edged ? g.parts : null, fade: 1 });
    }
    for (const [id, holder] of this.perFloor) holder.position.y = id ? (elevation.get(id) ?? 0) : 0;
    this.restyle(false);
    this.edgesDone = this.findEdges();
  }

  /**
   * Finds the edges part by part, yielding to the page every few milliseconds; a batch's lines appear as soon as they
   * are found. Opaque batches first, the biggest (walls, slabs, the white mass of the model) before the small ones.
   */
  private async findEdges(): Promise<void> {
    const todo = this.batches.filter((b) => b.parts);
    todo.sort((a, b) => Number(a.opacity < 0.999) - Number(b.opacity < 0.999) || b.mesh.geometry.index!.count - a.mesh.geometry.index!.count);
    let slice = performance.now();
    for (const b of todo) {
      const found: Float32Array[] = [];
      let n = 0;
      for (const p of b.parts ?? []) {
        if (performance.now() - slice > EDGE_SLICE_MS) {
          await new Promise((r) => setTimeout(r, 0));
          slice = performance.now();
        }
        if (this.disposed) return;
        const e = modelEdges(p.pos, p.index);
        found.push(e);
        n += e.length;
      }
      b.parts = null;
      if (!n) continue;
      const pos = new Float32Array(n);
      let off = 0;
      for (const e of found) {
        pos.set(e, off);
        off += e.length;
      }
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
      geo.computeBoundingSphere();
      const line = shadable(new LineBasicMaterial({ color: EDGE_KIND[b.kind], transparent: true, opacity: 0.7, blending: this.blending, depthWrite: false, clippingPlanes: [this.cut] }), this.opt.theme, this.shade, true);
      b.edges = new LineSegments(geo, line);
      b.edges.name = `fp3d-model-edges-${b.kind}`;
      b.edges.raycast = () => {};
      this.perFloor.get(b.floorId)?.add(b.edges);
      this.paint(b);
      this.opt.onChange?.();
    }
  }

  /**
   * The look: shaded in the model's own colours with thin dark edges (light looks, natural materials), or the neon
   * kinds' colours that every look maps in the shader. `blending`: the look's line blending (for the neon edges).
   */
  restyle(shaded: boolean, blending: Blending = this.blending): void {
    this.shade.value = shaded ? 1 : 0;
    this.blending = blending;
    for (const b of this.batches) this.paint(b);
  }

  /** Whether the model is drawn shaded now. */
  get shaded(): boolean {
    return this.shade.value === 1;
  }

  /** Colour, opacity and line blending of one batch for the current look and its floor's fade. */
  private paint(b: Batch): void {
    const shaded = this.shaded;
    const glass = b.opacity < 0.999;
    const mat = b.mesh.material;
    // glass turns dark and see-through in the shaded look; the neon looks keep glass and water tinted
    mat.color.setHex(shaded ? (glass ? SHADED_GLASS : b.own) : b.color);
    const o = (shaded && glass ? SHADED_GLASS_OPACITY : b.opacity) * b.fade;
    const transparent = o < 0.999;
    if (mat.transparent !== transparent) {
      mat.transparent = transparent;
      mat.depthWrite = !transparent;
      mat.needsUpdate = true;
    }
    mat.opacity = o;
    if (b.edges) {
      const line = b.edges.material;
      // dark lines are drawn normally: added up they would vanish
      const blend = shaded ? NormalBlending : this.blending;
      if (line.blending !== blend) {
        line.blending = blend;
        line.needsUpdate = true;
      }
      line.opacity = (shaded ? (glass ? 0.25 : 0.5) : 0.7) * b.fade;
    }
  }

  /** The line materials. */
  get lines(): LineBasicMaterial[] {
    return this.batches.flatMap((b) => (b.edges ? [b.edges.material] : []));
  }

  /** Follows one plan floor: its current height (level plus animation offset) and opacity. */
  placeFloor(floorId: string, y: number, opacity: number): void {
    const holder = this.perFloor.get(floorId);
    if (!holder) return;
    holder.position.y = y;
    holder.visible = opacity > 0.02;
    for (const b of this.batches) {
      if (b.floorId !== floorId) continue;
      // the floor's level, for the darker wall feet of the shaded look
      floorLevelUniform(b.mesh.material).value = y;
      b.fade = opacity;
      this.paint(b);
    }
  }

  /** Cut at this height (world y; null: nothing is cut). */
  setCut(y: number | null): void {
    this.cut.constant = y === null ? 1e6 : y;
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.batches) {
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      b.edges?.geometry.dispose();
      b.edges?.material.dispose();
      b.parts = null;
    }
    this.group.removeFromParent();
  }
}
