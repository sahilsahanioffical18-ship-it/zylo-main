// Grid math for the video stage, free of React and LiveKit so node --test can run it.
// Zero local imports (tsconfig: bundler resolution, tests import ./x.ts).

export const MIN_TILE_WIDTH = 120;

export type GridFit = { cols: number; tileWidth: number; tileHeight: number; scroll: boolean };

/**
 * Picks the column count whose tile area is largest, tried across every possible
 * count rather than a table of sm:/lg: breakpoints. One rule this way already covers
 * a portrait phone (2 people stack), a landscape tablet and a desktop (2 people sit
 * side by side), because it reasons about the stage's actual pixels instead of
 * guessing from viewport width.
 */
export function fitGrid(count: number, width: number, height: number, gap: number): GridFit {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, tileWidth: 0, tileHeight: 0, scroll: false };
  }

  let best: GridFit | null = null;
  let bestArea = -1;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    let w = (width - (cols - 1) * gap) / cols;
    let h = (height - (rows - 1) * gap) / rows;
    if (w <= 0 || h <= 0) continue;

    // The video is object-cover, so crop instead of letterbox: shrink whichever
    // side pushes the ratio outside 3:4..16:9 rather than shrinking both.
    if (w / h > 16 / 9) {
      w = h * (16 / 9);
    } else if (w / h < 3 / 4) {
      h = w * (4 / 3);
    }

    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = { cols, tileWidth: Math.floor(w), tileHeight: Math.floor(h), scroll: false };
    }
  }

  if (!best || best.tileWidth < MIN_TILE_WIDTH) {
    // ponytail: scrolls instead of showing a "+N more" tile once tiles would drop
    // below MIN_TILE_WIDTH. Only happens with lots of people on a small phone.
    // Upgrade: cap visible tiles and add a "+N" tile if that's ever needed.
    const cols = Math.min(count, Math.max(1, Math.floor((width + gap) / (MIN_TILE_WIDTH + gap))));
    const w = (width - (cols - 1) * gap) / cols;
    const h = (w * 9) / 16;
    best = { cols, tileWidth: Math.floor(w), tileHeight: Math.floor(h), scroll: true };
  }

  return best;
}
