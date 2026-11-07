import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCamera2D,
  fitBounds2D,
  formatZoom2D,
  panCamera2D,
  resizeCamera2D,
  screenToWorld,
  worldToScreen,
  zoomCamera2DAt,
} from '../../../src/kit/geometry/camera2d.ts';

test('createCamera2D initializes with scale 1 and given dimensions', () => {
  const camera = createCamera2D(800, 600);
  assert.equal(camera.x, 0);
  assert.equal(camera.y, 0);
  assert.equal(camera.scale, 1.0);
  assert.equal(camera.viewportWidth, 800);
  assert.equal(camera.viewportHeight, 600);
});

test('panCamera2D translates camera by delta pixels', () => {
  const camera = createCamera2D(800, 600);
  const panned = panCamera2D(camera, 50, -30);
  assert.equal(panned.x, 50);
  assert.equal(panned.y, -30);
  assert.equal(panned.scale, 1.0);
});

test('zoomCamera2DAt keeps the world point under the cursor fixed', () => {
  const camera = createCamera2D(800, 600);
  const cursorX = 400;
  const cursorY = 300;

  // World point before zoom
  const worldBefore = screenToWorld(camera, cursorX, cursorY);
  assert.equal(worldBefore.x, 400);
  assert.equal(worldBefore.y, 300);

  // Zoom in by factor 2
  const zoomed = zoomCamera2DAt(camera, cursorX, cursorY, 2.0);
  assert.equal(zoomed.scale, 2.0);

  // World point under cursor should be identical after zoom
  const worldAfter = screenToWorld(zoomed, cursorX, cursorY);
  assert.equal(worldAfter.x, worldBefore.x);
  assert.equal(worldAfter.y, worldBefore.y);
});

test('fitBounds2D centers and scales content to fit within viewport padding', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 500 };
  const camera = fitBounds2D(bounds, 800, 600, 50, 1.0);

  // Available space: width 700, height 500
  // scaleFit: min(700/1000, 500/500) = 0.7
  assert.equal(camera.scale, 0.7);

  // Center of bounds (500, 250) should map to center of viewport (400, 300)
  const centerScreen = worldToScreen(camera, 500, 250);
  assert.ok(Math.abs(centerScreen.x - 400) < 1e-4);
  assert.ok(Math.abs(centerScreen.y - 300) < 1e-4);
});

test('worldToScreen and screenToWorld are exact inverses', () => {
  const camera = { x: 120, y: -45, scale: 1.5, viewportWidth: 800, viewportHeight: 600 };
  const world = { x: 250, y: 180 };
  const screen = worldToScreen(camera, world.x, world.y);
  const back = screenToWorld(camera, screen.x, screen.y);

  assert.ok(Math.abs(back.x - world.x) < 1e-6);
  assert.ok(Math.abs(back.y - world.y) < 1e-6);
});

test('resizeCamera2D preserves scale and translation', () => {
  const camera = { x: 100, y: 50, scale: 1.2, viewportWidth: 800, viewportHeight: 600 };
  const resized = resizeCamera2D(camera, 1024, 768);
  assert.equal(resized.x, 100);
  assert.equal(resized.y, 50);
  assert.equal(resized.scale, 1.2);
  assert.equal(resized.viewportWidth, 1024);
  assert.equal(resized.viewportHeight, 768);
});

test('formatZoom2D formats percentages', () => {
  assert.equal(formatZoom2D(1.0), '100%');
  assert.equal(formatZoom2D(0.654), '65%');
  assert.equal(formatZoom2D(2.5), '250%');
});
