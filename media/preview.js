const vscode = acquireVsCodeApi();
const renderCore = window.RawBayerRenderCore;

const controls = {
  fileName: document.getElementById('fileName'),
  fileMeta: document.getElementById('fileMeta'),
  width: document.getElementById('width'),
  height: document.getElementById('height'),
  channels: document.getElementById('channels'),
  pattern: document.getElementById('pattern'),
  channelOrder: document.getElementById('channelOrder'),
  bitDepth: document.getElementById('bitDepth'),
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

  raw = new Uint8Array(message.buffer);
  const settings = { ...message.settings, ...(restoredState.settings || {}) };
  const filenameGuess = !restoredState.settings
    ? renderCore.guessDimensions(message.byteLength, settings, message.name)
    : null;
  if (filenameGuess?.source === 'filename') {
    settings.width = filenameGuess.width;
    settings.height = filenameGuess.height;
  }

  applySettings(settings);
  controls.fileName.textContent = message.name;
  controls.fileMeta.textContent = `${formatBytes(message.byteLength)} loaded`;
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

for (const id of ['width', 'height', 'channels', 'pattern', 'channelOrder', 'bitDepth', 'endian', 'packing', 'normalize', 'black', 'white']) {
  controls[id].addEventListener('change', () => {
    if (id === 'packing') {
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
  controls.pattern.value = normalized.pattern;
  controls.channelOrder.value = normalized.channelOrder;
  controls.bitDepth.value = normalized.bitDepth;
  controls.endian.value = normalized.endian;
  controls.packing.value = normalized.packing;
  controls.normalize.checked = normalized.normalize;
  controls.black.value = normalized.black;
  controls.white.value = normalized.white;
  controls.gain.value = normalized.gain;
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
  controls.status.textContent = `Rendering ${settings.width} x ${settings.height}...`;
  persistSettings();

  await nextFrame();
  if (token !== renderToken) {
    return;
  }

  controls.canvas.width = settings.width;
  controls.canvas.height = settings.height;
  setZoom(zoomValue);

  let image;
  try {
    image = ctx.createImageData(settings.width, settings.height);
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
    pattern: controls.pattern.value,
    channelOrder: controls.channelOrder.value,
    bitDepth: Number(controls.bitDepth.value),
    endian: controls.endian.value,
    packing: controls.packing.value,
    normalize: controls.normalize.checked,
    black: Number(controls.black.value),
    white: Number(controls.white.value),
    gain: Number(controls.gain.value)
  };
}

function persistSettings() {
  vscode.setState({ settings: renderCore.normalizeSettings(readSettings()) });
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
  if (controls.packing.value === 'mipi10') {
    controls.bitDepth.value = '10';
    controls.bitDepth.disabled = true;
    return;
  }
  if (controls.packing.value === 'mipi12') {
    controls.bitDepth.value = '12';
    controls.bitDepth.disabled = true;
    return;
  }
  controls.bitDepth.disabled = false;
}

function setZoom(value) {
  zoomValue = Math.max(5, Math.min(800, Math.round(Number(value) || 100)));
  controls.zoom.value = String(zoomValue);
  controls.zoomLabel.textContent = `${zoomValue}%`;

  const displayWidth = Math.max(1, controls.canvas.width * zoomValue / 100);
  const displayHeight = Math.max(1, controls.canvas.height * zoomValue / 100);
  controls.canvas.style.width = `${displayWidth}px`;
  controls.canvas.style.height = `${displayHeight}px`;
}

function fitToStage() {
  const width = controls.canvas.width || 1;
  const height = controls.canvas.height || 1;
  const zoom = Math.floor(Math.min(
    (controls.stage.clientWidth - 32) / width,
    (controls.stage.clientHeight - 32) / height
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
