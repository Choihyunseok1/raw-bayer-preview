# RAW Bayer Preview

VS Code extension for previewing generic RAW image buffers in an interactive webview.

## Features

- Opens RAW-like binary files inside a VS Code custom editor.
- Supports 1-channel Bayer mosaic, 3-channel RGB, and 4-channel Bayer pixel-shuffle layouts.
- Supports Canon `.CR2` preview through local Python `rawpy`/`numpy` conversion when those packages are installed.
- Configurable Bayer patterns: `RGGB`, `BGGR`, `GRBG`, `GBRG`.
- Configurable 4-channel order, so buffers stored as `RGGB`, `BGGR`, `GRBG`, or `GBRG` can be shuffled into the selected Bayer pattern.
- View modes for the full Bayer mosaic or individual `R`, `G1`, `G2`, and `B` planes.
- Supports common sample layouts: unsigned/signed integer, 8/10/12/14/16/24/32-bit unpacked, 16/32/64-bit float, MIPI RAW10 packed, MIPI RAW12 packed.
- Auto-detects NumPy `.npy` array headers for dtype, shape, endian, and common HWC/CHW image layouts.
- Auto-detects binary PGM/PPM/PNM headers for image dimensions and max value.
- Interactive width, height, channels, bit depth, endian, black/white, normalize, gain, dimension guess, fit, and zoom controls.

## 4-channel Bayer shuffle assumption

For 4-channel input, each logical pixel contains four samples. Set **4-channel Order** to describe how those samples are stored in the file, then set **Bayer Pattern** to describe how they should be placed on screen.

The preview expands 4-channel packed Bayer data by 2x in each dimension. For example, an HxWx4 RGGB array is rendered as a `(2H)x(2W)` Bayer mosaic.

Use **View** to inspect one Bayer component at a time. For HxWx4 packed input, `R`, `G1`, `G2`, and `B` are shown as HxW grayscale planes. For 1-channel Bayer mosaic input, the selected CFA positions are sampled into a half-resolution grayscale plane.

For example, output pattern `RGGB` places:

- even row, even column: red
- even row, odd column: green
- odd row, even column: green
- odd row, odd column: blue

If the file channel order is `BGGR`, the preview pulls the blue sample from channel 0, green samples from channels 1/2, and red from channel 3, then shuffles them into the selected output pattern.

## Format notes

RAW buffers usually do not carry width, height, Bayer layout, or bit-depth metadata. Use the controls in the preview to set the layout. The **Guess** button can infer dimensions from filenames such as `frame_1920x1080.raw` or from common byte-size matches.

Header-aware formats:

- `.npy`: supports 2D grayscale/Bayer, HWC, CHW, single-batch NHWC/NCHW arrays with `uint8`, `uint16`, `uint32`, `int8`, `int16`, `int32`, `float16`, `float32`, and `float64` dtypes.
- `.pgm`, `.ppm`, `.pnm`: supports binary `P5` and `P6`.
- `.cr2`: uses the VS Code extension host to run Python `rawpy` and converts the camera RAW mosaic to an in-memory uint16 NPY preview. If Python `rawpy` or `numpy` is missing, the extension reports that dependency error instead of rendering the CR2 header as pixels.

Raw-like extensions opened with manual controls include `.raw`, `.bin`, `.dat`, `.rggb`, `.bggr`, `.grbg`, `.gbrg`, `.bayer`, `.mipi`, `.raw10`, `.raw12`, `.gray`, `.rgb`, `.u8`, `.u16`, `.i16`, `.f32`, `.f64`, `.y`, `.y8`, and `.y16`.

`.npz` is not treated as supported yet because it is a ZIP archive that may contain multiple arrays and compression.

## Local development

1. Install Node.js.
2. Open this folder in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. Open a supported RAW-like, `.npy`, `.pgm`, `.ppm`, or `.pnm` file with **RAW Bayer Preview**.

## Test and verify

```powershell
npm install
npm test
npm run check
```

The tests cover 4-channel Bayer pixel shuffle, visible-sample auto normalization, MIPI RAW10/RAW12 unpacking, 16-bit endian handling, packed-format byte counts, `.npy` HWC/CHW parsing, signed integer dtype handling, binary PGM parsing, and dimension guessing.

## Package VSIX

```powershell
npm install
npx vsce package
```

The generated `.vsix` can be attached to a GitHub release for personal distribution.
