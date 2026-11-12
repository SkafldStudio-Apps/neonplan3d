# rvt-convert

Turns a Revit model (`.rvt`) into NeonPlan 3D inputs:

- `level-<name>.glb`: one GLB per Revit level, `site.glb` for elements without a level.
  Metres, Y up (glTF default), meshopt-compressed (`EXT_meshopt_compression` + `KHR_mesh_quantization`;
  no Draco, no KTX2). three.js needs `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` to read them.
  Every node carries `extras: { dbId, category, level, externalId, name }` from the Revit property database.
- `rooms.json`: `{ levels: [{ name, elevation }], rooms: [{ name, number, level, elevation, polygon: [[x, z], ...] }] }`
  in metres, same frame as the GLBs. Rooms also carry `area`, `externalId` and `dbId`.
- `summary.json` (files, triangles, categories, bounds), `properties.sqlite` (full Revit property database),
  `aec-model-data.json` (levels, grids, reference point), `aps-manifest.json`, `state.json` (resume data), `raw/` (unprocessed glTF).

**The model is uploaded to Autodesk Platform Services** (APS, Model Derivative API) for translation.
Only run it on models whose owner agreed to that. Each run on a new file uses one Model Derivative job
(the free tier allows a limited number of complex jobs per month). At the end the script deletes the
derivatives, the uploaded object and the bucket (transient buckets expire after 24 hours anyway).

## Setup

Dependencies stay out of the repository's `package.json`. Install them anywhere outside the repo and point
`RVT_CONVERT_DEPS` at that folder:

```sh
mkdir -p ~/.cache/rvt-convert && cd ~/.cache/rvt-convert
npm init -y >/dev/null
npm install --ignore-scripts svf-utils@8.0.0 @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer
```

(Or run `npm install` inside `scripts/rvt-convert/`; `node_modules/` is gitignored. Do not commit a lockfile.)

Credentials: an APS app with client credentials (2-legged OAuth). The script reads

| Variable            | Meaning                         |
| ------------------- | ------------------------------- |
| `APS_CLIENT_ID`     | APS app client ID               |
| `APS_CLIENT_SECRET` | APS app client secret           |
| `RVT_CONVERT_DEPS`  | folder with the `node_modules` above (optional) |

Keep the credentials in 1Password and inject them at run time. An env file with references only, outside the repo:

```sh
APS_CLIENT_ID=op://<vault>/<item>/Client_ID
APS_CLIENT_SECRET=op://<vault>/<item>/Client_Secret
```

## Usage

```sh
RVT_CONVERT_DEPS=~/.cache/rvt-convert \
  NODE_USE_ENV_PROXY=1 op run --env-file=/path/to/aps.env -- node --max-old-space-size=16384 scripts/rvt-convert/index.mjs <file.rvt> <outdir>
```

`<outdir>` must be outside the repository (the script refuses otherwise). Floor plans of real houses are never committed.

`NODE_USE_ENV_PROXY=1` makes Node's built-in `fetch` use `HTTPS_PROXY`. Where a proxy is set (a corporate network, the Claude Code sandbox), the script refuses to run without it, so no request goes around a proxy that is meant to check outbound traffic. In the Claude Code sandbox, `developer.api.autodesk.com` must be on the allowed-domains list.

Options:

- `--view <name>`: 3D view to take geometry from (default `{3D}`, else the first non-master view).
- `--center`: shift X/Z so the model is centred on the origin (the offset is written to `rooms.json` and `summary.json`).
- `--keep-remote`: keep bucket, object and derivatives on APS (for example to rerun the local steps).
- `--retranslate`: submit a new job when the previous translation failed.
- `--cleanup-only`: delete the remote data recorded in `<outdir>/state.json` and exit.

Reruns with the same `<outdir>` reuse the upload and the finished translation from `state.json`, so they cost no new job.

## Pipeline

1. 2-legged OAuth (`/authentication/v2/token`).
2. Transient OSS bucket, signed S3 multipart upload (`signeds3upload`), URN = base64url(objectId).
3. Model Derivative job: `svf` (not `svf2`, which svf-utils cannot read), `views: ["3d"]`,
   `advanced.generateMasterViews: true` so the phase master views (which contain Revit rooms) are generated. Poll the manifest every 30 s, up to 60 min.
4. svf-utils downloads the SVF of the `{3D}` view and writes glTF (lines and points dropped); the SVF property database gives category, level, name and external ID per `dbId` (svf-utils names nodes by `dbId`).
5. glTF-Transform: flatten (bakes the unit and axis transform), attach `extras`, split by level, prune, dedup, weld, meshopt.
6. Rooms: Revit Rooms geometry from the master views; the downward-facing faces of each room solid give its footprint (outer loop only, holes dropped).

Level assignment uses the first of these instance properties whose value is a level name:
`Level`, `Base Constraint`, `Reference Level`, `Base Level`, `Schedule Level`, `Work Plane`, walking up to the parent element for nested families.
Level elevations come from the AEC model data (feet, converted to metres, relative to the Revit internal origin).

Coordinate frame: glTF X = Revit X, glTF Y = Revit Z (up), glTF Z = -Revit Y, origin = Revit internal origin
unless `--center` is given.
