#!/usr/bin/env node
// Converts a Revit model (.rvt) into NeonPlan 3D inputs: one meshopt-compressed GLB per Revit level
// (plus site.glb for elements without a level) and rooms.json with room footprints.
//
// The .rvt is UPLOADED to Autodesk Platform Services (APS) and translated there with the Model
// Derivative API (SVF), then converted locally with svf-utils and glTF-Transform. See README.md.
//
// Credentials come from the environment only (APS_CLIENT_ID, APS_CLIENT_SECRET), e.g. via
// `op run --env-file=...`. They and the access token are never printed or written to disk.

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const API = "https://developer.api.autodesk.com";
const SCOPES = "data:read data:write data:create bucket:create bucket:read bucket:delete";
const PART_SIZE = 64 << 20; // signed S3 multipart: 5 MB minimum per part (except the last)
const POLL_MS = 30_000;
const POLL_LIMIT_MS = 60 * 60_000;
const NO_LEVEL = "site";

// ---------------------------------------------------------------------------------------------
// CLI

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    view: { type: "string" }, // name of the 3D view to take geometry from (default: "{3D}", else first)
    "keep-remote": { type: "boolean", default: false }, // do not delete bucket, object and derivatives
    "cleanup-only": { type: "boolean", default: false }, // only delete the remote data in state.json
    retranslate: { type: "boolean", default: false }, // submit a new job even if one failed before
    center: { type: "boolean", default: false }, // shift X/Z so the model is centred on the origin
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || positionals.length < 2) {
  console.log("Usage: node scripts/rvt-convert/index.mjs <model.rvt> <outdir> [--view <name>] [--center] [--keep-remote] [--retranslate] [--cleanup-only]");
  console.log("Needs APS_CLIENT_ID and APS_CLIENT_SECRET in the environment. Uploads the model to Autodesk Platform Services.");
  process.exit(opts.help ? 0 : 1);
}

