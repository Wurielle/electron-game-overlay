'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { encodeFrameTransportPacket } = require('../dist/lib/overlay-loopback-transport.js');
const filename = path.join(__dirname, 'native-pointer.acceptance.cjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['describeSourceRaster', 'describeSourceImage', 'readPublishedDiagnostics']);
const definitions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(definitions.length, 3);
const diagnostics = vm.runInNewContext(definitions.map(node => node.getText(source)).join('\n') + '\n({describeSourceRaster,describeSourceImage,readPublishedDiagnostics})', {
  Buffer, createHash,
  readNativeImageRaster: image => image.raster,
});
const css = { x: 20, y: 60, width: 600, height: 480 };
function raster(scale) {
  const width = Math.round(css.width * scale), height = Math.round(css.height * scale);
  const bitmap = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) bitmap.set([68, 48, 24, 255], offset);
  bitmap.set([53, 57, 229, 255], (Math.floor(40 * scale) * width + Math.floor(460 * scale)) * 4);
  bitmap.set([229, 136, 30, 255], (Math.floor(40 * scale) * width + Math.floor(520 * scale)) * 4);
  return { width, height, bitmap, scaleFactor: 1 };
}

test('actual source diagnostic uses true750-pixel stride and CSS/raster ratio instead of representation scale1', () => {
  const actual = raster(1.25);
  const image = { raster: actual, getSize: () => ({ width: 750, height: 600 }), getScaleFactors: () => [1] };
  const evidence = diagnostics.describeSourceImage(image, css);
  assert.equal(evidence.stride, 3000);
  assert.equal(evidence.scaleX, 1.25);
  assert.equal(evidence.scaleY, 1.25);
  assert.equal(evidence.representationScaleFactor, 1);
  assert.equal(evidence.calibration.red.x, 575);
  assert.equal(evidence.calibration.red.y, 50);
  assert.deepEqual([...evidence.calibration.red.bgra], [53, 57, 229, 255]);
  assert.deepEqual([...evidence.calibration.blue.bgra], [229, 136, 30, 255]);
  assert.equal(evidence.bitmapSha256, createHash('sha256').update(actual.bitmap).digest('hex'));
  assert.notDeepEqual([...actual.bitmap.subarray((40 * 600 + 460) * 4, (40 * 600 + 460) * 4 + 4)], [...evidence.calibration.red.bgra]);
  const larger = diagnostics.describeSourceRaster(raster(1.5), css);
  assert.equal(larger.width, 900);
  assert.equal(larger.stride, 3600);
  assert.deepEqual([...larger.calibration.red.bgra], [53, 57, 229, 255]);
});

test('actual retained transport diagnostic records unchanged rect and exact published frame bytes without credentials', () => {
  const actual = raster(1.25);
  const packet = encodeFrameTransportPacket(1, actual.width, actual.height, actual.bitmap);
  const metadata = { type: 'window', windowId: 1, rect: { x: 25, y: 75, width: 750, height: 600 }, scaleFactorMicros: 1250000 };
  const backend = { windows: new Map([[1, metadata]]), latestFrames: new Map([[1, packet]]), token: 'not-evidence' };
  const original = Buffer.from(packet);
  const evidence = diagnostics.readPublishedDiagnostics(backend, 1, css);
  assert.equal(evidence.window.rect.width, 750);
  assert.equal(evidence.window.scaleFactorMicros, 1250000);
  assert.equal(evidence.frame.bitmapSha256, createHash('sha256').update(actual.bitmap).digest('hex'));
  assert.deepEqual([...evidence.frame.calibration.red.bgra], [53, 57, 229, 255]);
  assert.deepEqual(packet, original);
  assert.equal(JSON.stringify(evidence).includes('not-evidence'), false);
  assert.equal(diagnostics.readPublishedDiagnostics(undefined, 1, css).frame, null);
  const malformed = Buffer.from(packet); malformed.writeUInt32LE(2, 5);
  assert.throws(() => diagnostics.readPublishedDiagnostics({ latestFrames: new Map([[1, malformed]]) }, 1, css), /malformed/u);
  assert.throws(() => diagnostics.describeSourceRaster({ ...actual, width: 600 }, css), /Invalid diagnostic/u);
});
