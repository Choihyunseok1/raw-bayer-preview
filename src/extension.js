const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { convertCameraRawToBuffer, cameraRawExtension } = require('./camera-raw');

const VIEW_TYPE = 'rawBayerPreview.viewer';

function activate(context) {
  const provider = new RawBayerPreviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rawBayerPreview.openPreview', async (uri) => {
      const target = uri || vscode.window.activeTextEditor?.document?.uri;
      if (!target) {
        vscode.window.showWarningMessage('Open or select a RAW file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    })
  );
}

class RawBayerPreviewProvider {
  constructor(context) {
    this.context = context;
  }

  async openCustomDocument(uri) {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    webview.html = this.getHtml(webview);

    const config = vscode.workspace.getConfiguration('rawBayerPreview');
    const initialSettings = {
      width: config.get('defaultWidth', 1920),
      height: config.get('defaultHeight', 1080),
      channels: config.get('defaultChannels', 4),
      displayMode: 'preview',
      pattern: config.get('defaultBayerPattern', 'RGGB'),
      channelOrder: config.get('defaultChannelOrder', 'RGGB'),
      bitDepth: config.get('defaultBitDepth', 8),
      sampleFormat: config.get('defaultSampleFormat', 'uint'),
      endian: config.get('defaultEndian', 'little'),
      packing: 'unpacked',
      black: 0,
      white: 0,
      gain: 1,
      normalize: true
    };
    const fileBytesPromise = loadPreviewBytes(document.uri, {
      pythonPath: config.get('pythonPath', '')
    });

    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        try {
          const payload = await fileBytesPromise;
          webview.postMessage({
            type: 'file',
            name: vscode.workspace.asRelativePath(document.uri),
            byteLength: payload.sourceByteLength,
            settings: { ...initialSettings, ...payload.settings },
            lockedFields: payload.lockedFields || {},
            format: payload.format || '',
            label: payload.label || '',
            buffer: exactArrayBuffer(payload.bytes)
          });
        } catch (error) {
          webview.postMessage({
            type: 'error',
            message: `Failed to read RAW file: ${error.message}`
          });
        }
      }
    });
  }

  getHtml(webview) {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
    const coreJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'raw-render-core.js'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${cssUri}" rel="stylesheet">
  <title>RAW image preview</title>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <div class="file">
        <strong id="fileName">RAW Preview</strong>
        <span id="fileMeta">Waiting for file...</span>
      </div>
      <label>Width <input id="width" type="number" min="1" step="1"></label>
      <label>Height <input id="height" type="number" min="1" step="1"></label>
      <label>Channels
        <select id="channels">
          <option value="1">1 channel</option>
          <option value="3">3 channels</option>
          <option value="4">4 channels Bayer shuffle</option>
        </select>
      </label>
      <label>View
        <select id="displayMode">
          <option value="preview">Image preview</option>
          <option value="mosaic">Bayer mosaic</option>
          <option value="r">R plane</option>
          <option value="g1">G1 plane</option>
          <option value="g2">G2 plane</option>
          <option value="b">B plane</option>
        </select>
      </label>
      <label>Bayer Pattern
        <select id="pattern">
          <option>RGGB</option>
          <option>BGGR</option>
          <option>GRBG</option>
          <option>GBRG</option>
        </select>
      </label>
      <label>4-channel Order
        <select id="channelOrder">
          <option>RGGB</option>
          <option>BGGR</option>
          <option>GRBG</option>
          <option>GBRG</option>
        </select>
      </label>
      <label>Bit Depth
        <select id="bitDepth">
          <option value="8">8-bit</option>
          <option value="10">10-bit</option>
          <option value="12">12-bit</option>
          <option value="14">14-bit</option>
          <option value="16">16-bit</option>
          <option value="24">24-bit</option>
          <option value="32">32-bit</option>
          <option value="64">64-bit</option>
        </select>
      </label>
      <label>Sample Type
        <select id="sampleFormat">
          <option value="uint">Unsigned integer</option>
          <option value="int">Signed integer</option>
          <option value="float">Float</option>
        </select>
      </label>
      <label>Endian
        <select id="endian">
          <option value="little">Little endian</option>
          <option value="big">Big endian</option>
        </select>
      </label>
      <label>Packing
        <select id="packing">
          <option value="unpacked">Unpacked samples</option>
          <option value="mipi10">MIPI RAW10 packed</option>
          <option value="mipi12">MIPI RAW12 packed</option>
        </select>
      </label>
      <label class="check"><input id="normalize" type="checkbox"> Auto normalize</label>
      <label>Black <input id="black" type="number" min="0" step="1"></label>
      <label>White <input id="white" type="number" min="0" step="1"></label>
      <label>Gain <input id="gain" type="range" min="0.1" max="8" step="0.1"></label>
      <div class="actions">
        <button id="render">Render</button>
        <button id="guess">Guess</button>
        <button id="fit">Fit</button>
        <button id="oneToOne">1:1</button>
      </div>
      <div id="status" class="status">Idle</div>
    </aside>
    <section class="viewer">
      <div class="toolbar">
        <button id="zoomOut" title="Zoom out">-</button>
        <input id="zoom" type="range" min="1" max="800" value="100">
        <button id="zoomIn" title="Zoom in">+</button>
        <span id="zoomLabel">100%</span>
      </div>
      <div id="stage" class="stage">
        <canvas id="canvas"></canvas>
      </div>
    </section>
  </main>
  <script nonce="${nonce}" src="${coreJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  return crypto.randomBytes(16).toString('base64');
}

async function loadPreviewBytes(uri, options = {}) {
  if (isCameraRawPath(uri.fsPath || uri.path || uri.toString())) {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Camera RAW decoding requires Workspace Trust because it runs Python/rawpy. Trust the workspace or open RAW/NumPy/PNM files that do not need Python decoding.');
    }
    return convertCameraRawUriToBuffer(uri, options);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    bytes,
    sourceByteLength: bytes.byteLength,
    settings: {},
    lockedFields: {},
    format: 'file',
    label: ''
  };
}

async function convertCameraRawUriToBuffer(uri, options = {}) {
  if (uri.scheme === 'file') {
    return convertCameraRawToBuffer(uri.fsPath, {
      ...options,
      sourceByteLength: fs.statSync(uri.fsPath).size,
      sourceName: uri.fsPath
    });
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const tempFile = await writeTempCameraRawFile(bytes, uri);
  try {
    return await convertCameraRawToBuffer(tempFile, {
      ...options,
      sourceByteLength: bytes.byteLength,
      sourceName: uri.path || uri.toString()
    });
  } finally {
    fs.promises.unlink(tempFile).catch(() => {});
  }
}

async function writeTempCameraRawFile(bytes, uri) {
  const extension = cameraRawExtension(uri.path || uri.fsPath || uri.toString()).toLowerCase();
  const suffix = extension === 'camera raw' ? 'raw' : extension;
  const name = `raw-bayer-preview-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${suffix}`;
  const tempFile = path.join(os.tmpdir(), name);
  await fs.promises.writeFile(tempFile, Buffer.from(bytes));
  return tempFile;
}

function isCameraRawPath(filePath) {
  return /\.(cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|rw2|orf|pef|srw)$/i.test(filePath);
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

module.exports = { activate };