const rvtPath = resolve(positionals[0]);
const outDir = resolve(positionals[1]);
const repoRoot = resolve(import.meta.dirname, "..", "..");
if ((outDir + "/").startsWith(repoRoot + "/")) {
  fail(`Refusing to write into the repository (${outDir}). Client models and derived files stay outside it.`);
}
mkdirSync(outDir, { recursive: true });
const statePath = join(outDir, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET || APS_CLIENT_ID.startsWith("op://")) {
  fail("APS_CLIENT_ID and APS_CLIENT_SECRET must be set (for example with `op run --env-file=...`).");
}
// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, while svf-utils (axios) honours it. Where a
// proxy is configured (a corporate network, a sandbox that checks outbound traffic), every request must go through
// it: never send the client's model past a proxy that is meant to see it.
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxied && process.env.NODE_USE_ENV_PROXY !== "1") {
  fail("HTTPS_PROXY is set but Node's fetch would bypass it. Run again with NODE_USE_ENV_PROXY=1 (Node 22.21+ / 24.5+).");
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------------------------------------------------------------------------------------------
// Dependencies: resolved from RVT_CONVERT_DEPS (a folder with node_modules) or next to this script.

const depsBase = process.env.RVT_CONVERT_DEPS ? join(resolve(process.env.RVT_CONVERT_DEPS), "package.json") : import.meta.filename;
const depRequire = createRequire(depsBase);
const dep = async (name) => {
  try {
    return await import(pathToFileURL(depRequire.resolve(name)).href);
  } catch (err) {
    fail(`Cannot load ${name} (${err.code ?? err.message}). Install the dependencies, see scripts/rvt-convert/README.md.`);
  }
};

// ---------------------------------------------------------------------------------------------
// APS HTTP helpers

let token = null;
async function getToken() {
  if (token && token.expires > Date.now() + 120_000) return token.value;
  const res = await fetch(`${API}/authentication/v2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }),
  });
  if (!res.ok) throw new Error(`Authentication failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return token.value;
}

async function aps(method, path, { body, headers = {}, ok = [], raw = false } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${await getToken()}`, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] ??= "application/json";
  }
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, init);
  if (!res.ok && !ok.includes(res.status)) {
    throw new Error(`${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${await res.text()}`);
  }
  if (raw) return res;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const urnOf = (objectId) => Buffer.from(objectId).toString("base64url");
const enc = encodeURIComponent;

// Downloads one derivative (e.g. the property database) through signed cookies.
async function downloadDerivative(urn, derivativeUrn) {
  const res = await aps("GET", `/modelderivative/v2/designdata/${urn}/manifest/${enc(derivativeUrn)}/signedcookies`, { raw: true });
  const info = await res.json();
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const file = await fetch(info.url, { headers: { Cookie: cookies } });
  if (!file.ok) throw new Error(`Download of ${derivativeUrn} failed: HTTP ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------
// 1-3: bucket and upload

async function upload() {
  const size = statSync(rvtPath).size;
  if (state.objectId && state.uploadedSize === size && state.uploadedName === basename(rvtPath)) {
    log(`Upload: reusing ${state.bucketKey}/${state.objectKey}`);
    return;
  }
  state.bucketKey ??= `np3d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  state.objectKey = basename(rvtPath).replace(/[^A-Za-z0-9._-]/g, "_");
  const bucket = await aps("POST", "/oss/v2/buckets", {
    body: { bucketKey: state.bucketKey, policyKey: "transient" },
    headers: { "x-ads-region": "US" },
    ok: [409],
  });
  if (bucket.status === 409) log(`Bucket ${state.bucketKey} exists already`);
  else log(`Bucket ${state.bucketKey} created (transient, deleted by APS after 24 h)`);
  saveState();

  const parts = Math.ceil(size / PART_SIZE);
  log(`Uploading ${(size / 1e6).toFixed(1)} MB in ${parts} part(s)`);
  const objPath = `/oss/v2/buckets/${state.bucketKey}/objects/${enc(state.objectKey)}/signeds3upload`;
  let uploadKey = null;
  const fh = await open(rvtPath, "r");
  try {
    for (let first = 1; first <= parts; first += 25) {
      const count = Math.min(25, parts - first + 1);
      const q = new URLSearchParams({ parts: String(count), firstPart: String(first), minutesExpiration: "60" });
      if (uploadKey) q.set("uploadKey", uploadKey);
      const { json } = await aps("GET", `${objPath}?${q}`);
      uploadKey = json.uploadKey;
      for (let i = 0; i < count; i++) {
        const part = first + i;
        const start = (part - 1) * PART_SIZE;
        const len = Math.min(PART_SIZE, size - start);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        for (let attempt = 1; ; attempt++) {
          const res = await fetch(json.urls[i], { method: "PUT", body: buf });
          if (res.ok) break;
          if (attempt >= 3) throw new Error(`Upload of part ${part} failed: HTTP ${res.status} ${await res.text()}`);
          log(`Part ${part}: HTTP ${res.status}, retrying`);
        }
        log(`  part ${part}/${parts} uploaded`);
      }
    }
  } finally {
    await fh.close();
  }
  const { json } = await aps("POST", objPath, { body: { uploadKey } });
  state.objectId = json.objectId;
  state.uploadedSize = size;
  state.uploadedName = basename(rvtPath);
  state.urn = urnOf(json.objectId);
  saveState();
  log(`Upload complete, URN ${state.urn}`);
}

// ---------------------------------------------------------------------------------------------
// 4: translation

async function getManifest() {
  const res = await aps("GET", `/modelderivative/v2/designdata/${state.urn}/manifest`, { ok: [404] });
  return res.status === 404 ? null : res.json;
}

const svfDone = (m) => m?.derivatives?.find((d) => d.outputType === "svf");

async function translate() {
  let manifest = await getManifest();
  const failedBefore = manifest && (manifest.status === "failed" || svfDone(manifest)?.status === "failed");
  if (!manifest || !svfDone(manifest) || (failedBefore && opts.retranslate)) {
    const { json } = await aps("POST", "/modelderivative/v2/designdata/job", {
      headers: failedBefore ? { "x-ads-force": "true" } : {},
      body: {
        input: { urn: state.urn },
        output: { formats: [{ type: "svf", views: ["3d"], advanced: { generateMasterViews: true } }] },
      },
    });
    state.jobs = (state.jobs ?? 0) + 1;
    state.jobSubmitted = new Date().toISOString();
    saveState();
    log(`Translation job submitted (result: ${json.result}); jobs submitted for this upload: ${state.jobs}`);
  } else if (failedBefore) {
    throw new Error(`The previous translation failed (use --retranslate to try again): ${JSON.stringify(collectMessages(manifest))}`);
  } else {
    log("Translation: a job exists already, polling its manifest");
  }
  const started = Date.now();
  for (;;) {
    manifest = await getManifest();
    const status = manifest?.status ?? "pending";
    log(`Translation ${status} ${manifest?.progress ?? ""}`);
    if (status === "success") break;
    if (status === "failed" || status === "timeout") {
      throw new Error(`Translation ${status}: ${JSON.stringify(collectMessages(manifest))}`);
    }
    if (Date.now() - started > POLL_LIMIT_MS) {
      throw new Error(`Translation still "${status}" after ${POLL_LIMIT_MS / 60_000} min; run again later to resume polling.`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const warnings = collectMessages(manifest);
  if (warnings.length) log(`Translator messages: ${JSON.stringify(warnings).slice(0, 2000)}`);
  writeFileSync(join(outDir, "aps-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function collectMessages(node, out = []) {
  if (node?.messages) for (const m of node.messages) out.push({ type: m.type, code: m.code, message: m.message });
  for (const c of node?.derivatives ?? node?.children ?? []) collectMessages(c, out);
  return out;
}

function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const c of node.children ?? node.derivatives ?? []) walk(c, fn, node);
}

// ---------------------------------------------------------------------------------------------
// 5: SVF -> glTF and property database

async function svfToGltf(svfUtils, guid, dir, filter) {
  const auth = { getToken: () => getToken() };
  const reader = await svfUtils.SVFReader.FromDerivativeService(state.urn, guid, auth);
  const propdb = await reader.getPropertyDb();
  const scene = await reader.read({ log: () => {}, filter: filter ? (dbid) => filter(dbid, propdb) : undefined });
  const metadata = scene.getMetadata();
  const writer = new svfUtils.GLTFWriter({
    deduplicate: false,
    skipUnusedUvs: true,
    ignoreLineGeometry: true,
    ignorePointGeometry: true,
    center: false,
    log: () => {},
    filter: filter ? (dbid) => filter(dbid, propdb) : () => true,
  });
  rmSync(dir, { recursive: true, force: true });
  await writer.write(scene, dir);
  return { propdb, metadata };
}

// Property lookups. Revit puts most properties on the instance; fragments of nested families can
// hang below it, so we walk up the __parent__ chain until the property shows up.
function makeProps(propdb, levelNames) {
  const cache = new Map();
  const LEVEL_PROPS = ["Level", "Base Constraint", "Reference Level", "Base Level", "Schedule Level", "Work Plane"];
  const read = (id) => {
    const out = { parent: null, category: null, name: null, level: null, props: {} };
    for (const p of propdb.enumerateProperties(id)) {
      if (p.category === "__parent__") out.parent = p.value;
      else if (p.category === "__category__" && p.name === "Category") out.category = p.value;
      else if (p.category === "__name__") out.name = p.value;
      else if (!p.category?.startsWith("__")) out.props[`${p.category}/${p.name}`] = p.value;
    }
    for (const name of LEVEL_PROPS) {
      const hit = Object.entries(out.props).find(([k, v]) => k.endsWith(`/${name}`) && typeof v === "string" && levelNames.has(v));
      if (hit) {
        out.level = hit[1];
        break;
      }
    }
    return out;
  };
  const get = (id) => {
    if (!cache.has(id)) cache.set(id, read(id));
    return cache.get(id);
  };
  return (dbId) => {
    const own = get(dbId);
    let category = own.category, level = own.level, name = own.name;
    for (let p = own.parent, depth = 0; p && depth < 6 && (!category || !level); depth++) {
      const up = get(p);
      category ??= up.category;
      level ??= up.level;
      p = up.parent;
    }
    return { dbId, category, level, name, externalId: propdb._ids?.[dbId] ?? null, props: own.props };
  };
}

// Revit levels with elevations, from the AEC model data or (fallback) from Level elements.
function readLevels(aec, propdb) {
  if (aec?.levels?.length) {
    // AEC model data stores elevations in feet relative to the Revit internal origin.
    return aec.levels.map((l) => ({ name: l.name, elevation: round(l.elevation * 0.3048, 3), source: "aec" }));
  }
  const levels = [];
  for (let id = 1; id < propdb._offsets.length; id++) {
    let cat = null, name = null, elev = null;
    for (const p of propdb.enumerateProperties(id)) {
      if (p.category === "__category__" && p.name === "Category") cat = p.value;
      else if (p.category === "__name__") name = p.value;
      else if (p.name === "Elevation" && typeof p.value === "number") elev = p.value;
    }
    if (cat === "Revit Levels" && name) levels.push({ name, elevation: elev, source: "propdb (units as in the model)" });
  }
  return levels;
}

// ---------------------------------------------------------------------------------------------
// 6: per-level GLBs

async function buildLevels(gt, gltfFile, info, levels) {
  const { core, ext, fn, meshopt } = gt;
  await meshopt.MeshoptEncoder.ready;
  await meshopt.MeshoptDecoder.ready;
  const io = new core.NodeIO()
    .registerExtensions(ext.ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": meshopt.MeshoptEncoder, "meshopt.decoder": meshopt.MeshoptDecoder });

  const base = await io.read(gltfFile);
  await base.transform(fn.flatten()); // bakes the unit/axis root matrix into every node: metres, Y up
  // svf-utils writes one buffer per SVF pack file; a GLB holds exactly one
  await base.transform(fn.unpartition());
  const root = base.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // Annotate and bucket the nodes.
  const groups = new Map();
  const categories = {};
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const node of scene.listChildren()) {
    if (!node.getMesh()) continue;
    const dbId = Number(node.getName());
    const p = info(dbId);
    const level = p.level ?? NO_LEVEL;
    node.setExtras({ dbId, category: p.category, level, externalId: p.externalId, name: p.name });
    if (!groups.has(level)) groups.set(level, new Set());
    groups.get(level).add(dbId);
    const b = fn.getBounds(node);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  // Elements (not fragments) per category.
  const seen = new Set();
  for (const node of scene.listChildren()) {
    const e = node.getExtras();
    if (e?.dbId === undefined || seen.has(e.dbId)) continue;
    seen.add(e.dbId);
    categories[e.category ?? "(none)"] = (categories[e.category ?? "(none)"] ?? 0) + 1;
  }

  const offset = opts.center ? [-(min[0] + max[0]) / 2, 0, -(min[2] + max[2]) / 2] : [0, 0, 0];
  if (opts.center) {
    for (const node of scene.listChildren()) {
      const t = node.getTranslation();
      node.setTranslation([t[0] + offset[0], t[1], t[2] + offset[2]]);
    }
  }

  const order = [...levels.map((l) => l.name).filter((n) => groups.has(n)), ...[...groups.keys()].filter((n) => !levels.some((l) => l.name === n))];
  const files = [];
  for (const level of order) {
    const doc = fn.cloneDocument(base);
    const s = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    for (const node of s.listChildren()) {
      if (node.getExtras()?.level !== level) node.dispose();
    }
    await doc.transform(fn.prune(), fn.dedup(), fn.weld(), fn.prune());
    let triangles = 0, elements = new Set();
    for (const node of s.listChildren()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      elements.add(node.getExtras().dbId);
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const idx = prim.getIndices();
        triangles += (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
      }
    }
    await doc.transform(fn.meshopt({ encoder: meshopt.MeshoptEncoder, level: "medium" }));
    doc.getRoot().getAsset().generator = "neonplan3d rvt-convert (svf-utils + glTF-Transform)";
    const file = `level-${slug(level)}.glb`;
    const name = level === NO_LEVEL ? "site.glb" : file;
    await io.write(join(outDir, name), doc);
    const lv = levels.find((l) => l.name === level);
    files.push({ level, file: name, elevation: lv?.elevation ?? null, elements: elements.size, triangles, bytes: statSync(join(outDir, name)).size });
    log(`  ${name}: ${elements.size} elements, ${triangles} triangles, ${(statSync(join(outDir, name)).size / 1e6).toFixed(2)} MB`);
  }
  return {
    files,
    categories,
    offset,
    bounds: { min: min.map((v, i) => round(v + offset[i], 3)), max: max.map((v, i) => round(v + offset[i], 3)) },
    boundsBeforeOffset: { min: min.map((v) => round(v, 3)), max: max.map((v) => round(v, 3)) },
  };
}

// ---------------------------------------------------------------------------------------------
// 7: rooms

async function buildRooms(gt, gltfFile, info, levels, offset) {
  const { core, ext, fn } = gt;
  const io = new core.NodeIO().registerExtensions(ext.ALL_EXTENSIONS);
  const doc = await io.read(gltfFile);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const byRoom = new Map(); // dbId -> list of world-space triangles
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const dbId = Number(node.getName());
    const m = node.getWorldMatrix();
    const list = byRoom.get(dbId) ?? [];
    byRoom.set(dbId, list);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute("POSITION");
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const v = [0, 0, 0];
      const pt = (i) => {
        pos.getElement(idx ? idx.getScalar(i) : i, v);
        return [
          m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] + offset[0],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] + offset[2],
        ];
      };
      for (let i = 0; i + 2 < n; i += 3) list.push([pt(i), pt(i + 1), pt(i + 2)]);
    }
  });

  const rooms = [];
  for (const [dbId, tris] of byRoom) {
    const p = info(dbId);
    const prop = (name) => Object.entries(p.props).find(([k]) => k.endsWith(`/${name}`))?.[1] ?? null;
    const polygon = footprint(tris);
    if (!polygon) continue;
    const minY = Math.min(...tris.flat().map((q) => q[1]));
    const level = p.level ?? prop("Level");
    rooms.push({
      name: prop("Name") ?? p.name,
      number: prop("Number") != null ? String(prop("Number")) : null,
      level,
      elevation: round(minY, 3),
      levelElevation: levels.find((l) => l.name === level)?.elevation ?? null,
      area: round(Math.abs(signedArea(polygon)), 2),
      externalId: p.externalId,
      dbId,
      polygon: polygon.map(([x, z]) => [round(x, 3), round(z, 3)]),
    });
  }
  rooms.sort((a, b) => (a.elevation - b.elevation) || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  return rooms;
}

// Outline of a room solid on the X/Z plane: boundary edges of its downward-facing triangles,
// chained into loops; the loop with the largest area is the outer boundary (holes are dropped).
function footprint(tris) {
  const key = (q) => `${Math.round(q[0] * 1000)},${Math.round(q[2] * 1000)}`;
  const pts = new Map();
  const edges = new Map();
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || ny / len > -0.95) continue; // keep the floor (normal pointing down)
    const ks = [a, b, c].map((q) => {
      const k = key(q);
      pts.set(k, [q[0], q[2]]);
      return k;
    });
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (let i = 0; i < 3; i++) {
      const e1 = ks[i], e2 = ks[(i + 1) % 3];
      const id = e1 < e2 ? `${e1}|${e2}` : `${e2}|${e1}`;
      const prev = edges.get(id);
      edges.set(id, prev ? { ...prev, count: prev.count + 1 } : { from: e1, to: e2, count: 1 });
    }
  }
  const next = new Map();
  for (const e of edges.values()) if (e.count === 1) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const loops = [];
  const used = new Set();
  for (const start of next.keys()) {
    for (const first of next.get(start)) {
      if (used.has(`${start}>${first}`)) continue;
      const loop = [start];
      let nxt = first;
      used.add(`${start}>${first}`);
      for (let guard = 0; nxt !== start && guard < 100000; guard++) {
        loop.push(nxt);
        const cand = (next.get(nxt) ?? []).find((t) => !used.has(`${nxt}>${t}`));
        if (!cand) break;
        used.add(`${nxt}>${cand}`);
        nxt = cand;
      }
      if (nxt === start && loop.length >= 3) loops.push(simplify(loop.map((k) => pts.get(k))));
    }
  }
  if (!loops.length) return null;
  loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const outer = loops[0];
  return signedArea(outer) < 0 ? outer.reverse() : outer;
}

// Drops collinear points (Revit tessellates long straight walls into several edges).
function simplify(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  return out.length >= 3 ? out : poly;
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

const round = (v, d) => (v == null ? v : Math.round(v * 10 ** d) / 10 ** d);
const slug = (s) => s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "unnamed";

// ---------------------------------------------------------------------------------------------
// Cleanup

async function cleanup() {
  if (!state.bucketKey) return log("Cleanup: nothing recorded in state.json");
  const results = [];
  if (state.urn) {
    const r = await aps("DELETE", `/modelderivative/v2/designdata/${state.urn}/manifest`, { ok: [404] }).catch((e) => ({ error: e.message }));
    results.push(`derivatives: ${r.error ?? `HTTP ${r.status}`}`);
  }
  if (state.objectKey) {
    const r = await aps("DELETE", `/oss/v2/buckets/${state.bucketKey}/objects/${enc(state.objectKey)}`, { ok: [404] }).catch((e) => ({ error: e.message }));
    results.push(`object: ${r.error ?? `HTTP ${r.status}`}`);
  }
  const r = await aps("DELETE", `/oss/v2/buckets/${state.bucketKey}`, { ok: [404] }).catch((e) => ({ error: e.message }));
  results.push(`bucket: ${r.error ?? `HTTP ${r.status}`}`);
  log(`Cleanup: ${results.join("; ")}`);
  state.cleanedUp = new Date().toISOString();
  state.cleanupResults = results;
  saveState();
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  if (opts["cleanup-only"]) return cleanup();
  if (!existsSync(rvtPath)) fail(`No such file: ${rvtPath}`);

  await upload();
  const manifest = await translate();

  // Viewables: 3D SVF graphics plus their parent geometry node (which carries the view name).
  const views = [];
  let pdbUrn = null, aecUrn = null;
  walk(manifest, (node, parent) => {
    if (node.type === "resource" && node.role === "graphics" && node.mime === "application/autodesk-svf") {
      views.push({ guid: node.guid, name: parent?.name ?? node.name, master: Boolean(parent?.isMasterView), parentGuid: parent?.guid });
    }
    if (node.role === "Autodesk.CloudPlatform.PropertyDatabase") pdbUrn ??= node.urn;
    if (node.role === "Autodesk.AEC.ModelData") aecUrn ??= node.urn;
  });
  log(`3D views: ${views.map((v) => `${v.name}${v.master ? " (master)" : ""}`).join(", ")}`);
  if (!views.length) throw new Error("The manifest has no SVF 3D views.");

  if (pdbUrn) {
    writeFileSync(join(outDir, "properties.sqlite"), await downloadDerivative(state.urn, pdbUrn));
    log("Property database saved as properties.sqlite");
  }
  let aec = null;
  if (aecUrn) {
    aec = JSON.parse((await downloadDerivative(state.urn, aecUrn)).toString("utf8"));
    writeFileSync(join(outDir, "aec-model-data.json"), JSON.stringify(aec, null, 2));
    log(`AEC model data: ${aec.levels?.length ?? 0} levels`);
  }

  const svfUtils = await dep("svf-utils");
  const gt = {
    core: await dep("@gltf-transform/core"),
    ext: await dep("@gltf-transform/extensions"),
    fn: await dep("@gltf-transform/functions"),
    meshopt: await dep("meshoptimizer"),
  };

  const main3d = (opts.view && views.find((v) => v.name === opts.view)) || views.find((v) => v.name === "{3D}") || views.find((v) => !v.master) || views[0];
  if (opts.view && main3d.name !== opts.view) log(`View "${opts.view}" not found, using "${main3d.name}"`);
  log(`Geometry from view "${main3d.name}" (${main3d.guid}), downloading SVF...`);
  const rawDir = join(outDir, "raw", main3d.guid);
  const { propdb, metadata } = await svfToGltf(svfUtils, main3d.guid, rawDir);
  log(`SVF units: ${metadata["distance unit"]?.value}, up ${JSON.stringify(metadata["world up vector"]?.XYZ)}, front ${JSON.stringify(metadata["world front vector"]?.XYZ)}`);

  const levels = readLevels(aec, propdb);
  const info = makeProps(propdb, new Set(levels.map((l) => l.name)));
  log(`Levels: ${levels.map((l) => `${l.name} @ ${l.elevation}`).join(", ")}`);

  log("Building per-level GLBs...");
  const result = await buildLevels(gt, join(rawDir, "output.gltf"), info, levels);

  // Rooms live in the master views (generateMasterViews). Take the master view with most rooms.
  const isRoom = (dbId, db) => {
    for (const p of db.enumerateProperties(dbId)) {
      if (p.category === "__category__" && p.name === "Category") return p.value === "Revit Rooms";
    }
    return false;
  };
  let rooms = [], roomView = null, roomNote = null;
  const roomViews = [main3d, ...views.filter((v) => v.master && v.guid !== main3d.guid)];
  for (const view of roomViews) {
    const dir = join(outDir, "raw", `${view.guid}-rooms`);
    log(`Looking for rooms in view "${view.name}"...`);
    try {
      await svfToGltf(svfUtils, view.guid, dir, isRoom);
      const found = await buildRooms(gt, join(dir, "output.gltf"), info, levels, result.offset);
      log(`  ${found.length} rooms`);
      if (found.length > rooms.length) {
        rooms = found;
        roomView = view.name;
      }
    } catch (err) {
      log(`  no room geometry (${err.message})`);
    }
  }
  if (!rooms.length) roomNote = "No Revit Rooms geometry in any 3D view of the derivative.";

  const roomsJson = {
    units: "m",
    frame: "glTF: X = Revit X (east), Y = Revit Z (up), Z = -Revit Y; Revit internal origin" + (opts.center ? ", shifted by offset" : ""),
    offset: result.offset,
    source: { file: basename(rvtPath), roomView, note: roomNote },
    levels: levels.map(({ name, elevation }) => ({ name, elevation })),
    rooms,
  };
  writeFileSync(join(outDir, "rooms.json"), JSON.stringify(roomsJson, null, 2));

  const summary = {
    source: basename(rvtPath),
    urn: state.urn,
    geometryView: main3d.name,
    views: views.map((v) => ({ name: v.name, guid: v.guid, master: v.master })),
    units: "m",
    upAxis: "Y",
    svfMetadata: {
      distanceUnit: metadata["distance unit"]?.value,
      up: metadata["world up vector"]?.XYZ,
      front: metadata["world front vector"]?.XYZ,
      worldBoundingBox: metadata["world bounding box"],
      refPointTransform: aec?.refPointTransformation ?? null,
    },
    offset: result.offset,
    bounds: result.bounds,
    levels,
    files: result.files,
    categories: Object.fromEntries(Object.entries(result.categories).sort((a, b) => b[1] - a[1])),
    rooms: { count: rooms.length, view: roomView, note: roomNote },
    apsJobsSubmitted: state.jobs ?? 0,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`Wrote ${result.files.length} GLB(s), rooms.json (${rooms.length} rooms) and summary.json to ${outDir}`);

  if (!opts["keep-remote"]) await cleanup();
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
