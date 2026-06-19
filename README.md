# [VSCode Extension] RAW image preview

Preview RAW, Bayer, NumPy, PNM, and camera RAW buffers directly inside VS Code.

This extension is built for inspecting image data that does not always come with friendly metadata. It opens the file as a custom editor, guesses a useful initial layout when possible, and keeps the important RAW controls close at hand: dimensions, channels, bit depth, packing, endian, Bayer pattern, normalization, gain, zoom, and individual CFA planes.

## Highlights

- Opens headerless RAW-like buffers such as `.raw`, `.bin`, `.dat`, `.raw10`, `.raw12`, `.rggb`, `.bggr`, `.grbg`, `.gbrg`, `.bayer`, `.gray`, `.rgb`, `.u8`, `.u16`, `.i16`, `.f32`, and `.f64`.
- Reads `.npy` headers for dtype, shape, endian, and common 2D, HWC, CHW, NHWC, and NCHW image layouts.
- Reads binary `.pgm`, `.ppm`, and `.pnm` headers.
- Previews camera RAW files such as `.CR2`, `.NEF`, `.ARW`, `.DNG`, `.RAF`, `.RW2`, `.ORF`, `.PEF`, and `.SRW` through local Python `rawpy` and `numpy`.
- Supports 1-channel Bayer mosaics, 3-channel RGB buffers, and 4-channel Bayer pixel-shuffle buffers.
- Supports unsigned and signed integers, 16/32/64-bit floats, unpacked 8/10/12/14/16/24/32-bit samples, MIPI RAW10, and MIPI RAW12.
- Lets you inspect the full Bayer mosaic or the individual `R`, `G1`, `G2`, and `B` planes.

## Preview Controls

The editor opens with an inferred layout when the file has enough information. Header-aware formats lock the fields that are known from the file. Headerless RAW keeps the controls editable.

Useful controls:

- **Width / Height**: output image size for the selected layout.
- **Channels**: 1-channel Bayer mosaic, 3-channel RGB, or 4-channel Bayer pixel shuffle.
- **View**: full Bayer mosaic, grayscale luminance, or individual `R`, `G1`, `G2`, `B` components.
- **Bayer Pattern**: output CFA pattern: `RGGB`, `BGGR`, `GRBG`, or `GBRG`.
- **4-channel Order**: input channel order before shuffling into the selected Bayer pattern.
- **Bit Depth / Sample Type / Endian / Packing**: sample interpretation for raw byte buffers.
- **Auto normalize / Black / White / Gain**: practical exposure controls for dark or high-bit-depth data.
- **Guess / Fit / 1:1**: dimension guessing and viewport-friendly zoom.

## Bayer Layouts

For 1-channel Bayer input, the file is treated as a single mosaic. Component views sample the selected CFA positions into a half-resolution grayscale plane.

For 4-channel Bayer input, each logical pixel stores four samples. The preview expands an `HxWx4` buffer into a `(2H)x(2W)` Bayer mosaic. Set **4-channel Order** to describe how the file stores the four samples, then set **Bayer Pattern** to describe how they should appear on screen.

For example, output pattern `RGGB` places:

- even row, even column: `R`
- even row, odd column: `G1`
- odd row, even column: `G2`
- odd row, odd column: `B`

If the input order is `BGGR`, the preview reads blue from channel 0, green from channels 1 and 2, and red from channel 3, then shuffles those samples into the selected output pattern.

## Format Behavior

Headerless RAW files usually do not include width, height, bit depth, packing, endian, or Bayer layout. On open, the extension tries practical guesses from file name patterns, byte size, common sensor dimensions, packed RAW10/RAW12 byte counts, and padded 24-bit sensor dumps. If the guess is wrong, adjust the controls and render again.

For camera RAW files, VS Code asks Python to decode the sensor mosaic with `rawpy` and `numpy`. Install them in the Python environment visible to VS Code:

```powershell
python -m pip install rawpy numpy
```

`.npz` is intentionally not opened yet because it is a ZIP container that can hold multiple compressed arrays.

## Development

```powershell
npm install
npm test
npm run check
```

Run the extension locally:

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open a supported RAW-like file and choose **RAW image preview**.

Package a VSIX:

```powershell
npm run package
```

The test suite covers Bayer pixel shuffle, channel-plane extraction, visible-sample normalization, MIPI RAW10/RAW12 unpacking, 16-bit endian handling, packed byte counts, `.npy` HWC/CHW parsing, signed integer arrays, binary PNM parsing, and RAW dimension guessing.
