// PNG/JPEG → Jimp bitmap via pngjs/jpeg-js. (Jimp.read sniffs formats via a
// dynamic import that some runtimes, e.g. jest, block.)
function jimpFromPng(buffer) {
  const { Jimp } = require('jimp');
  if (isJpeg(buffer)) {
    const jpg = require('jpeg-js').decode(buffer, { useTArray: true, formatAsRGBA: true });
    return new Jimp({ data: Buffer.from(jpg.data), width: jpg.width, height: jpg.height });
  }
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(buffer);
  return new Jimp({ data: png.data, width: png.width, height: png.height });
}

// PNG bytes via node's zlib (Jimp's own encoder is pure-JS deflate).
function pngBuffer(img) {
  const { PNG } = require('pngjs');
  const { width, height, data } = img.bitmap;
  // filterType 0: skips pngjs's per-row filter search (the slow part); size barely matters here.
  return PNG.sync.write({ width, height, data: Buffer.from(data.buffer, data.byteOffset, data.length) }, { filterType: 0 });
}

const isPng = b => Buffer.isBuffer(b) && b.length > 8 && b[0] === 0x89 && b[1] === 0x50;
const isJpeg = b => Buffer.isBuffer(b) && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
// PNG or JPEG — what the bitmap helpers here can decode.
const isDecodable = b => isPng(b) || isJpeg(b);

// Paints photo-like blocks (colourful or mid-grey) white so OCR sees only the
// printed words beside them — Tesseract's layout analysis drops isolated words
// that sit next to photos ("match the picture to the word"). Returns the
// fraction of the image masked.
function maskPhotos(img, block = 24, threshold = 0.3) {
  const { width: W, height: H, data: d } = img.bitmap;
  const bw = Math.ceil(W / block); const bh = Math.ceil(H / block);
  const photo = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let n = 0; let mid = 0;
      for (let y = by * block; y < Math.min(H, (by + 1) * block); y++) {
        for (let x = bx * block; x < Math.min(W, (bx + 1) * block); x++) {
          const o = (y * W + x) * 4;
          const r = d[o]; const g = d[o + 1]; const b = d[o + 2];
          const l = (r + g + b) / 3;
          n++;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 50 || (l > 90 && l < 200)) mid++;
        }
      }
      if (mid / n > threshold) photo[by * bw + bx] = 1;
    }
  }
  // Grow by one block so photo edges don't leave speckles.
  const grown = photo.slice();
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!photo[by * bw + bx]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = by + dy; const xx = bx + dx;
        if (yy >= 0 && xx >= 0 && yy < bh && xx < bw) grown[yy * bw + xx] = 1;
      }
    }
  }
  let masked = 0;
  for (let i = 0; i < grown.length; i++) {
    if (!grown[i]) continue;
    masked++;
    const by = Math.floor(i / bw); const bx = i % bw;
    for (let y = by * block; y < Math.min(H, (by + 1) * block); y++) {
      for (let x = bx * block; x < Math.min(W, (bx + 1) * block); x++) {
        const o = (y * W + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = 255;
      }
    }
  }
  return masked / grown.length;
}

// Table grid drawn inside a picture: rows/columns that are mostly ink.
// Returns cell rectangles (row-major) between the grid lines, or null when the
// picture isn't a table (fewer than 2 cells).
function findGridCells(img, { minCover = 0.6, minCellRatio = 0.08 } = {}) {
  const { width: W, height: H, data: d } = img.bitmap;
  const ink = (x, y) => {
    const o = (y * W + x) * 4;
    const r = d[o]; const g = d[o + 1]; const b = d[o + 2];
    return (r + g + b) / 3 < 200 || Math.max(r, g, b) - Math.min(r, g, b) > 50;
  };
  const lines = (len, span, at) => {
    const hits = [];
    for (let i = 0; i < len; i++) {
      let n = 0;
      for (let j = 0; j < span; j++) if (at(i, j)) n++;
      if (n / span >= minCover) hits.push(i);
    }
    // consecutive hits form one line
    const out = [];
    for (const i of hits) {
      if (out.length && i - out[out.length - 1][1] <= 2) out[out.length - 1][1] = i;
      else out.push([i, i]);
    }
    return out;
  };
  const rows = lines(H, W, (y, x) => ink(x, y));
  const cols = lines(W, H, (x, y) => ink(x, y));
  // Spans between lines (borders and slivers < minCellRatio dropped), noting
  // whether each is closed by a line on both sides.
  const cuts = (ls, len) => {
    const bounds = [{ at: 0, line: false }];
    for (const [a, b] of ls) { bounds.push({ at: a, line: true, end: true }); bounds.push({ at: b + 1, line: true }); }
    bounds.push({ at: len, line: false, end: true });
    const spans = [];
    for (let i = 0; i < bounds.length - 1; i += 2) {
      const a = bounds[i]; const b = bounds[i + 1];
      if (b.at - a.at >= Math.max(12, len * minCellRatio)) spans.push({ from: a.at, to: b.at, closed: a.line && b.line });
    }
    return spans;
  };
  const ys = cuts(rows, H); const xs = cuts(cols, W);
  // Only cells enclosed on all four sides: a framed picture has one such cell,
  // a real table has several.
  const cells = [];
  ys.forEach((r, ri) => xs.forEach((c) => {
    if (r.closed && c.closed) cells.push({ x: c.from, y: r.from, w: c.to - c.from, h: r.to - r.from, row: ri });
  }));
  return cells.length >= 2 ? cells : null;
}

module.exports = { jimpFromPng, pngBuffer, isPng, isJpeg, isDecodable, maskPhotos, findGridCells };
