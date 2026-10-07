import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitGrid, MIN_TILE_WIDTH } from './stage-layout.ts';

const GAP = 16;

test('one person on a laptop fills the stage in a single column', () => {
  const fit = fitGrid(1, 1200, 700, GAP);
  assert.deepEqual(fit, { cols: 1, tileWidth: 1200, tileHeight: 700, scroll: false });
});

test('two people on a portrait phone stack in one column', () => {
  const fit = fitGrid(2, 360, 640, GAP);
  assert.equal(fit.cols, 1);
  assert.equal(fit.scroll, false);
});

test('two people on a laptop sit side by side', () => {
  const fit = fitGrid(2, 1200, 700, GAP);
  assert.equal(fit.cols, 2);
});

test('four people make a 2x2 grid', () => {
  const fit = fitGrid(4, 1200, 700, GAP);
  assert.equal(fit.cols, 2);
});

test('twenty people on desktop make five columns and never scroll', () => {
  const fit = fitGrid(20, 1200, 700, GAP);
  assert.equal(fit.cols, 5);
  assert.equal(fit.scroll, false);
});

test('twenty people on a small phone scroll, with every tile at least MIN_TILE_WIDTH wide', () => {
  const fit = fitGrid(20, 288, 500, GAP);
  assert.equal(fit.scroll, true);
  assert.ok(fit.tileWidth >= MIN_TILE_WIDTH, `tileWidth ${fit.tileWidth} should be >= ${MIN_TILE_WIDTH}`);
});

test('no people, or a zero-sized stage, is safe: 1 column and no NaN', () => {
  for (const fit of [fitGrid(0, 1200, 700, GAP), fitGrid(4, 0, 700, GAP), fitGrid(4, 1200, 0, GAP)]) {
    assert.equal(fit.cols, 1);
    for (const value of [fit.tileWidth, fit.tileHeight]) {
      assert.equal(Number.isFinite(value), true);
      assert.ok(value >= 0);
    }
  }
});

test('the aspect-ratio clamp keeps a lone wide tile from exceeding 16:9', () => {
  const fit = fitGrid(1, 2000, 400, GAP);
  assert.ok(fit.tileWidth <= Math.floor((400 * 16) / 9));
});
