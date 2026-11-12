// Loads meshoptimizer's decoder (its own bundle, see meshopt-entry.ts) the first time a model file needs it.

import type { MeshoptDecoderLike } from "./model-layer.ts";

/** Content hash of the decoder bundle, set by the build (see build.mjs). */
declare const __FP3D_MESHOPT_HASH__: string;

let loading: Promise<MeshoptDecoderLike> | undefined;

export function loadMeshopt(): Promise<MeshoptDecoderLike> {
  const url = new URL(`./neonplan3d-meshopt.js?v=${__FP3D_MESHOPT_HASH__}`, new URL(import.meta.url)).href;
  loading ??= (import(/* @vite-ignore */ url) as Promise<{ MeshoptDecoder: MeshoptDecoderLike }>)
    .then(async (m) => {
      await m.MeshoptDecoder.ready;
      return m.MeshoptDecoder;
    })
    .catch((err: unknown) => {
      loading = undefined;
      throw err;
    });
  return loading;
}
