const vscode = acquireVsCodeApi();
const renderCore = window.RawBayerRenderCore;

const controls = {
  fileName: document.getElementById('fileName'),
  fileMeta: document.getElementById('fileMeta'),
  width: document.getElementById('width'),
  height: document.getElementById('height'),
  channels: document.getElementById('channels'),
  displayMode: document.getElementById('displayMode'),
  pattern: document.getElementById('pattern'),
  channelOrder: document.getElementById('channelOrder'),
  bitDepth: document.getElementById('bitDepth'),
  sampleFormat: document.getElementById('sampleFormat'),
  endian: document.getElementById('endian'),
  packing: document.getElementById('packing'),
  normalize: document.getElementById('normalize'),
  black: document.getElementById('black'),
  white: document.getElementById('white'),
  gain: document.getElementById('gain'),
  render: document.getElementById('render'),
  guess: document.getElementById('guess'),
  fit: document.getElementById('fit'),
  oneToOne: document.getElementById('oneToOne'),
  zoomOut: document.getElementById('zoomOut'),
  zoomIn: document.getElementById('zoomIn'),
  zoom: document.getElementById('zoom'),
  zoomLabel: document.getElementById('zoomLabel'),
  status: document.getElementById('status'),
  stage: document.getElementById('stage'),
  canvas: document.getElementById('canvas')
};

let raw = null;
let renderToken = 0;
let zoomValue = 100;
let sourceLayout = null;
let currentSourceName = '';
let lockedFields = {};
let fitOnNextRender = false;
const ctx = controls.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
const restoredState = vscode.getState() || {};

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'error') {
    controls.status.textContent = message.message || 'Failed to load RAW file.';
    return;
  }
  if (message?.type !== 'file') {
    return;
  }

  const sourceBytes = new Uint8Array(message.buffer);
  lockedFields = { ...(message.lockedFields || {}) };
  const restoredSettings = restoredState.sourceName === message.name ? restoredState.settings : null;
  const baseSettings = mergeUnlockedSettings(message.settings, restoredSettings, lockedFields);
  let prepared;
  try {
    prepared = renderCore.prepareInput(sourceBytes, baseSettings, message.name);
  } catch (error) {
    controls.status.textContent = `Unsupported file: ${error.message}`;
    return;
  }

  raw = prepared.bytes;
  sourceLayout = prepared.settings.sourceLayout || null;
  currentSourceName = message.name;
  lockedFields = { ...lockedFields, ...(prepared.metadata.lockedFields || {}) };
  const settings = prepared.settings;
  const expected = renderCore.expectedBytes(settings);
  const rawGuess = prepared.metadata.format === 'raw' && message.format !== 'camera-raw'
    ? renderCore.guessRawSettings(raw, settings, message.name)
    : null;
  if (rawGuess) {
    Object.assign(settings, rawGuess, {
      displayMode: 'preview',
      normalize: true,
      black: 0,
      white: 0
    });
  }
  settings.displayMode = 'preview';

  applySettings(settings);
  controls.fileName.textContent = message.name;
  controls.fileMeta.textContent = `${formatBytes(message.byteLength)} loaded, ${message.label || prepared.metadata.label}`;
  fitOnNextRender = true;
  render();
});

controls.render.addEventListener('click', render);
controls.guess.addEventListener('click', guessSize);
controls.fit.addEventListener('click', fitToStage);
controls.oneToOne.addEventListener('click', () => setZoom(100));
controls.zoom.addEventListener('input', () => setZoom(Number(controls.zoom.value)));
controls.zoomOut.addEventListener('click', () => setZoom(zoomValue - 10));
controls.zoomIn.addEventListener('click', () => setZoom(zoomValue + 10));
controls.gain.addEventListener('input', scheduleRender);
controls.stage.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) {
    return;
  }
  event.preventDefault();
  setZoom(zoomValue + (event.deltaY < 0 ? 10 : -10));
}, { passive: false });

