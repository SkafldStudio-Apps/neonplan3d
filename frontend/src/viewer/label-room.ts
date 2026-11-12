/** A room label on screen: centre, size in px, and its rank (the room's floor area: bigger rooms keep their names). */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
}

/**
 * Which room labels show: where labels would cover each other on screen, the bigger room keeps its name and the
 * smaller one gives way (a house of 40 rooms with closets and WCs otherwise piles its names into an unreadable
 * stack). `gap` px stay free between two shown labels. Equal ranks keep the plan's order, so the choice is the
 * same every frame. A few dozen labels: the pairwise check costs less than placing them.
 */
export function roomLabelsShown(boxes: readonly LabelBox[], gap = 4): boolean[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].rank - boxes[a].rank || a - b);
  const shown = new Array<boolean>(boxes.length).fill(false);
  const kept: LabelBox[] = [];
  for (const i of order) {
    const a = boxes[i];
    const free = kept.every((b) => Math.abs(a.x - b.x) * 2 >= a.w + b.w + gap * 2 || Math.abs(a.y - b.y) * 2 >= a.h + b.h + gap * 2);
    if (!free) continue;
    shown[i] = true;
    kept.push(a);
  }
  return shown;
}
