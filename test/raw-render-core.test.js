const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../media/raw-render-core');

test('4-channel BGGR storage shuffles into RGGB display positions', () => {
  const bytes = new Uint8Array([
    10, 20, 30, 40,
    11, 21, 31, 41,
    12, 22, 32, 42,
    13, 23, 33, 43
  ]);

  const result = core.renderToRgba(bytes, {
    width: 2,
    height: 2,
    channels: 4,
    pattern: 'RGGB',
    channelOrder: 'BGGR',
    bitDepth: 8,
    packing: 'unpacked',
    normalize: false,
    black: 0,
    white: 255,
    gain: 1
  });

  assert.deepEqual([...result.data], [
    40, 0, 0, 255,
    0, 21, 0, 255,
    0, 32, 0, 255,
    0, 0, 13, 255
  ]);
});

test('visible 4-channel samples drive auto normalize range', () => {
  const bytes = new Uint8Array([
    10, 250, 250, 250,
    250, 20, 250, 250,
    250, 250, 30, 250,
    250, 250, 250, 40
  ]);

  const result = core.renderToRgba(bytes, {
    width: 2,
    height: 2,
    channels: 4,
    pattern: 'RGGB',
    channelOrder: 'RGGB',
    bitDepth: 8,
    packing: 'unpacked',
    normalize: true,
    gain: 1
  });

  assert.deepEqual(result.range, { black: 10, white: 40 });
  assert.deepEqual([...result.data], [
    0, 0, 0, 255,
    0, 85, 0, 255,
    0, 170, 0, 255,
    0, 0, 255, 255
  ]);
});

test('MIPI RAW10 packed samples are unpacked correctly', () => {
  const packed = packMipi10([0, 1, 2, 1023]);
  const read = core.makeSampleReader(packed, { packing: 'mipi10' });

  assert.deepEqual([read(0), read(1), read(2), read(3)], [0, 1, 2, 1023]);
});

test('MIPI RAW12 packed samples are unpacked correctly', () => {
  const packed = packMipi12([0x123, 0xabc]);
  const read = core.makeSampleReader(packed, { packing: 'mipi12' });

  assert.deepEqual([read(0), read(1)], [0x123, 0xabc]);
});

test('16-bit endian handling reads unpacked samples correctly', () => {
  const bytes = new Uint8Array([0x34, 0x12, 0x12, 0x34]);

  assert.equal(core.makeSampleReader(bytes, { bitDepth: 16, endian: 'little' })(0), 0x1234);
  assert.equal(core.makeSampleReader(bytes, { bitDepth: 16, endian: 'big' })(1), 0x1234);
});

test('dimension guessing uses filename before byte-derived common sizes', () => {
  const fromName = core.guessDimensions(1, { channels: 1, bitDepth: 8 }, 'frame_1280x720.raw');
  const fromBytes = core.guessDimensions(1920 * 1080 * 4, {
    channels: 4,
    bitDepth: 8,
    packing: 'unpacked'
  }, 'frame.raw');

  assert.deepEqual(fromName, { width: 1280, height: 720, source: 'filename' });
  assert.deepEqual(fromBytes, { width: 1920, height: 1080, source: 'common-size' });
});

test('packed formats imply their effective bit depth and expected size', () => {
  const raw10 = core.normalizeSettings({ width: 4, height: 1, channels: 1, packing: 'mipi10', bitDepth: 8 });
  const raw12 = core.normalizeSettings({ width: 2, height: 1, channels: 1, packing: 'mipi12', bitDepth: 8 });

  assert.equal(raw10.bitDepth, 10);
  assert.equal(raw12.bitDepth, 12);
  assert.equal(core.expectedBytes(raw10), 5);
  assert.equal(core.expectedBytes(raw12), 3);
});

function packMipi10(samples) {
  return Uint8Array.of(
    samples[0] >> 2,
    samples[1] >> 2,
    samples[2] >> 2,
    samples[3] >> 2,
    (samples[0] & 0x03) |
      ((samples[1] & 0x03) << 2) |
      ((samples[2] & 0x03) << 4) |
      ((samples[3] & 0x03) << 6)
  );
}

function packMipi12(samples) {
  return Uint8Array.of(
    samples[0] >> 4,
    samples[1] >> 4,
    (samples[0] & 0x0f) | ((samples[1] & 0x0f) << 4)
  );
}
