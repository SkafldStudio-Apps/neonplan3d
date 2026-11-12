/**
 * Features that exist in the code but are not shown yet (not tested enough for a release). Turning a
 * flag on brings back its settings in the editor and the card editor and its display in 3D.
 */
export const SHOW_PRESENCE = false;
/**
 * Model layer (spike): a detailed GLB of the building (Revit/IFC export, metres, y up) shown with the plan. While
 * off, nothing of it runs. On, the 3D view reads its files from `localStorage["neonplan3d-model-layer"]`, e.g.
 * {"files":[{"url":"/local/house-eg.glb","floorId":"floor_1"}],"offset":[-12.4,0,-3.1],"rotation":0}.
 */
export const MODEL_LAYER = false;