for (const id of ['width', 'height', 'channels', 'displayMode', 'pattern', 'channelOrder', 'bitDepth', 'sampleFormat', 'endian', 'packing', 'normalize', 'black', 'white']) {
  controls[id].addEventListener('change', () => {
    if (id === 'packing' || id === 'bitDepth' || id === 'sampleFormat') {
      syncPackingBitDepth();
    }
    scheduleRender();
  });
}

syncPackingBitDepth();
vscode.postMessage({ type: 'ready' });

function applySettings(settings) {
  const normalized = renderCore.normalizeSettings(settings);
  controls.width.value = normalized.width;
  controls.height.value = normalized.height;
  controls.channels.value = normalized.channels;
  controls.displayMode.value = normalized.displayMode;
  controls.pattern.value = normalized.pattern;
  controls.channelOrder.value = normalized.channelOrder;
  controls.bitDepth.value = normalized.bitDepth;
  controls.sampleFormat.value = normalized.sampleFormat;
  controls.endian.value = normalized.endian;
  controls.packing.value = normalized.packing;
  controls.normalize.checked = normalized.normalize;
  controls.black.value = normalized.black;
  controls.white.value = normalized.white;
  controls.gain.value = normalized.gain;
  syncLockedControls();
  syncPackingBitDepth();
}

function scheduleRender() {
  persistSettings();
  clearTimeout(scheduleRender.timer);
  scheduleRender.timer = setTimeout(render, 120);
}

async function render() {
  if (!raw) {
    return;
  }

  const token = ++renderToken;
  const settings = renderCore.normalizeSettings(readSettings());
  const validation = renderCore.validateRenderable(settings);
  if (!validation.ok) {
    controls.status.textContent = validation.reason;
    return;
  }

  const expected = renderCore.expectedBytes(settings);
  const dimensions = renderCore.outputDimensions(settings);
  controls.status.textContent = `Rendering ${dimensions.width} x ${dimensions.height}...`;
  persistSettings();

  await nextFrame();
  if (token !== renderToken) {
    return;
  }

  controls.canvas.width = dimensions.width;
  controls.canvas.height = dimensions.height;
  if (!fitOnNextRender) {
    setZoom(zoomValue);
  }

  let image;
  try {
    image = ctx.createImageData(dimensions.width, dimensions.height);
  } catch (error) {
    controls.status.textContent = `Canvas allocation failed: ${error.message}`;
    return;
  }

  try {
    renderCore.renderToRgba(raw, settings, image.data);
  } catch (error) {
    controls.status.textContent = `Render failed: ${error.message}`;
    return;
  }

  ctx.putImageData(image, 0, 0);
  if (fitOnNextRender) {
    fitOnNextRender = false;
    await nextFrame();
    fitToStage();
  }

  const warning = expected > raw.byteLength
    ? `, file is smaller than expected ${formatBytes(expected)}`
    : expected < raw.byteLength
      ? `, ${formatBytes(raw.byteLength - expected)} trailing bytes`
      : '';
  controls.status.textContent = `Rendered ${formatBytes(expected)} layout${warning}`;
}

function readSettings() {
  return {
    width: controls.width.value,
    height: controls.height.value,
    channels: Number(controls.channels.value),
    displayMode: controls.displayMode.value,
    pattern: controls.pattern.value,
    channelOrder: controls.channelOrder.value,
    bitDepth: Number(controls.bitDepth.value),
    sampleFormat: controls.sampleFormat.value,
    endian: controls.endian.value,
    packing: controls.packing.value,
    normalize: controls.normalize.checked,
    black: Number(controls.black.value),
    white: Number(controls.white.value),
    gain: Number(controls.gain.value),
    sourceLayout
  };
}

function persistSettings() {
  vscode.setState({
    sourceName: currentSourceName,
    settings: renderCore.normalizeSettings(readSettings())
  });
}

