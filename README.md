# RAW Bayer Preview

VS Code extension for previewing generic RAW image buffers in an interactive webview.

## Features

- Opens RAW-like binary files inside a VS Code custom editor.
- Supports 1-channel Bayer mosaic, 3-channel RGB, and 4-channel Bayer pixel-shuffle layouts.
- Configurable Bayer patterns: `RGGB`, `BGGR`, `GRBG`, `GBRG`.
- Configurable 4-channel order, so buffers stored as `RGGB`, `BGGR`, `GRBG`, or `GBRG` can be shuffled into the selected Bayer pattern.
- Supports common sample layouts: 8-bit, 10/12/14/16-bit unpacked, 32-bit float, MIPI RAW10 packed, MIPI RAW12 packed.
- Interactive width, height, channels, bit depth, endian, black/white, normalize, gain, dimension guess, fit, and zoom controls.

## 4-channel Bayer shuffle assumption

For 4-channel input, each logical pixel contains four samples. Set **4-channel Order** to describe how those samples are stored in the file, then set **Bayer Pattern** to describe how they should be placed on screen.

For example, output pattern `RGGB` places:

- even row, even column: red
- even row, odd column: green
- odd row, even column: green
- odd row, odd column: blue

If the file channel order is `BGGR`, the preview pulls the blue sample from channel 0, green samples from channels 1/2, and red from channel 3, then shuffles them into the selected output pattern.

## Format notes

RAW buffers usually do not carry width, height, Bayer layout, or bit-depth metadata. Use the controls in the preview to set the layout. The **Guess** button can infer dimensions from filenames such as `frame_1920x1080.raw` or from common byte-size matches.

## Local development

1. Install Node.js.
2. Open this folder in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. Open a `.raw`, `.bin`, `.dat`, `.rggb`, `.bggr`, `.grbg`, or `.gbrg` file with **RAW Bayer Preview**.

## Test and verify

```powershell
npm install
npm test
npm run check
```

The tests cover 4-channel Bayer pixel shuffle, visible-sample auto normalization, MIPI RAW10/RAW12 unpacking, 16-bit endian handling, packed-format byte counts, and dimension guessing.

## Package VSIX

```powershell
npm install
npx vsce package
```

The generated `.vsix` can be attached to a GitHub release for personal distribution.
