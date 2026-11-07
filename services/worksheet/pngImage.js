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

// Numbers and letters printed inside circles or ovals ("(2)", "(14)" in a
// match-the-columns chart, answer bubbles). OCR reads the ring as part of the
// glyphs and returns nothing, so the values never reach the quiz. Finds each
// closed ring that holds ink, and returns its inside with the ring painted
// out, to be read on its own. Boxes are in image pixels.
function findRingLabels(img, { maxRings = 40 } = {}) {
  const { width: W, height: H, data: d } = img.bitmap;
  if (W * H > 6e6) return [];
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (d[o + 3] > 128 && (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000 < 140) dark[i] = 1;
  }
  const label = new Int32Array(W * H);
  const rings = [];
  const stack = [];
  let next = 0;
  for (let start = 0; start < W * H; start++) {
    if (!dark[start] || label[start]) continue;
    next++;
    let x0 = W; let y0 = H; let x1 = 0; let y1 = 0; let n = 0;
    stack.push(start); label[start] = next;
    while (stack.length) {
      const i = stack.pop(); const x = i % W; const y = (i - x) / W;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dark[j] && !label[j]) { label[j] = next; stack.push(j); }
        }
      }
    }
    const w = x1 - x0 + 1; const h = y1 - y0 + 1;
    if (w < 14 || h < 12 || w > W * 0.5 || h > H * 0.5 || w / h > 4 || h / w > 2.5) continue;
    if (n / (w * h) > 0.4) continue; // filled shape, not an outline
    // An outline: none of its own ink in the middle, ink on all four sides.
    const id = next;
    const own = (x, y) => label[y * W + x] === id;
    let middle = 0;
    for (let y = y0 + Math.floor(h * 0.3); y < y0 + Math.ceil(h * 0.7); y++) {
      for (let x = x0 + Math.floor(w * 0.3); x < x0 + Math.ceil(w * 0.7); x++) if (own(x, y)) middle++;
    }
    if (middle > 0) continue;
    const cx = x0 + (w >> 1); const cy = y0 + (h >> 1);
    const hit = (xs, ys) => xs.some(x => ys.some(y => own(x, y)));
    const band = (a, b) => Array.from({ length: Math.max(1, b - a + 1) }, (_, k) => a + k);
    const sides = [
      hit(band(cx - 2, cx + 2), band(y0, y0 + Math.ceil(h * 0.2))),
      hit(band(cx - 2, cx + 2), band(y1 - Math.ceil(h * 0.2), y1)),
      hit(band(x0, x0 + Math.ceil(w * 0.2)), band(cy - 2, cy + 2)),
      hit(band(x1 - Math.ceil(w * 0.2), x1), band(cy - 2, cy + 2)),
    ];
    if (!sides.every(Boolean)) continue;
    rings.push({ id, x: x0, y: y0, w, h });
  }
  const { Jimp } = require('jimp');
  const out = [];
  for (const r of rings) {
    // The ink inside the ring (not the ring, not anything crossing it), as
    // clean black on white, trimmed to the glyphs with a white margin.
    const inside = [];
    let gx0 = W; let gy0 = H; let gx1 = -1; let gy1 = -1;
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        const i = y * W + x;
        if (!dark[i] || label[i] === r.id) continue;
        // Inside the oval, not in the corners of its box (lines pass there).
        const ex = (x - (r.x + r.w / 2)) / (r.w / 2); const ey = (y - (r.y + r.h / 2)) / (r.h / 2);
        if (ex * ex + ey * ey > 0.8) continue;
        inside.push(i);
        if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y;
      }
    }
    if (inside.length < 6 || gx1 < 0) continue; // an empty bubble
    const pad = Math.max(4, Math.round((gy1 - gy0 + 1) * 0.4));
    const gw = gx1 - gx0 + 1 + pad * 2; const gh = gy1 - gy0 + 1 + pad * 2;
    const glyphs = new Jimp({ width: gw, height: gh, color: 0xffffffff });
    const gd = glyphs.bitmap.data;
    for (const i of inside) {
      const x = i % W; const y = (i - x) / W;
      const o = ((y - gy0 + pad) * gw + (x - gx0 + pad)) * 4;
      gd[o] = 0; gd[o + 1] = 0; gd[o + 2] = 0;
    }
    out.push({ box: { x: r.x, y: r.y, w: r.w, h: r.h }, image: glyphs });
    if (out.length >= maxRings) break;
  }
  return out;
}

module.exports = { jimpFromPng, pngBuffer, isPng, isJpeg, isDecodable, maskPhotos, findGridCells, findRingLabels };
