import assert from "node:assert/strict";
import { test } from "node:test";
import { roomLabelsShown, type LabelBox } from "./label-room.ts";

const box = (x: number, y: number, rank: number, w = 100, h = 24): LabelBox => ({ x, y, w, h, rank });

test("labels apart from each other all show", () => {
  assert.deepEqual(roomLabelsShown([box(100, 100, 30), box(300, 100, 2), box(100, 300, 1)]), [true, true, true]);
});

test("of two overlapping labels the bigger room keeps its name", () => {
  // the closet comes first in the list, the living room wins anyway
  assert.deepEqual(roomLabelsShown([box(100, 100, 2), box(140, 110, 30)]), [false, true]);
});

test("a stack of labels in a dense house leaves one readable label per spot", () => {
  const pile = Array.from({ length: 40 }, (_, i) => box(400 + (i % 3) * 5, 300 + i * 3, 2 + (i % 7)));
  const shown = roomLabelsShown(pile);
  // the pile spans 117 px in height: at most five 24 px labels (with their gaps) fit in it
  const kept = pile.filter((_, i) => shown[i]);
  assert.ok(kept.length >= 1 && kept.length <= 5, `${kept.length} labels kept`);
  // what stays never covers another shown label
  for (const a of kept) for (const b of kept) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= a.w || Math.abs(a.y - b.y) >= a.h);
  // the biggest room in the pile is among them
  assert.ok(kept.some((b) => b.rank === 8));
});

test("labels that only touch at the gap keep both, the gap keeps names from sticking together", () => {
  // boxes are centred: 100 px wide labels 104 px apart leave 4 px between them
  assert.deepEqual(roomLabelsShown([box(100, 100, 5), box(204, 100, 4)], 4), [true, true]);
  assert.deepEqual(roomLabelsShown([box(100, 100, 5), box(203, 100, 4)], 4), [true, false]);
});

test("equal rooms: the first in the plan wins, so the choice does not flicker between frames", () => {
  assert.deepEqual(roomLabelsShown([box(100, 100, 6), box(120, 100, 6)]), [true, false]);
  assert.deepEqual(roomLabelsShown([box(120, 100, 6), box(100, 100, 6)]), [true, false]);
});

test("a hidden label does not block others", () => {
  // the big room's label is chained out by nothing, the middle one gives way, the third is free again
  assert.deepEqual(roomLabelsShown([box(100, 100, 30), box(180, 100, 10), box(260, 100, 5)]), [true, false, true]);
});

test("no labels, nothing to do", () => {
  assert.deepEqual(roomLabelsShown([]), []);
});
