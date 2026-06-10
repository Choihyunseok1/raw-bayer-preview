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
  const BIT_DEPTHS = [8, 10, 12, 14, 16, 24, 32, 64];
  const CHANNELS = [1, 3, 4];
  const SAMPLE_FORMATS = ['uint', 'int', 'float'];
  const DISPLAY_MODES = ['mosaic', 'r', 'g1', 'g2', 'b'];
  const MAX_PIXELS = 120000000;

  function normalizeSettings(settings) {
    const source = settings || {};
    const packing = PACKINGS.includes(source.packing) ? source.packing : 'unpacked';
    let bitDepth = numberFrom(source.bitDepth, 8);
    let sampleFormat = SAMPLE_FORMATS.includes(source.sampleFormat) ? source.sampleFormat : 'uint';
    if (packing === 'mipi10') {
      bitDepth = 10;
      sampleFormat = 'uint';
    } else if (packing === 'mipi12') {
      bitDepth = 12;
      sampleFormat = 'uint';
    } else if (!BIT_DEPTHS.includes(bitDepth)) {
      bitDepth = 8;
    }
    if (sampleFormat === 'float' && bitDepth !== 16 && bitDepth !== 32 && bitDepth !== 64) {
      bitDepth = 32;
    }
    if (bitDepth === 64 && sampleFormat !== 'float') {
      sampleFormat = 'float';
    }

    const channels = CHANNELS.includes(Number(source.channels)) ? Number(source.channels) : 4;
    const black = finiteNumber(source.black, 0);
    const white = finiteNumber(source.white, 0);

    return {
      width: positiveInteger(source.width, 1),
      height: positiveInteger(source.height, 1),
      channels,
      displayMode: displayModeFrom(source.displayMode),
      pattern: patternFrom(source.pattern, 'RGGB'),
      channelOrder: patternFrom(source.channelOrder, 'RGGB'),
      bitDepth,
      sampleFormat,
      endian: source.endian === 'big' ? 'big' : 'little',
      packing,
      normalize: source.normalize !== false,
      black,
      white,
      gain: Math.max(0.01, finiteNumber(source.gain, 1)),
      sourceLayout: normalizeSourceLayout(source.sourceLayout)
    };
  }

  function validateRenderable(settings, maxPixels) {
    const normalized = normalizeSettings(settings);
    const limit = maxPixels || MAX_PIXELS;
    const dimensions = outputDimensions(normalized);
    const pixelCount = dimensions.width * dimensions.height;
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
    if (bitDepth === 24) {
      return 3;
    }
    if (bitDepth === 64) {
      return 8;
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
    let reader;
    if (normalized.bitDepth === 8) {
      reader = normalized.sampleFormat === 'int'
        ? (index) => index < bytes.length ? int8(bytes[index]) : 0
        : (index) => bytes[index] || 0;
      return wrapSourceLayoutReader(reader, normalized);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (normalized.sampleFormat === 'float' && normalized.bitDepth === 16) {
      reader = (index) => {
        const offset = index * 2;
        if (offset + 1 >= bytes.byteLength) {
          return 0;
        }
        return float16ToNumber(view.getUint16(offset, normalized.endian === 'little'));
      };
      return wrapSourceLayoutReader(reader, normalized);
    }
    if (normalized.sampleFormat === 'float' && normalized.bitDepth === 32) {
      reader = (index) => {
        const offset = index * 4;
        return offset + 3 < bytes.byteLength ? view.getFloat32(offset, normalized.endian === 'little') : 0;
      };
      return wrapSourceLayoutReader(reader, normalized);
    }
    if (normalized.sampleFormat === 'float' && normalized.bitDepth === 64) {
      reader = (index) => {
        const offset = index * 8;
        return offset + 7 < bytes.byteLength ? view.getFloat64(offset, normalized.endian === 'little') : 0;
      };
      return wrapSourceLayoutReader(reader, normalized);
    }
    if (normalized.bitDepth === 24) {
      reader = (index) => {
        const offset = index * 3;
        if (offset + 2 >= bytes.byteLength) {
          return 0;
        }
        const value = normalized.endian === 'little'
          ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
          : (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
        return normalized.sampleFormat === 'int' && (value & 0x800000)
          ? value - 0x1000000
          : value;
      };
      return wrapSourceLayoutReader(reader, normalized);
    }
    if (normalized.bitDepth === 32) {
      reader = (index) => {
        const offset = index * 4;
        if (offset + 3 >= bytes.byteLength) {
          return 0;
        }
        return normalized.sampleFormat === 'int'
          ? view.getInt32(offset, normalized.endian === 'little')
          : view.getUint32(offset, normalized.endian === 'little');
      };
      return wrapSourceLayoutReader(reader, normalized);
    }

    reader = (index) => {
      const offset = index * 2;
      if (offset + 1 >= bytes.byteLength) {
        return 0;
      }
      return normalized.sampleFormat === 'int'
        ? view.getInt16(offset, normalized.endian === 'little')
        : view.getUint16(offset, normalized.endian === 'little');
    };
    return wrapSourceLayoutReader(reader, normalized);
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
    if (normalized.sampleFormat === 'float') {
      return 1;
    }
    if (normalized.sampleFormat === 'int') {
      return Math.pow(2, normalized.bitDepth - 1) - 1;
    }
    return Math.pow(2, normalized.bitDepth) - 1;
  }

  function computeRange(samples, settings, max) {
    const normalized = normalizeSettings(settings);
    if (!normalized.normalize) {
      const white = normalized.white > normalized.black ? normalized.white : max;
      return { black: normalized.black, white };
    }

    const visibleSamples = displaySampleCount(normalized);
    const stride = Math.max(1, Math.floor(visibleSamples / 250000));
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    const values = [];

    for (let i = 0; i < visibleSamples; i += stride) {
      const sampleIndex = displaySampleIndex(i, normalized);
      if (sampleIndex === null) {
        continue;
      }
      const value = samples(sampleIndex);
      if (Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
        values.push(value);
      }
    }

    if (values.length >= 1000) {
      values.sort((a, b) => a - b);
      low = quantile(values, 0.005);
      high = quantile(values, 0.995);
    }

    if (!Number.isFinite(low) || high <= low) {
      low = normalized.black;
      high = max;
    }
    return { black: low, white: high };
  }

  function quantile(sortedValues, fraction) {
    const index = (sortedValues.length - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) {
      return sortedValues[lower];
    }
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  function displaySampleCount(settings) {
    const dimensions = outputDimensions(settings);
    if (settings.displayMode === 'mosaic' && settings.channels === 3) {
      return dimensions.width * dimensions.height * 3;
    }
    return dimensions.width * dimensions.height;
  }

  function displaySampleIndex(visibleIndex, settings) {
    if (settings.displayMode !== 'mosaic') {
      return planeSampleIndex(visibleIndex, settings);
    }
    return visibleIndex;
  }

  function wrapSourceLayoutReader(reader, settings) {
    const layout = settings.sourceLayout;
    if (!layout || layout.kind !== 'ndarray') {
      return reader;
    }
    if (!sourceLayoutMatchesSettings(layout, settings)) {
      return reader;
    }

    const strides = ndarrayStrides(layout.shape, layout.fortranOrder);
    return (logicalIndex) => reader(mapLogicalIndexToNdarrayIndex(logicalIndex, settings, layout, strides));
  }

  function sourceLayoutMatchesSettings(layout, settings) {
    if (!Array.isArray(layout.shape)) {
      return false;
    }
    if (layout.shape[layout.heightAxis] !== settings.height || layout.shape[layout.widthAxis] !== settings.width) {
      return false;
    }
    if (layout.channelAxis === null || layout.channelAxis === undefined) {
      return settings.channels === 1;
    }
    return layout.shape[layout.channelAxis] === settings.channels;
  }

  function ndarrayStrides(shape, fortranOrder) {
    const strides = new Array(shape.length).fill(1);
    if (fortranOrder) {
      for (let i = 1; i < shape.length; i += 1) {
        strides[i] = strides[i - 1] * shape[i - 1];
      }
      return strides;
    }
    for (let i = shape.length - 2; i >= 0; i -= 1) {
      strides[i] = strides[i + 1] * shape[i + 1];
    }
    return strides;
  }

  function mapLogicalIndexToNdarrayIndex(logicalIndex, settings, layout, strides) {
    const channel = layout.channelAxis === null || layout.channelAxis === undefined
      ? 0
      : logicalIndex % settings.channels;
    const pixel = layout.channelAxis === null || layout.channelAxis === undefined
      ? logicalIndex
      : Math.floor(logicalIndex / settings.channels);
    const y = Math.floor(pixel / settings.width);
    const x = pixel % settings.width;
    const coords = new Array(layout.shape.length).fill(0);
    coords[layout.heightAxis] = y;
    coords[layout.widthAxis] = x;
    if (layout.channelAxis !== null && layout.channelAxis !== undefined) {
      coords[layout.channelAxis] = channel;
    }
    return coords.reduce((offset, coord, axis) => offset + coord * strides[axis], 0);
  }

  function fillImageData(out, samples, settings, range) {
    const normalized = normalizeSettings(settings);
    const scale = 255 / Math.max(1e-9, range.white - range.black);

    if (normalized.displayMode !== 'mosaic') {
      fillPlane(out, samples, normalized, range.black, scale);
      return out;
    }

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
    const dimensions = outputDimensions(normalized);
    const data = output || new Uint8ClampedArray(dimensions.width * dimensions.height * 4);
    fillImageData(data, samples, normalized, range);
    return {
      data,
      width: dimensions.width,
      height: dimensions.height,
      range,
      expectedBytes: expectedBytes(normalized),
      settings: normalized
    };
  }

  function fillFourChannel(out, samples, settings, black, scale) {
    const channelForPosition = fourChannelShuffleMap(settings.pattern, settings.channelOrder);
    const pattern = settings.pattern;
    const outputWidth = settings.width * 2;
    for (let y = 0; y < settings.height; y += 1) {
      const row = y * settings.width;
      for (let x = 0; x < settings.width; x += 1) {
        const pixel = row + x;
        for (let position = 0; position < 4; position += 1) {
          const outputX = x * 2 + (position & 1);
          const outputY = y * 2 + (position >> 1);
          const outputPixel = outputY * outputWidth + outputX;
          const color = pattern[position] || 'G';
          const value = toByte(samples(pixel * 4 + channelForPosition[position]), black, scale, settings.gain);
          writeBayerPixel(out, outputPixel * 4, color, value);
        }
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

  function fillPlane(out, samples, settings, black, scale) {
    const dimensions = outputDimensions(settings);
    if (settings.channels === 4) {
      const position = planePosition(settings.displayMode, settings.pattern);
      const channelForPosition = fourChannelShuffleMap(settings.pattern, settings.channelOrder);
      const channel = channelForPosition[position];
      const pixels = dimensions.width * dimensions.height;
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const value = toByte(samples(pixel * 4 + channel), black, scale, settings.gain);
        writeGrayPixel(out, pixel * 4, value);
      }
      return;
    }

    if (settings.channels === 3) {
      const channel = settings.displayMode === 'r' ? 0 : settings.displayMode === 'b' ? 2 : 1;
      const pixels = dimensions.width * dimensions.height;
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const value = toByte(samples(pixel * 3 + channel), black, scale, settings.gain);
        writeGrayPixel(out, pixel * 4, value);
      }
      return;
    }

    const position = planePosition(settings.displayMode, settings.pattern);
    const xOffset = position & 1;
    const yOffset = position >> 1;
    for (let y = 0; y < dimensions.height; y += 1) {
      const sourceY = y * 2 + yOffset;
      for (let x = 0; x < dimensions.width; x += 1) {
        const pixel = y * dimensions.width + x;
        const sourceX = x * 2 + xOffset;
        const sampleIndex = sourceX >= settings.width || sourceY >= settings.height
          ? null
          : sourceY * settings.width + sourceX;
        const value = sampleIndex === null ? 0 : toByte(samples(sampleIndex), black, scale, settings.gain);
        writeGrayPixel(out, pixel * 4, value);
      }
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

  function writeGrayPixel(out, offset, value) {
    out[offset] = value;
    out[offset + 1] = value;
    out[offset + 2] = value;
    out[offset + 3] = 255;
  }

  function planeSampleIndex(planeIndex, settings) {
    if (settings.channels === 4) {
      const position = planePosition(settings.displayMode, settings.pattern);
      const channelForPosition = fourChannelShuffleMap(settings.pattern, settings.channelOrder);
      return planeIndex * 4 + channelForPosition[position];
    }
    if (settings.channels === 3) {
      const channel = settings.displayMode === 'r'
        ? 0
        : settings.displayMode === 'b'
          ? 2
          : 1;
      return planeIndex * 3 + channel;
    }

    const dimensions = outputDimensions(settings);
    const position = planePosition(settings.displayMode, settings.pattern);
    const sourceX = (planeIndex % dimensions.width) * 2 + (position & 1);
    const sourceY = Math.floor(planeIndex / dimensions.width) * 2 + (position >> 1);
    if (sourceX >= settings.width || sourceY >= settings.height) {
      return null;
    }
    return sourceY * settings.width + sourceX;
  }

  function planePosition(displayMode, pattern) {
    const positions = [...patternFrom(pattern, 'RGGB')];
    if (displayMode === 'r') {
      return Math.max(0, positions.indexOf('R'));
    }
    if (displayMode === 'b') {
      const index = positions.indexOf('B');
      return index === -1 ? 3 : index;
    }
    const greens = positions
      .map((color, index) => color === 'G' ? index : -1)
      .filter((index) => index !== -1);
    if (displayMode === 'g2') {
      return greens[1] ?? greens[0] ?? 2;
    }
    return greens[0] ?? 1;
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

  function prepareInput(inputBytes, settings, fileName) {
    const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || []);
    if (isNpy(bytes)) {
      const npy = parseNpy(bytes);
      return {
        bytes: bytes.subarray(npy.dataOffset),
        settings: normalizeSettings({ ...settings, ...npy.settings }),
        metadata: {
          format: 'npy',
          label: `NPY ${npy.descr} ${npy.shape.join('x')}`,
          dataOffset: npy.dataOffset,
          sourceName: fileName || ''
        }
      };
    }

    const pnm = parsePnm(bytes);
    if (pnm) {
      return {
        bytes: bytes.subarray(pnm.dataOffset),
        settings: normalizeSettings({ ...settings, sourceLayout: null, ...pnm.settings }),
        metadata: {
          format: pnm.format,
          label: `${pnm.format.toUpperCase()} ${pnm.width}x${pnm.height} max ${pnm.maxValue}`,
          dataOffset: pnm.dataOffset,
          sourceName: fileName || ''
        }
      };
    }

    if (isCanonCr2(bytes)) {
      throw new Error('Canon CR2 is camera RAW, not a flat RAW buffer. Install/use the VS Code extension CR2 converter path.');
    }

    return {
      bytes,
      settings: normalizeSettings({ ...settings, sourceLayout: null }),
      metadata: {
        format: 'raw',
        label: 'RAW buffer',
        dataOffset: 0,
        sourceName: fileName || ''
      }
    };
  }

  function isNpy(bytes) {
    return bytes.length >= 10 &&
      bytes[0] === 0x93 &&
      bytes[1] === 0x4e &&
      bytes[2] === 0x55 &&
      bytes[3] === 0x4d &&
      bytes[4] === 0x50 &&
      bytes[5] === 0x59;
  }

  function parseNpy(bytes) {
    const major = bytes[6];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let headerLength;
    let headerOffset;
    if (major === 1) {
      headerLength = view.getUint16(8, true);
      headerOffset = 10;
    } else if (major === 2 || major === 3) {
      headerLength = view.getUint32(8, true);
      headerOffset = 12;
    } else {
      throw new Error(`Unsupported NPY version ${major}.${bytes[7]}.`);
    }

    const dataOffset = headerOffset + headerLength;
    if (dataOffset > bytes.length) {
      throw new Error('Invalid NPY header length.');
    }

    const header = decodeAscii(bytes.subarray(headerOffset, dataOffset));
    const descr = matchHeaderValue(header, 'descr');
    const shape = parseNpyShape(header);
    const fortranOrder = parseNpyFortranOrder(header);
    const dtype = dtypeFromNpyDescr(descr);
    const layout = imageLayoutFromShape(shape, fortranOrder);

    return {
      descr,
      shape,
      dataOffset,
      settings: {
        width: shape[layout.widthAxis],
        height: shape[layout.heightAxis],
        channels: layout.channelAxis === null ? 1 : shape[layout.channelAxis],
        bitDepth: dtype.bitDepth,
        sampleFormat: dtype.sampleFormat,
        endian: dtype.endian,
        packing: 'unpacked',
        sourceLayout: {
          kind: 'ndarray',
          shape,
          fortranOrder,
          heightAxis: layout.heightAxis,
          widthAxis: layout.widthAxis,
          channelAxis: layout.channelAxis
        }
      }
    };
  }

  function matchHeaderValue(header, key) {
    const pattern = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`);
    const match = header.match(pattern);
    if (!match) {
      throw new Error(`Invalid NPY header: missing ${key}.`);
    }
    return match[1];
  }

  function parseNpyShape(header) {
    const match = header.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/);
    if (!match) {
      throw new Error('Invalid NPY header: missing shape.');
    }
    const shape = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => Number(part));
    if (shape.length < 2 || shape.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`Unsupported NPY shape (${match[1]}).`);
    }
    return shape;
  }

  function parseNpyFortranOrder(header) {
    const match = header.match(/['"]fortran_order['"]\s*:\s*(True|False)/);
    if (!match) {
      throw new Error('Invalid NPY header: missing fortran_order.');
    }
    return match[1] === 'True';
  }

  function dtypeFromNpyDescr(descr) {
    const match = String(descr).trim().match(/^([<>=|])([A-Za-z])(\d+)$/);
    if (!match) {
      throw new Error(`Unsupported NPY dtype ${descr}.`);
    }
    const endian = match[1] === '>' ? 'big' : 'little';
    const kind = match[2].toLowerCase();
    const bytes = Number(match[3]);
    const bitDepth = bytes * 8;

    if (kind === 'u' && [8, 16, 32].includes(bitDepth)) {
      return { bitDepth, sampleFormat: 'uint', endian };
    }
    if (kind === 'i' && [8, 16, 32].includes(bitDepth)) {
      return { bitDepth, sampleFormat: 'int', endian };
    }
    if (kind === 'f' && [16, 32, 64].includes(bitDepth)) {
      return { bitDepth, sampleFormat: 'float', endian };
    }
    if (kind === 'b' && bitDepth === 8) {
      return { bitDepth: 8, sampleFormat: 'uint', endian: 'little' };
    }
    throw new Error(`Unsupported NPY dtype ${descr}.`);
  }

  function imageLayoutFromShape(shape) {
    if (shape.length === 2) {
      return { heightAxis: 0, widthAxis: 1, channelAxis: null };
    }
    if (shape.length === 3 && CHANNELS.includes(shape[2])) {
      return { heightAxis: 0, widthAxis: 1, channelAxis: 2 };
    }
    if (shape.length === 3 && CHANNELS.includes(shape[0])) {
      return { heightAxis: 1, widthAxis: 2, channelAxis: 0 };
    }
    if (shape.length === 4 && shape[0] === 1 && CHANNELS.includes(shape[3])) {
      return { heightAxis: 1, widthAxis: 2, channelAxis: 3 };
    }
    if (shape.length === 4 && shape[0] === 1 && CHANNELS.includes(shape[1])) {
      return { heightAxis: 2, widthAxis: 3, channelAxis: 1 };
    }
    throw new Error(`Unsupported NPY image shape (${shape.join(', ')}).`);
  }

  function isCanonCr2(bytes) {
    if (bytes.length < 12) {
      return false;
    }
    const littleTiff = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const bigTiff = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    return (littleTiff || bigTiff) &&
      bytes[8] === 0x43 &&
      bytes[9] === 0x52 &&
      bytes[10] === 0x02 &&
      bytes[11] === 0x00;
  }

  function parsePnm(bytes) {
    if (bytes.length < 3 || bytes[0] !== 0x50) {
      return null;
    }
    const magic = `P${String.fromCharCode(bytes[1])}`;
    if (magic !== 'P5' && magic !== 'P6') {
      return null;
    }

    let token = nextPnmToken(bytes, 2);
    const width = positiveInteger(token.value, 0);
    token = nextPnmToken(bytes, token.next);
    const height = positiveInteger(token.value, 0);
    token = nextPnmToken(bytes, token.next);
    const maxValue = positiveInteger(token.value, 0);
    if (!width || !height || !maxValue) {
      throw new Error(`Invalid ${magic} header.`);
    }

    let dataOffset = token.next;
    if (bytes[dataOffset] === 0x0d && bytes[dataOffset + 1] === 0x0a) {
      dataOffset += 2;
    } else if (isWhitespace(bytes[dataOffset])) {
      dataOffset += 1;
    }
    return {
      format: magic === 'P5' ? 'pgm' : 'ppm',
      width,
      height,
      maxValue,
      dataOffset,
      settings: {
        width,
        height,
        channels: magic === 'P5' ? 1 : 3,
        bitDepth: maxValue <= 255 ? 8 : 16,
        sampleFormat: 'uint',
        endian: 'big',
        packing: 'unpacked',
        black: 0,
        white: maxValue
      }
    };
  }

  function nextPnmToken(bytes, start) {
    let index = skipPnmSpaceAndComments(bytes, start);
    const tokenStart = index;
    while (index < bytes.length && !isWhitespace(bytes[index]) && bytes[index] !== 0x23) {
      index += 1;
    }
    if (tokenStart === index) {
      throw new Error('Invalid PNM header.');
    }
    return { value: decodeAscii(bytes.subarray(tokenStart, index)), next: index };
  }

  function skipPnmSpaceAndComments(bytes, start) {
    let index = start;
    while (index < bytes.length) {
      while (index < bytes.length && isWhitespace(bytes[index])) {
        index += 1;
      }
      if (bytes[index] !== 0x23) {
        break;
      }
      while (index < bytes.length && bytes[index] !== 0x0a) {
        index += 1;
      }
    }
    return index;
  }

  function isWhitespace(byte) {
    return byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20;
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

  function guessRawSettings(inputBytes, settings, fileName) {
    const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes || []);
    const normalized = normalizeSettings(settings);
    const byName = dimensionsFromName(fileName);
    if (byName) {
      return { ...normalized, width: byName.width, height: byName.height };
    }

    const currentExpected = expectedBytes(normalized);
    if (currentExpected === bytes.byteLength) {
      return normalized;
    }

    const candidates = rawLayoutCandidates(bytes, normalized);
    return candidates.length ? candidates[0].settings : null;
  }

  function rawLayoutCandidates(bytes, baseSettings) {
    const preferred24 = looksLikeThreeByteIntegerSamples(bytes);
    const candidates = [];
    for (const bitDepth of [8, 16, 24, 32]) {
      for (const channels of CHANNELS) {
        const settings = normalizeSettings({
          ...baseSettings,
          channels,
          bitDepth,
          sampleFormat: 'uint',
          packing: 'unpacked',
          sourceLayout: null
        });
        const pixelCount = pixelCountFromBytes(bytes.byteLength, settings);
        if (!pixelCount || expectedBytes({ ...settings, width: 1, height: pixelCount }) !== bytes.byteLength) {
          continue;
        }
        const dimensions = dimensionsFromPixelCount(pixelCount);
        if (!dimensions) {
          continue;
        }
        let score = dimensions.source === 'common-size' ? 0 : 20;
        if (preferred24 && bitDepth === 24 && channels === 1) {
          score -= 10;
        }
        if (!preferred24 && bitDepth === 8 && channels === 3) {
          score -= 2;
        }
        if (channels === baseSettings.channels) {
          score -= 1;
        }
        candidates.push({
          score,
          settings: {
            ...settings,
            width: dimensions.width,
            height: dimensions.height
          }
        });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  function dimensionsFromPixelCount(pixelCount) {
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

  function looksLikeThreeByteIntegerSamples(bytes) {
    if (bytes.byteLength < 300 || bytes.byteLength % 3 !== 0) {
      return false;
    }
    const samples = Math.floor(bytes.byteLength / 3);
    const stride = Math.max(1, Math.floor(samples / 20000));
    let checked = 0;
    let highByteZero = 0;
    for (let sample = 0; sample < samples; sample += stride) {
      const offset = sample * 3;
      if (bytes[offset + 2] === 0) {
        highByteZero += 1;
      }
      checked += 1;
    }
    return checked > 0 && highByteZero / checked > 0.95;
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
      { width: 2784, height: 1920 },
      { width: 3840, height: 2160 },
      { width: 4096, height: 2160 },
      { width: 4096, height: 3072 }
    ];
  }

  function patternFrom(value, fallback) {
    const pattern = String(value || fallback).toUpperCase();
    return PATTERNS.includes(pattern) ? pattern : fallback;
  }

  function displayModeFrom(value) {
    const mode = String(value || 'mosaic').toLowerCase();
    return DISPLAY_MODES.includes(mode) ? mode : 'mosaic';
  }

  function normalizeSourceLayout(layout) {
    if (!layout || layout.kind !== 'ndarray' || !Array.isArray(layout.shape)) {
      return null;
    }
    const shape = layout.shape.map((value) => positiveInteger(value, 0));
    if (shape.some((value) => value < 1)) {
      return null;
    }
    const heightAxis = axisInteger(layout.heightAxis);
    const widthAxis = axisInteger(layout.widthAxis);
    const channelAxis = layout.channelAxis === null || layout.channelAxis === undefined
      ? null
      : axisInteger(layout.channelAxis);
    if (heightAxis < 0 || widthAxis < 0 || heightAxis >= shape.length || widthAxis >= shape.length) {
      return null;
    }
    if (channelAxis !== null && (channelAxis < 0 || channelAxis >= shape.length)) {
      return null;
    }
    return {
      kind: 'ndarray',
      shape,
      fortranOrder: Boolean(layout.fortranOrder),
      heightAxis,
      widthAxis,
      channelAxis
    };
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

  function axisInteger(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : -1;
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

  function int8(value) {
    return value > 127 ? value - 256 : value;
  }

  function float16ToNumber(value) {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >> 10) & 0x1f;
    const fraction = value & 0x03ff;
    if (exponent === 0) {
      return sign * Math.pow(2, -14) * (fraction / 1024);
    }
    if (exponent === 0x1f) {
      return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    }
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  function outputDimensions(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.displayMode !== 'mosaic') {
      if (normalized.channels === 1) {
        const position = planePosition(normalized.displayMode, normalized.pattern);
        return {
          width: Math.max(1, Math.floor((normalized.width + 1 - (position & 1)) / 2)),
          height: Math.max(1, Math.floor((normalized.height + 1 - (position >> 1)) / 2))
        };
      }
      return {
        width: normalized.width,
        height: normalized.height
      };
    }
    if (normalized.channels === 4) {
      return {
        width: normalized.width * 2,
        height: normalized.height * 2
      };
    }
    return {
      width: normalized.width,
      height: normalized.height
    };
  }

  function formatNumber(value) {
    return Number(value).toLocaleString('en-US');
  }

  function decodeAscii(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 1) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  return {
    MAX_PIXELS,
    normalizeSettings,
    outputDimensions,
    validateRenderable,
    prepareInput,
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
    guessRawSettings,
    pixelCountFromBytes
  };
});
