const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../media/raw-render-core');

test('4-channel BGGR storage expands into RGGB Bayer display positions', () => {
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

  assert.equal(result.width, 4);
  assert.equal(result.height, 4);
  assert.deepEqual([...result.data], [
    40, 0, 0, 255,
    0, 20, 0, 255,
    41, 0, 0, 255,
    0, 21, 0, 255,
    0, 30, 0, 255,
    0, 0, 10, 255,
    0, 31, 0, 255,
    0, 0, 11, 255,
    42, 0, 0, 255,
    0, 22, 0, 255,
    43, 0, 0, 255,
    0, 23, 0, 255,
    0, 32, 0, 255,
    0, 0, 12, 255,
    0, 33, 0, 255,
    0, 0, 13, 255
  ]);
});

test('all expanded 4-channel samples drive auto normalize range', () => {
  const bytes = new Uint8Array([
    10, 20, 30, 40
  ]);

  const result = core.renderToRgba(bytes, {
    width: 1,
    height: 1,
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

test('4-channel plane view extracts one shuffled Bayer component', () => {
  const bytes = new Uint8Array([
    10, 20, 30, 40,
    11, 21, 31, 41
  ]);

  const result = core.renderToRgba(bytes, {
    width: 2,
    height: 1,
    channels: 4,
    displayMode: 'r',
    pattern: 'RGGB',
    channelOrder: 'BGGR',
    bitDepth: 8,
    packing: 'unpacked',
    normalize: false,
    black: 0,
    white: 255,
    gain: 1
  });

  assert.equal(result.width, 2);
  assert.equal(result.height, 1);
  assert.deepEqual([...result.data], [
    40, 40, 40, 255,
    41, 41, 41, 255
  ]);
});

test('1-channel Bayer plane view extracts the selected CFA positions', () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const result = core.renderToRgba(bytes, {
    width: 4,
    height: 4,
    channels: 1,
    displayMode: 'g2',
    pattern: 'RGGB',
    bitDepth: 8,
    packing: 'unpacked',
    normalize: false,
    black: 0,
    white: 255,
    gain: 1
  });

  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.deepEqual([...result.data], [
    4, 4, 4, 255,
    6, 6, 6, 255,
    12, 12, 12, 255,
    14, 14, 14, 255
  ]);
});

test('MIPI RAW10 packed samples are unpacked correctly', () => {
  const packed = packMipi10([0, 1, 2, 1023]);
  const read = core.makeSampleReader(packed, { packing: 'mipi10' });

  assert.deepEqual([read(0), read(1), read(2), read(3)], [0, 1, 2, 1023]);
});

test('MIPI RAW12 packed samples are unpacked correctly', () => {
  const packed = packMipi12([0x123, 0xabc]);
  const read = core.makeSampleReader(packed, { packing: 'mipi12', endian: 'big' });

  assert.deepEqual([read(0), read(1)], [0x123, 0xabc]);
});

test('little-endian RAW12 packed samples are unpacked correctly', () => {
  const packed = packRaw12Little([0x123, 0xabc]);
  const read = core.makeSampleReader(packed, { packing: 'mipi12', endian: 'little' });

  assert.deepEqual([read(0), read(1)], [0x123, 0xabc]);
});

test('16-bit endian handling reads unpacked samples correctly', () => {
  const bytes = new Uint8Array([0x34, 0x12, 0x12, 0x34]);

  assert.equal(core.makeSampleReader(bytes, { bitDepth: 16, endian: 'little' })(0), 0x1234);
  assert.equal(core.makeSampleReader(bytes, { bitDepth: 16, endian: 'big' })(1), 0x1234);
});

test('24-bit endian and signed handling reads unpacked samples correctly', () => {
  assert.equal(core.makeSampleReader(Uint8Array.of(0x56, 0x34, 0x12), {
    bitDepth: 24,
    endian: 'little'
  })(0), 0x123456);
  assert.equal(core.makeSampleReader(Uint8Array.of(0x12, 0x34, 0x56), {
    bitDepth: 24,
    endian: 'big'
  })(0), 0x123456);
  assert.equal(core.makeSampleReader(Uint8Array.of(0x00, 0x00, 0x80), {
    bitDepth: 24,
    sampleFormat: 'int',
    endian: 'little'
  })(0), -0x800000);
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

test('NPY HWC array metadata configures an interleaved 4-channel Bayer preview', () => {
  const payload = Uint8Array.of(
    10, 20, 30, 40,
    11, 21, 31, 41,
    12, 22, 32, 42,
    13, 23, 33, 43
  );
  const npy = makeNpy('|u1', [2, 2, 4], payload);
  const prepared = core.prepareInput(npy, {
    pattern: 'RGGB',
    channelOrder: 'BGGR',
    normalize: false,
    white: 255
  }, 'tile.npy');

  assert.equal(prepared.metadata.format, 'npy');
  assert.equal(prepared.settings.width, 2);
  assert.equal(prepared.settings.height, 2);
  assert.equal(prepared.settings.channels, 4);
  assert.equal(prepared.settings.bitDepth, 8);
  assert.equal(prepared.settings.sampleFormat, 'uint');
  assert.equal(prepared.metadata.lockedFields.bitDepth, true);

  const result = core.renderToRgba(prepared.bytes, prepared.settings);
  assert.equal(result.width, 4);
  assert.equal(result.height, 4);
  assert.deepEqual([...result.data], [
    40, 0, 0, 255,
    0, 20, 0, 255,
    41, 0, 0, 255,
    0, 21, 0, 255,
    0, 30, 0, 255,
    0, 0, 10, 255,
    0, 31, 0, 255,
    0, 0, 11, 255,
    42, 0, 0, 255,
    0, 22, 0, 255,
    43, 0, 0, 255,
    0, 23, 0, 255,
    0, 32, 0, 255,
    0, 0, 12, 255,
    0, 33, 0, 255,
    0, 0, 13, 255
  ]);
});

test('NPY float16 dtype is parsed and rendered', () => {
  const payload = Uint8Array.of(
    0x00, 0x00,
    0x00, 0x3c
  );
  const npy = makeNpy('<f2', [1, 2], payload);
  const prepared = core.prepareInput(npy, {
    normalize: false,
    white: 1
  }, 'half.npy');
  const result = core.renderToRgba(prepared.bytes, prepared.settings);

  assert.equal(prepared.settings.bitDepth, 16);
  assert.equal(prepared.settings.sampleFormat, 'float');
  assert.deepEqual([...result.data], [
    0, 0, 0, 255,
    0, 255, 0, 255
  ]);
});

test('NPY CHW array is mapped into RGB logical sample order', () => {
  const payload = Uint8Array.of(
    1, 2, 3, 4,
    10, 20, 30, 40,
    100, 110, 120, 130
  );
  const npy = makeNpy('|u1', [3, 2, 2], payload);
  const prepared = core.prepareInput(npy, {
    normalize: false,
    white: 255
  }, 'chw.npy');
  const result = core.renderToRgba(prepared.bytes, prepared.settings);

  assert.equal(prepared.settings.channels, 3);
  assert.deepEqual([...result.data], [
    1, 10, 100, 255,
    2, 20, 110, 255,
    3, 30, 120, 255,
    4, 40, 130, 255
  ]);
});

test('NPY signed integer dtype is read with signed sample semantics', () => {
  const payload = new Uint8Array(4);
  const view = new DataView(payload.buffer);
  view.setInt16(0, -10, true);
  view.setInt16(2, 20, true);
  const npy = makeNpy('<i2', [1, 2], payload);
  const prepared = core.prepareInput(npy, { normalize: true }, 'signed.npy');
  const result = core.renderToRgba(prepared.bytes, prepared.settings);

  assert.equal(prepared.settings.sampleFormat, 'int');
  assert.deepEqual(result.range, { black: -10, white: 20 });
  assert.deepEqual([...result.data], [
    0, 0, 0, 255,
    0, 255, 0, 255
  ]);
});

test('binary PGM header configures payload offset and image dimensions', () => {
  const pgm = concatBytes(ascii('P5\n# comment\n2 2\n255\n'), Uint8Array.of(0, 64, 128, 255));
  const prepared = core.prepareInput(pgm, {
    pattern: 'RGGB',
    normalize: false,
    white: 255
  }, 'test.pgm');
  const result = core.renderToRgba(prepared.bytes, prepared.settings);

  assert.equal(prepared.metadata.format, 'pgm');
  assert.equal(prepared.settings.width, 2);
  assert.equal(prepared.settings.height, 2);
  assert.equal(prepared.settings.channels, 1);
  assert.equal(prepared.metadata.lockedFields.bitDepth, true);
  assert.deepEqual([...result.data], [
    0, 0, 0, 255,
    0, 64, 0, 255,
    0, 128, 0, 255,
    0, 0, 255, 255
  ]);
});

test('binary PGM max value configures logical bit depth', () => {
  const pgm = concatBytes(ascii('P5\n1 1\n4095\n'), Uint8Array.of(0x0f, 0xff));
  const prepared = core.prepareInput(pgm, {
    pattern: 'RGGB',
    normalize: false
  }, 'test12.pgm');
  const result = core.renderToRgba(prepared.bytes, prepared.settings);

  assert.equal(prepared.settings.bitDepth, 12);
  assert.equal(prepared.settings.white, 4095);
  assert.deepEqual([...result.data], [
    255, 0, 0, 255
  ]);
});

test('raw settings inference recognizes unpacked 24-bit common dimensions', () => {
  const bytes = new Uint8Array(1024 * 768 * 3);
  const guessed = core.guessRawSettings(bytes, {
    width: 1920,
    height: 1080,
    channels: 4,
    bitDepth: 8,
    packing: 'unpacked'
  }, 'night.raw');

  assert.equal(guessed.width, 1024);
  assert.equal(guessed.height, 768);
  assert.equal(guessed.channels, 1);
  assert.equal(guessed.bitDepth, 24);
  assert.equal(guessed.packing, 'unpacked');
});

test('raw settings inference prefers RAW12 packed for sensor-sized buffers', () => {
  const bytes = new Uint8Array(3840 * 2784 * 3 / 2);
  for (let offset = 0; offset < bytes.length; offset += 3) {
    bytes[offset] = 0xd1;
    bytes[offset + 1] = 0x13;
    bytes[offset + 2] = 0x02;
  }
  const guessed = core.guessRawSettings(bytes, {
    width: 1920,
    height: 1080,
    channels: 4,
    bitDepth: 8,
    packing: 'unpacked'
  }, 'day.raw');

  assert.equal(guessed.width, 2880);
  assert.equal(guessed.height, 3712);
  assert.equal(guessed.channels, 1);
  assert.equal(guessed.bitDepth, 12);
  assert.equal(guessed.packing, 'mipi12');
  assert.equal(guessed.endian, 'little');
});

test('raw settings inference overrides stale 24-bit state for RAW12 packed buffers', () => {
  const bytes = new Uint8Array(3840 * 2784 * 3 / 2);
  for (let offset = 0; offset < bytes.length; offset += 3) {
    bytes[offset] = 0x65;
    bytes[offset + 1] = 0x00;
    bytes[offset + 2] = 0x00;
  }
  const guessed = core.guessRawSettings(bytes, {
    width: 2784,
    height: 1920,
    channels: 1,
    bitDepth: 24,
    packing: 'unpacked'
  }, 'night.raw');

  assert.equal(guessed.width, 2880);
  assert.equal(guessed.height, 3712);
  assert.equal(guessed.channels, 1);
  assert.equal(guessed.bitDepth, 12);
  assert.equal(guessed.packing, 'mipi12');
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

function packRaw12Little(samples) {
  return Uint8Array.of(
    samples[0] & 0xff,
    samples[1] & 0xff,
    ((samples[0] >> 8) & 0x0f) | (((samples[1] >> 8) & 0x0f) << 4)
  );
}

function makeNpy(descr, shape, payload) {
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(', ');
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shapeText}), }`;
  const preambleLength = 10;
  const padding = 16 - ((preambleLength + header.length + 1) % 16);
  header = `${header}${' '.repeat(padding === 16 ? 0 : padding)}\n`;
  const output = new Uint8Array(preambleLength + header.length + payload.length);
  output.set(Uint8Array.of(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0), 0);
  output[8] = header.length & 0xff;
  output[9] = header.length >> 8;
  output.set(ascii(header), preambleLength);
  output.set(payload, preambleLength + header.length);
  return output;
}

function ascii(text) {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