function mergeUnlockedSettings(baseSettings, restoredSettings, locks) {
  if (!restoredSettings) {
    return { ...baseSettings };
  }
  const merged = { ...baseSettings, ...restoredSettings };
  for (const [key, locked] of Object.entries(locks || {})) {
    if (locked && Object.prototype.hasOwnProperty.call(baseSettings, key)) {
      merged[key] = baseSettings[key];
    }
  }
  return merged;
}

function guessSize() {
  if (!raw) {
    return;
  }
  const guess = renderCore.guessDimensions(raw.byteLength, readSettings(), controls.fileName.textContent);
  if (!guess) {
    controls.status.textContent = 'Could not infer dimensions from this layout.';
    return;
  }
  controls.width.value = guess.width;
  controls.height.value = guess.height;
  controls.status.textContent = `Guessed ${guess.width} x ${guess.height} from ${guess.source}.`;
  scheduleRender();
}

function syncPackingBitDepth() {
  const bitDepthLocked = Boolean(lockedFields.bitDepth);
  const sampleFormatLocked = Boolean(lockedFields.sampleFormat);
  const endianLocked = Boolean(lockedFields.endian);
  const packingLocked = Boolean(lockedFields.packing);
  if (controls.packing.value === 'mipi10') {
    controls.bitDepth.value = '10';
    controls.bitDepth.disabled = true;
    controls.sampleFormat.value = 'uint';
    controls.sampleFormat.disabled = true;
    controls.endian.disabled = endianLocked;
    controls.packing.disabled = packingLocked;
    return;
  }
  if (controls.packing.value === 'mipi12') {
    controls.bitDepth.value = '12';
    controls.bitDepth.disabled = true;
    controls.sampleFormat.value = 'uint';
    controls.sampleFormat.disabled = true;
    controls.endian.disabled = endianLocked;
    controls.packing.disabled = packingLocked;
    return;
  }
  if (controls.bitDepth.value === '64') {
    controls.sampleFormat.value = 'float';
    controls.sampleFormat.disabled = true;
    controls.bitDepth.disabled = bitDepthLocked;
    controls.endian.disabled = endianLocked;
    controls.packing.disabled = packingLocked;
    return;
  }
  if (controls.sampleFormat.value === 'float' && !['16', '32', '64'].includes(controls.bitDepth.value)) {
    controls.bitDepth.value = '32';
  }
  controls.bitDepth.disabled = bitDepthLocked;
  controls.sampleFormat.disabled = sampleFormatLocked;
  controls.endian.disabled = endianLocked;
  controls.packing.disabled = packingLocked;
  syncLockedControls();
}

function syncLockedControls() {
  controls.width.disabled = Boolean(lockedFields.width);
  controls.height.disabled = Boolean(lockedFields.height);
  controls.channels.disabled = Boolean(lockedFields.channels);
  controls.pattern.disabled = Boolean(lockedFields.pattern);
  controls.channelOrder.disabled = Boolean(lockedFields.channelOrder);
}

function setZoom(value) {
  const numericValue = Number(value);
  zoomValue = Math.max(5, Math.min(800, Math.round(Number.isFinite(numericValue) ? numericValue : 100)));
  controls.zoom.value = String(zoomValue);
  controls.zoomLabel.textContent = `${zoomValue}%`;

  const displayWidth = Math.max(1, controls.canvas.width * zoomValue / 100);
  const displayHeight = Math.max(1, controls.canvas.height * zoomValue / 100);
  controls.canvas.style.width = `${displayWidth}px`;
  controls.canvas.style.height = `${displayHeight}px`;
  controls.canvas.style.imageRendering = zoomValue < 100 ? 'auto' : 'pixelated';
}

function fitToStage() {
  const width = controls.canvas.width || 1;
  const height = controls.canvas.height || 1;
  const availableWidth = Math.max(1, controls.stage.clientWidth - 32);
  const availableHeight = Math.max(1, controls.stage.clientHeight - 32);
  const zoom = Math.floor(Math.min(
    availableWidth / width,
    availableHeight / height
  ) * 100);
  setZoom(zoom);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
