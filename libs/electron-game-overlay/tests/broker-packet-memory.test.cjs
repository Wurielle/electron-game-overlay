const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BrokerPacketDecoder,
  encodeBrokerFramePacket,
  encodeBrokerJsonPacket,
} = require('../dist/lib/overlay-broker-protocol.js');

test('consuming a broker frame releases the decoder backing allocation', () => {
  const decoder = new BrokerPacketDecoder();
  const packet = encodeBrokerFramePacket(1, 1024, 512, Buffer.alloc(1024 * 512 * 4, 0x5a));
  const decoded = decoder.push(packet);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].frame.pixels[0], 0x5a);
  assert.equal(decoder.buffer.length, 0);
  assert.equal(decoder.buffer.buffer.byteLength, 0, 'empty decoder must not retain the consumed frame allocation');
});

test('a small incomplete next packet cannot pin the preceding frame allocation', () => {
  const decoder = new BrokerPacketDecoder();
  const frame = encodeBrokerFramePacket(1, 1024, 512, Buffer.alloc(1024 * 512 * 4, 0x5a));
  const value = { type: 'broker.input.intercept', intercept: true };
  const control = encodeBrokerJsonPacket(value);
  const decoded = decoder.push(Buffer.concat([frame, control.subarray(0, 3)]));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].frame.pixels[0], 0x5a);
  assert.equal(decoder.buffer.length, 3);
  assert.notEqual(decoder.buffer.buffer, decoded[0].frame.pixels.buffer, 'small tail must own storage independent of the consumed frame');
  const rest = decoder.push(control.subarray(3));
  assert.deepEqual(rest, [{ kind: 'json', value }]);
  assert.equal(decoder.buffer.buffer.byteLength, 0);
});
