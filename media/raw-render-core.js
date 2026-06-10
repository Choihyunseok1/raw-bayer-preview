(function initRawBayerRenderCore(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RawBayerRenderCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRawBayerRenderCore() {
  'use strict';

  const PATTERNS = ['RGGB', 'BGGR', 'GRBG', 'GBRG'];
  const PACKINGS = ['unpacked', 'mipi10', 'mipi12'];
  const BIT_DEPTHS = [8, 10, 12, 14, 16, 32];
  const CHANNELS = [1, 3, 4];
  const MAX_PIXELS = 120000000;

  function normalizeSettings(settings) {
    const source = settings || {};
    const packing = PACKINGS.includes(source.packing) ? source.packing : 'unpacked';
    let bitDepth = numberFrom(source.bitDepth, 8);
    if (packing === 'mipi10') {
      bitDepth = 10;
    } else if (packing === 'mipi12') {
      bitDepth = 12;
    } else if (!BIT_DEPTHS.includes(bitDepth)) {
      bitDepth = 8;
    }

    const channels = CHANNELS.includes(Number(source.channels)) ? Number(source.channels) : 4;
    const black = finiteNumber(source.black, 0);
    const white = finiteNumber(source.white, 0);

    return {
      width: positiveInteger(source.width, 1),
      height: positiveInteger(source.height, 1),
      channels,
      pattern: patternFrom(source.pattern, 'RGGB'),
      channelOrder: patternFrom(source.channelOrder, 'RGGB'),
      bitDepth,
      endian: source.endian === 'big' ? 'big' : 'little',
      packing,
      normalize: source.normalize !== false,
      black,
      white,
      gain: Math.max(0.01, finiteNumber(source.gain, 1))
    };
  }

  function validateRenderable(settings, maxPixels) {
    const normalized = normalizeSettings(settings);
    const limit = maxPixels || MAX_PIXELS;
    const pixelCount = normalized.width * normalized.height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > limit) {
      return {
        ok: false,
        reason: `Image dimensions exceed the ${formatNumber(limit)} pixel safety limit.`
      };
    }
    return { ok: true, settings: normalized };
  }

  function expectedBytes(settings) {
    const normalized = normalizeSettings(settings);
    const samples = normalized.width * normalized.height * normalized.channels;
    if (normalized.packing === 'mipi10') {
      return Math.ceil(samples / 4) * 5;
    }
    if (normalized.packing === 'mipi12') {
      return Math.ceil(samples / 2) * 3;
    }
    return samples * bytesPerUnpackedSample(normalized.bitDepth);
  }

  function bytesPerUnpackedSample(bitDepth) {
    if (bitDepth === 8) {
      return 1;
    }
    if (bitDepth === 32) {
      return 4;
    }
    return 2;
  }

  function makeSampleReader(inputBytes, settings) {
    const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || []);
    const normalized = normalizeSettings(settings);
    if (normalized.packing === 'mipi10') {
      return makeMipi10Reader(bytes);
    }
    if (normalized.packing === 'mipi12') {
      return makeMipi12Reader(bytes);
    }
    if (normalized.bitDepth === 8) {
      return (index) => bytes[index] || 0;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (normalized.bitDepth === 32) {
      return (index) => {
        const offset = index * 4;
        return offset + 3 < bytes.byteLength ? view.getFloat32(offset, normalized.endian === 'little') : 0;
      };
    }

    return (index) => {
      const offset = index * 2;
      return offset + 1 < bytes.byteLength ? view.getUint16(offset, normalized.endian === 'little') : 0;
    };
  }

  function makeMipi10Reader(bytes) {
    return (index) => {
      const group = Math.floor(index / 4) * 5;
      const lane = index & 3;
      if (group + 4 >= bytes.length) {
        return 0;
      }
      return (bytes[group + lane] << 2) | ((bytes[group + 4] >> (lane * 2)) & 0x03);
    };
  }

  function makeMipi12Reader(bytes) {
    return (index) => {
      const group = Math.floor(index / 2) * 3;
      if (group + 2 >= bytes.length) {
        return 0;
      }
      if ((index & 1) === 0) {
        return (bytes[group] << 4) | (bytes[group + 2] & 0x0f);
      }
      return (bytes[group + 1] << 4) | (bytes[group + 2] >> 4);
    };
  }

  function maxSample(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.bitDepth === 32) {
      return 1;
    }
    return Math.pow(2, normalized.bitDepth) - 1;
  }

  function computeRange(samples, settings, max) {
    const normalized = normalizeSettings(settings);
    if (!normalized.normalize) {
      const white = normalized.white > normalized.black ? normalized.white : max;
      return { black: normalized.black, white };
    }

    const totalPixels = normalized.width * normalized.height;
    const visibleSamples = normalized.channels === 3 ? totalPixels * 3 : totalPixels;
    const stride = Math.max(1, Math.floor(visibleSamples / 250000));
    const channelForPosition = normalized.channels === 4
      ? fourChannelShuffleMap(normalized.pattern, normalized.channelOrder)
      : null;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < visibleSamples; i += stride) {
      const value = samples(visibleSampleIndex(i, normalized, channelForPosition));
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }

    if (!Number.isFinite(low) || high <= low) {
      low = normalized.black;
      high = max;
    }
    return { black: low, white: high };
  }

  function visibleSampleIndex(visibleIndex, settings, channelForPosition) {
    if (settings.channels === 3) {
      return visibleIndex;
    }
    if (settings.channels === 4) {
      const pixel = visibleIndex;
      const x = pixel % settings.width;
      const y = Math.floor(pixel / settings.width);
      const position = (y & 1) * 2 + (x & 1);
      return pixel * 4 + channelForPosition[position];
    }
    return visibleIndex;
  }

  function fillImageData(out, samples, settings, range) {
    const normalized = normalizeSettings(settings);
    const scale = 255 / Math.max(1e-9, range.white - range.black);

    if (normalized.channels === 4) {
      fillFourChannel(out, samples, normalized, range.black, scale);
      return out;
    }
    if (normalized.channels === 3) {
      fillRgb(out, samples, normalized, range.black, scale);
      return out;
    }
    fillBayerMosaic(out, samples, normalized, range.black, scale);
    return out;
  }

  function renderToRgba(inputBytes, settings, output) {
    const normalized = normalizeSettings(settings);
    const validation = validateRenderable(normalized);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    const samples = makeSampleReader(inputBytes, normalized);
    const range = computeRange(samples, normalized, maxSample(normalized));
    const data = output || new Uint8ClampedArray(normalized.width * normalized.height * 4);
    fillImageData(data, samples, normalized, range);
    return {
      data,
      width: normalized.width,
      height: normalized.height,
      range,
      expectedBytes: expectedBytes(normalized),
      settings: normalized
    };
  }

  function fillFourChannel(out, samples, settings, black, scale) {
    const channelForPosition = fourChannelShuffleMap(settings.pattern, settings.channelOrder);
    const pattern = settings.pattern;
    for (let y = 0; y < settings.height; y += 1) {
      const row = y * settings.width;
      for (let x = 0; x < settings.width; x += 1) {
        const pixel = row + x;
        const position = (y & 1) * 2 + (x & 1);
        const color = pattern[position] || 'G';
        const value = toByte(samples(pixel * 4 + channelForPosition[position]), black, scale, settings.gain);
        writeBayerPixel(out, pixel * 4, color, value);
      }
    }
  }

  function fillRgb(out, samples, settings, black, scale) {
    const pixels = settings.width * settings.height;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const source = pixel * 3;
      const target = pixel * 4;
      out[target] = toByte(samples(source), black, scale, settings.gain);
      out[target + 1] = toByte(samples(source + 1), black, scale, settings.gain);
      out[target + 2] = toByte(samples(source + 2), black, scale, settings.gain);
      out[target + 3] = 255;
    }
  }

  function fillBayerMosaic(out, samples, settings, black, scale) {
    const pattern = settings.pattern;
    for (let y = 0; y < settings.height; y += 1) {
      const row = y * settings.width;
      for (let x = 0; x < settings.width; x += 1) {
        const pixel = row + x;
        const value = toByte(samples(pixel), black, scale, settings.gain);
        writeBayerPixel(out, pixel * 4, pattern[(y & 1) * 2 + (x & 1)] || 'G', value);
      }
    }
  }

  function writeBayerPixel(out, offset, color, value) {
    out[offset] = color === 'R' ? value : 0;
    out[offset + 1] = color === 'G' ? value : 0;
    out[offset + 2] = color === 'B' ? value : 0;
    out[offset + 3] = 255;
  }

  function fourChannelShuffleMap(pattern, channelOrder) {
    const target = [...patternFrom(pattern, 'RGGB')];
    const available = [...patternFrom(channelOrder, 'RGGB')];
    return target.map((color) => {
      const index = available.indexOf(color);
      if (index === -1) {
        return color === 'R' ? 0 : color === 'B' ? 3 : 1;
      }
      available[index] = '';
      return index;
    });
  }

  function guessDimensions(byteLength, settings, fileName) {
    const normalized = normalizeSettings(settings);
    const fromName = dimensionsFromName(fileName);
    if (fromName) {
      return { ...fromName, source: 'filename' };
    }

    const pixelCount = pixelCountFromBytes(byteLength, normalized);
    if (!pixelCount || pixelCount < 1) {
      return null;
    }

    const common = commonDimensions().find((entry) => entry.width * entry.height === pixelCount);
    if (common) {
      return { ...common, source: 'common-size' };
    }

    const ratios = [
      { width: 16, height: 9 },
      { width: 4, height: 3 },
      { width: 3, height: 2 },
      { width: 1, height: 1 }
    ];
    for (const ratio of ratios) {
      const width = Math.round(Math.sqrt(pixelCount * ratio.width / ratio.height));
      const height = Math.round(width * ratio.height / ratio.width);
      if (width * height === pixelCount) {
        return { width, height, source: `${ratio.width}:${ratio.height}` };
      }
    }

    const square = Math.round(Math.sqrt(pixelCount));
    if (square * square === pixelCount) {
      return { width: square, height: square, source: 'square' };
    }
    return null;
  }

  function pixelCountFromBytes(byteLength, settings) {
    const normalized = normalizeSettings(settings);
    let samples = 0;
    if (normalized.packing === 'mipi10') {
      samples = Math.floor(byteLength / 5) * 4;
    } else if (normalized.packing === 'mipi12') {
      samples = Math.floor(byteLength / 3) * 2;
    } else {
      samples = Math.floor(byteLength / bytesPerUnpackedSample(normalized.bitDepth));
    }
    return Math.floor(samples / normalized.channels);
  }

  function dimensionsFromName(fileName) {
    const text = String(fileName || '');
    const match = text.match(/(?:^|[^0-9])(\d{2,6})\s*[xX]\s*(\d{2,6})(?:[^0-9]|$)/);
    if (!match) {
      return null;
    }
    return {
      width: positiveInteger(match[1], 1),
      height: positiveInteger(match[2], 1)
    };
  }

  function commonDimensions() {
    return [
      { width: 320, height: 240 },
      { width: 640, height: 480 },
      { width: 800, height: 600 },
      { width: 1024, height: 768 },
      { width: 1280, height: 720 },
      { width: 1280, height: 960 },
      { width: 1600, height: 1200 },
      { width: 1920, height: 1080 },
      { width: 2048, height: 1080 },
      { width: 2048, height: 1536 },
      { width: 2592, height: 1944 },
      { width: 3840, height: 2160 },
      { width: 4096, height: 2160 },
      { width: 4096, height: 3072 }
    ];
  }

  function patternFrom(value, fallback) {
    const pattern = String(value || fallback).toUpperCase();
    return PATTERNS.includes(pattern) ? pattern : fallback;
  }

  function numberFrom(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positiveInteger(value, fallback) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function toByte(value, black, scale, gain) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const scaled = (value - black) * scale * gain;
    if (scaled <= 0) {
      return 0;
    }
    if (scaled >= 255) {
      return 255;
    }
    return scaled | 0;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  return {
    MAX_PIXELS,
    normalizeSettings,
    validateRenderable,
    expectedBytes,
    makeSampleReader,
    makeMipi10Reader,
    makeMipi12Reader,
    maxSample,
    computeRange,
    fillImageData,
    renderToRgba,
    fourChannelShuffleMap,
    guessDimensions,
    pixelCountFromBytes
  };
});
