const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');

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
      displayMode: 'mosaic',
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
    const fileBytesPromise = loadPreviewBytes(document.uri);

    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        try {
          const payload = await fileBytesPromise;
          webview.postMessage({
            type: 'file',
            name: vscode.workspace.asRelativePath(document.uri),
            byteLength: payload.sourceByteLength,
            settings: { ...initialSettings, ...payload.settings },
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
  <title>RAW Bayer Preview</title>
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
        <input id="zoom" type="range" min="5" max="800" value="100">
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

async function loadPreviewBytes(uri) {
  if (uri.scheme === 'file' && isCr2Path(uri.fsPath)) {
    return convertCr2ToNpy(uri.fsPath);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    bytes,
    sourceByteLength: bytes.byteLength,
    settings: {}
  };
}

function isCr2Path(filePath) {
  return /\.cr2$/i.test(filePath);
}

function convertCr2ToNpy(filePath) {
  const script = `
import json
import sys

try:
    import numpy as np
    import rawpy
except Exception as exc:
    print("RAW_BAYER_PREVIEW_ERROR " + str(exc), file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]
with rawpy.imread(path) as raw:
    image = raw.raw_image_visible.copy()
    color_desc = raw.color_desc.decode("ascii", errors="ignore") if isinstance(raw.color_desc, bytes) else str(raw.color_desc)
    pattern = "".join(color_desc[int(raw.raw_pattern[y, x])][:1] for y in range(2) for x in range(2))
    black_levels = [float(value) for value in raw.black_level_per_channel]
    metadata = {
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "pattern": pattern if len(pattern) == 4 else "RGGB",
        "black": min(black_levels) if black_levels else 0,
        "white": float(raw.white_level) if raw.white_level is not None else 0
    }

image = np.ascontiguousarray(image.astype(np.uint16, copy=False))
np.save(sys.stdout.buffer, image, allow_pickle=False)
print("RAW_BAYER_PREVIEW_META " + json.dumps(metadata), file=sys.stderr)
`;

  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-c', script, filePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    let stdoutLength = 0;
    let stderrText = '';

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(cr2ErrorMessage(stderrText)));
        return;
      }
      const metadata = parseCr2Metadata(stderrText);
      resolve({
        bytes: Buffer.concat(stdout, stdoutLength),
        sourceByteLength: fs.statSync(filePath).size,
        settings: {
          width: metadata.width,
          height: metadata.height,
          channels: 1,
          pattern: metadata.pattern,
          bitDepth: 16,
          sampleFormat: 'uint',
          endian: 'little',
          packing: 'unpacked',
          black: metadata.black,
          white: metadata.white
        }
      });
    });
  });
}

function parseCr2Metadata(stderrText) {
  const line = stderrText
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('RAW_BAYER_PREVIEW_META '));
  if (!line) {
    return {};
  }
  try {
    return JSON.parse(line.slice('RAW_BAYER_PREVIEW_META '.length));
  } catch {
    return {};
  }
}

function cr2ErrorMessage(stderrText) {
  const line = stderrText
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('RAW_BAYER_PREVIEW_ERROR '));
  const detail = line ? line.slice('RAW_BAYER_PREVIEW_ERROR '.length) : stderrText.trim();
  return `Failed to decode CR2. Install Python rawpy/numpy for CR2 support. ${detail}`;
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

module.exports = { activate };
