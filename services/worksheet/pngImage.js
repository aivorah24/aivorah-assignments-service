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

// Stacked fractions and answer boxes in a picture. A fraction bar is a short,
// thin horizontal stroke with ink directly above and below it and open ends;
// an answer box (□) is a stroke whose two ends turn down into vertical sides.
// Returns each bar with the numerator/denominator bands to read, and the boxes.
function findFractionBars(img) {
  const { width: W, height: H, data: d } = img.bitmap;
  const ink = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const o = (y * W + x) * 4;
    return (d[o] + d[o + 1] + d[o + 2]) / 3 < 150;
  };
  const rowInk = (x0, x1, y) => { let n = 0; for (let x = x0; x <= x1; x++) if (ink(x, y)) n++; return n; };
  // Horizontal runs, stacked into strokes (≤ 4 px thick).
  const minLen = 6; const maxLen = Math.max(minLen + 1, Math.round(W * 0.35));
  const strokes = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink(x, y)) { x++; continue; }
      const x0 = x;
      while (x < W && ink(x, y)) x++;
      const x1 = x - 1;
      const len = x1 - x0 + 1;
      if (len < minLen || len > maxLen) continue;
      const s = strokes.find(t => t.y1 >= y - 1 && Math.abs(t.x0 - x0) <= 2 && Math.abs(t.x1 - x1) <= 2);
      if (s) s.y1 = y; else strokes.push({ x0, x1, y0: y, y1: y });
    }
  }
  // Ink band next to a stroke: skip the gap, then take rows with ink until a
  // blank row. dir -1 = above, +1 = below.
  const band = (s, dir, reach) => {
    const pad = Math.round((s.x1 - s.x0) * 0.25) + 2;
    const x0 = Math.max(0, s.x0 - pad); const x1 = Math.min(W - 1, s.x1 + pad);
    let y = dir < 0 ? s.y0 - 1 : s.y1 + 1;
    let gap = 0;
    while (y >= 0 && y < H && gap < reach && rowInk(x0, x1, y) === 0) { y += dir; gap++; }
    if (gap >= reach || y < 0 || y >= H) return null;
    const start = y;
    while (y >= 0 && y < H && Math.abs(y - start) < reach * 2 && rowInk(x0, x1, y) > 0) y += dir;
    const top = Math.min(start, y - dir); const bottom = Math.max(start, y - dir);
    // Horizontal extent of the band's ink.
    let lx = x1; let rx = x0;
    for (let yy = top; yy <= bottom; yy++) for (let xx = x0; xx <= x1; xx++) if (ink(xx, yy)) { lx = Math.min(lx, xx); rx = Math.max(rx, xx); }
    return { x: lx, y: top, w: rx - lx + 1, h: bottom - top + 1 };
  };
  // Vertical ink run from (x, y) in direction dir.
  const vrun = (x, y, dir) => { let n = 0; while (ink(x, y + dir * (n + 1)) || ink(x + 1, y + dir * (n + 1)) || ink(x - 1, y + dir * (n + 1))) n++; return n; };
  const bars = []; const boxes = [];
  for (const s of strokes) {
    if (s.y1 - s.y0 > 3) continue;
    const len = s.x1 - s.x0 + 1;
    const down = Math.min(vrun(s.x0, s.y1, 1), vrun(s.x1, s.y1, 1));
    if (down >= len * 0.6) {
      // A box: the sides close on a bottom edge as long as the top one.
      const by = s.y1 + down;
      // …and is empty inside (a dark patch in a photo is not an answer box).
      let filled = 0;
      for (let y = s.y1 + 3; y < by - 2; y++) filled += rowInk(s.x0 + 3, s.x1 - 3, y);
      const area = Math.max(1, (by - s.y1 - 5) * (len - 6));
      if (len >= 10 && down <= len * 1.6 && rowInk(s.x0, s.x1, by) >= len * 0.8 && filled / area < 0.05) boxes.push({ x: s.x0, y: s.y0, w: len, h: by - s.y0 + 1 });
      continue;
    }
    if (Math.max(vrun(s.x0, s.y0, -1), vrun(s.x1, s.y0, -1)) >= len * 0.6) continue; // a box's bottom edge
    // A bar stands free: blank rows right above and below it (the top of a
    // "7" or "5" runs straight into the rest of the digit).
    if (rowInk(s.x0, s.x1, s.y0 - 1) > len * 0.3 || rowInk(s.x0, s.x1, s.y1 + 1) > len * 0.3) continue;
    const reach = Math.max(6, Math.round(len * 0.8));
    const num = band(s, -1, reach); const den = band(s, 1, reach);
    if (!num || !den) continue;
    // Digits sit centred over the bar and are no wider than ~1.6× it.
    const cx = (s.x0 + s.x1) / 2;
    const centred = b => Math.abs(b.x + b.w / 2 - cx) < len * 0.6 && b.w <= len * 1.6 + 4 && b.h >= 5 && b.h <= len * 2.5;
    if (!centred(num) || !centred(den)) continue;
    bars.push({ x0: s.x0, x1: s.x1, y: s.y0, num, den });
  }
  // Real fractions share one digit size: drop strokes inside smaller glyphs.
  const heights = bars.map(b => Math.max(b.num.h, b.den.h)).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || 0;
  return { bars: bars.filter(b => Math.min(b.num.h, b.den.h) >= typical * 0.6), boxes };
}

module.exports = { jimpFromPng, pngBuffer, isPng, isJpeg, isDecodable, maskPhotos, findGridCells, findFractionBars };
