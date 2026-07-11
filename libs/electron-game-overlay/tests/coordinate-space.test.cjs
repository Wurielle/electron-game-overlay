const assert = require('node:assert/strict');
const test = require('node:test');

const {
  dipExtentToPhysical,
  dipPlacementToPhysical,
  dipRectToPhysical,
  physicalInputToDip,
} = require('../dist/lib/coordinate-space.js');

const scaleMatrix = [1, 1.25, 1.5, 2];

test('DIP extents use Electron 16 OSR floor sizing', () => {
  const cases = [
    { dip: 0, physical: [0, 0, 0, 0] },
    { dip: 0.9, physical: [0, 1, 1, 1] },
    { dip: 7.75, physical: [7, 9, 11, 15] },
    { dip: 100, physical: [100, 125, 150, 200] },
    { dip: 319.9, physical: [319, 399, 479, 639] },
  ];

  for (const { dip, physical } of cases) {
    scaleMatrix.forEach((scaleFactor, index) => {
      assert.equal(
        dipExtentToPhysical(dip, scaleFactor),
        physical[index],
        `${dip} DIP at ${scaleFactor}x`,
      );
    });
  }
});

test('signed DIP placement rounds halves away from zero', () => {
  const cases = [
    { dip: 10.4, scaleFactor: 1, physical: 10 },
    { dip: 10.5, scaleFactor: 1, physical: 11 },
    { dip: -10.4, scaleFactor: 1, physical: -10 },
    { dip: -10.5, scaleFactor: 1, physical: -11 },
    { dip: 0.4, scaleFactor: 1.25, physical: 1 },
    { dip: -0.4, scaleFactor: 1.25, physical: -1 },
    { dip: -101.2, scaleFactor: 1.5, physical: -152 },
    { dip: -50.25, scaleFactor: 2, physical: -101 },
  ];

  for (const { dip, scaleFactor, physical } of cases) {
    assert.equal(
      dipPlacementToPhysical(dip, scaleFactor),
      physical,
      `${dip} DIP at ${scaleFactor}x`,
    );
  }

  assert.equal(Object.is(dipPlacementToPhysical(-0.1, 1), -0), false);
});

test('DIP rectangles apply signed placement and floored extents separately', () => {
  assert.deepEqual(
    dipRectToPhysical(
      { x: -101.2, y: -0.4, width: 319.9, height: 220.75 },
      1.25,
    ),
    { x: -127, y: -1, width: 399, height: 275 },
  );

  assert.deepEqual(
    dipRectToPhysical({ x: 12.5, y: -12.5, width: 640.5, height: 360.5 }, 2),
    { x: 25, y: -25, width: 1281, height: 721 },
  );
});

test('physical overlay-local input maps to the nearest signed DIP', () => {
  const cases = [
    { physical: 11, scaleFactor: 1, dip: 11 },
    { physical: 13, scaleFactor: 1.25, dip: 10 },
    { physical: 15, scaleFactor: 1.5, dip: 10 },
    { physical: 21, scaleFactor: 2, dip: 11 },
    { physical: -13, scaleFactor: 1.25, dip: -10 },
    { physical: -15, scaleFactor: 1.5, dip: -10 },
    { physical: -21, scaleFactor: 2, dip: -11 },
    { physical: 1, scaleFactor: 2, dip: 1 },
    { physical: -1, scaleFactor: 2, dip: -1 },
  ];

  for (const { physical, scaleFactor, dip } of cases) {
    assert.equal(
      physicalInputToDip(physical, scaleFactor),
      dip,
      `${physical}px at ${scaleFactor}x`,
    );
  }

  assert.equal(Object.is(physicalInputToDip(-0.1, 1), -0), false);
});
