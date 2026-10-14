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
  // Ink relative to the paper: print in a soft phone photo is mid-grey.
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { lum[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; hist[lum[i]]++; }
  let paper = 255;
  for (let v = 0, n = 0; v < 256; v++) { n += hist[v]; if (n >= W * H / 2) { paper = v; break; } }
  const cut = Math.min(200, paper * 0.78);
  const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lum[y * W + x] < cut;
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
      // Rows overlapping the stroke above join it: a soft (photographed)
      // stroke's rows differ in length at the ends.
      const s = strokes.find(t => t.y1 >= y - 1 && Math.min(t.x1, x1) - Math.max(t.x0, x0) + 1 >= 0.7 * Math.min(len, t.x1 - t.x0 + 1));
      if (s) { s.y1 = y; s.x0 = Math.min(s.x0, x0); s.x1 = Math.max(s.x1, x1); } else strokes.push({ x0, x1, y0: y, y1: y });
    }
  }
  // Ink band next to a stroke: skip the gap, then take rows with ink until a
  // blank row. dir -1 = above, +1 = below.
  const band = (s, dir, reach) => {
    const pad = Math.round((s.x1 - s.x0) * 0.25) + 2;
    const x0 = Math.max(0, s.x0 - pad); const x1 = Math.min(W - 1, s.x1 + pad);
    // Up to two rows right next to the bar with a pixel or two of ink are its
    // blur halo (photos), not a digit.
    const halo = Math.max(2, Math.round((x1 - x0) * 0.08));
    let y = dir < 0 ? s.y0 - 1 : s.y1 + 1;
    let gap = 0;
    while (gap < 2 && y >= 0 && y < H && rowInk(x0, x1, y) > 0 && rowInk(x0, x1, y) <= halo) { y += dir; gap++; }
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
    const len = s.x1 - s.x0 + 1;
    if (s.y1 - s.y0 > Math.max(4, len * 0.3)) continue;
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
  // An answer box is at least as tall as the digits (a loop of an "8" is not).
  return {
    bars: bars.filter(b => Math.min(b.num.h, b.den.h) >= typical * 0.6),
    boxes: boxes.filter(b => b.h >= typical * 0.9 && b.w >= typical * 0.9),
  };
}

// Skew of a photographed page, in degrees (rotate by the negative to
// straighten). Text rows give the sharpest horizontal ink profile when level:
// the angle whose row histogram has the highest variance wins.
function estimateSkew(img, { maxDeg = 6 } = {}) {
  const small = img.clone();
  if (small.bitmap.width > 700) small.resize({ w: 700 });
  const { width: W, height: H, data: d } = small.bitmap;
  const dark = (x, y) => { const o = (y * W + x) * 4; return (d[o] + d[o + 1] + d[o + 2]) / 3 < 110; };
  // Only text-like ink: blocks mostly dark (the table the sheet lies on, a
  // photo, a filled shape) are left out — their edges would decide the angle.
  const B = 12; const bw = Math.ceil(W / B);
  const solid = new Uint8Array(bw * Math.ceil(H / B));
  for (let by = 0; by * B < H; by++) {
    for (let bx = 0; bx * B < W; bx++) {
      let n = 0; let all = 0;
      for (let y = by * B; y < Math.min(H, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x++) { all++; if (dark(x, y)) n++; }
      solid[by * bw + bx] = n / all > 0.45 ? 1 : 0;
    }
  }
  const nearSolid = (x, y) => {
    const bx = Math.floor(x / B); const by = Math.floor(y / B);
    for (let j = by - 1; j <= by + 1; j++) for (let i = bx - 1; i <= bx + 1; i++) if (i >= 0 && j >= 0 && i < bw && solid[j * bw + i]) return true;
    return false;
  };
  const xs = []; const ys = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (dark(x, y) && !nearSolid(x, y)) { xs.push(x - W / 2); ys.push(y); }
    }
  }
  if (xs.length < 200) return 0;
  const sharpness = (deg) => {
    const t = Math.tan(deg * Math.PI / 180);
    const bins = new Float64Array(H + W);
    const off = W / 2;
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] - xs[i] * t + off)]++;
    let sum = 0; let sq = 0;
    for (const v of bins) { sum += v; sq += v * v; }
    return sq / bins.length - (sum / bins.length) ** 2;
  };
  let best = 0; let bestScore = sharpness(0);
  for (let deg = -maxDeg; deg <= maxDeg; deg += 0.5) {
    const sc = sharpness(deg);
    if (sc > bestScore) { best = deg; bestScore = sc; }
  }
  for (let deg = best - 0.4; deg <= best + 0.4; deg += 0.1) {
    const sc = sharpness(deg);
    if (sc > bestScore) { best = deg; bestScore = sc; }
  }
  return Math.round(best * 10) / 10;
}

// A photo straightened (white fill), or the same buffer when it is level.
function straighten(buffer) {
  if (!isDecodable(buffer)) return buffer;
  const img = jimpFromPng(buffer);
  const skew = estimateSkew(img);
  if (Math.abs(skew) < 0.3) return buffer;
  const { width: W, height: H } = img.bitmap;
  const { Jimp } = require('jimp');
  const canvas = new Jimp({ width: W, height: H, color: 0xffffffff });
  img.rotate({ deg: skew, mode: true });
  // rotate() grows the canvas; keep the original size, centred.
  canvas.composite(img, Math.round((W - img.bitmap.width) / 2), Math.round((H - img.bitmap.height) / 2));
  // Corners uncovered by the rotation come out transparent/black: paint white.
  const d = canvas.bitmap.data;
  for (let o = 0; o < d.length; o += 4) if (d[o + 3] < 255) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255; }
  return pngBuffer(canvas);
}

// Pictures inside a photographed page (a photo has no embedded images to cut
// out): ink that is not a line of OCR'd text and not the surface the sheet
// lies on, grouped into regions. `textBoxes` are the page OCR's text lines
// ({x, y, w, h} in image px). A region whose ink is only on its border once
// the text is removed — a frame round text, a table — is marked `frame`.
// Returns [{x, y, w, h, frame}] in image px.
function findPictureRegions(img, textBoxes = [], { minArea = 0.01 } = {}) {
  const { width: W0, height: H0 } = img.bitmap;
  const k = Math.min(1, 800 / Math.max(W0, H0));
  const small = img.clone();
  if (k < 1) small.resize({ w: Math.round(W0 * k), h: Math.round(H0 * k) });
  const { width: W, height: H, data: d } = small.bitmap;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[i * 4]; const g = d[i * 4 + 1]; const b = d[i * 4 + 2];
    if ((r + g + b) / 3 < 150 || Math.max(r, g, b) - Math.min(r, g, b) > 60) ink[i] = 1;
  }
  // The surface around the sheet: mostly-dark blocks connected to the edge.
  const B = 8; const bw = Math.ceil(W / B); const bh = Math.ceil(H / B);
  const dark = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let n = 0; let all = 0;
      for (let y = by * B; y < Math.min(H, by * B + B); y++) for (let x = bx * B; x < Math.min(W, bx * B + B); x++) { all++; n += ink[y * W + x]; }
      dark[by * bw + bx] = n / all > 0.6 ? 1 : 0;
    }
  }
  const bg = new Uint8Array(bw * bh);
  const stack = [];
  for (let bx = 0; bx < bw; bx++) { stack.push(bx, (bh - 1) * bw + bx); }
  for (let by = 0; by < bh; by++) { stack.push(by * bw, by * bw + bw - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !dark[i]) continue;
    bg[i] = 1;
    const bx = i % bw; const by = (i - bx) / bw;
    if (bx > 0) stack.push(i - 1); if (bx < bw - 1) stack.push(i + 1);
    if (by > 0) stack.push(i - bw); if (by < bh - 1) stack.push(i + bw);
  }
  // The sheet's bounds (non-background blocks).
  let sx0 = W; let sy0 = H; let sx1 = 0; let sy1 = 0;
  for (let i = 0; i < bw * bh; i++) {
    if (bg[i]) continue;
    const bx = i % bw; const by = (i - bx) / bw;
    sx0 = Math.min(sx0, bx * B); sy0 = Math.min(sy0, by * B); sx1 = Math.max(sx1, bx * B + B); sy1 = Math.max(sy1, by * B + B);
  }
  if (sx1 <= sx0 || sy1 <= sy0) return [];
  const m = 2 * B; // the sheet's own edge shading
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bi = Math.floor(y / B) * bw + Math.floor(x / B);
      if (bg[bi] || x < sx0 + m || y < sy0 + m || x >= sx1 - m || y >= sy1 - m) ink[y * W + x] = 0;
    }
  }
  for (const t of textBoxes) {
    const x0 = Math.max(0, Math.floor(t.x * k) - 1); const y0 = Math.max(0, Math.floor(t.y * k) - 1);
    const x1 = Math.min(W - 1, Math.ceil((t.x + t.w) * k) + 1); const y1 = Math.min(H - 1, Math.ceil((t.y + t.h) * k) + 1);
    for (let y = y0; y <= y1; y++) ink.fill(0, y * W + x0, y * W + x1 + 1);
  }
  // Group: ink within R px joins a region.
  const R = 6;
  const seen = new Int32Array(W * H).fill(-1);
  const regions = [];
  for (let i = 0; i < W * H; i++) {
    if (!ink[i] || seen[i] >= 0) continue;
    const id = regions.length;
    const reg = { x0: W, y0: H, x1: 0, y1: 0, n: 0 };
    const q = [i]; seen[i] = id;
    while (q.length) {
      const j = q.pop();
      const x = j % W; const y = (j - x) / W;
      reg.n++;
      if (x < reg.x0) reg.x0 = x; if (x > reg.x1) reg.x1 = x; if (y < reg.y0) reg.y0 = y; if (y > reg.y1) reg.y1 = y;
      for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++) {
        for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) {
          const o = yy * W + xx;
          if (ink[o] && seen[o] < 0) { seen[o] = id; q.push(o); }
        }
      }
    }
    regions.push(reg);
  }
  const sheetArea = (sx1 - sx0) * (sy1 - sy0);
  const out = [];
  for (const r of regions) {
    const w = r.x1 - r.x0 + 1; const h = r.y1 - r.y0 + 1;
    if (w * h < sheetArea * minArea || w < (sx1 - sx0) * 0.05 || h < (sy1 - sy0) * 0.03) continue;
    if (w * h > sheetArea * 0.6) continue;
    // Ink away from the region's border (a frame has none).
    const ix0 = r.x0 + Math.round(w * 0.1); const ix1 = r.x1 - Math.round(w * 0.1);
    const iy0 = r.y0 + Math.round(h * 0.1); const iy1 = r.y1 - Math.round(h * 0.1);
    let inner = 0;
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) inner += ink[y * W + x];
    const frame = inner < Math.max(1, (ix1 - ix0) * (iy1 - iy0)) * 0.01;
    out.push({ x: Math.max(0, Math.floor(r.x0 / k) - 4), y: Math.max(0, Math.floor(r.y0 / k) - 4), w: Math.min(W0, Math.ceil(w / k) + 8), h: Math.min(H0, Math.ceil(h / k) + 8), frame });
  }
  return out.map(b => ({ ...b, w: Math.min(b.w, W0 - b.x), h: Math.min(b.h, H0 - b.y) }));
}

// Answer lines printed on a page ("4 kg = ______ gm"): long, thin, free
// horizontal strokes with nothing written on them. OCR drops them. Returns
// [{x0, x1, y}] in image px; minLen ≈ the width of three letters.
function findUnderlines(img, { minLen = 30 } = {}) {
  const { width: W, height: H, data: d } = img.bitmap;
  const lum = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { lum[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; hist[lum[i]]++; }
  let paper = 255;
  for (let v = 0, n = 0; v < 256; v++) { n += hist[v]; if (n >= W * H / 2) { paper = v; break; } }
  const cut = Math.min(200, paper * 0.75);
  const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lum[y * W + x] < cut;
  const strokes = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink(x, y)) { x++; continue; }
      const x0 = x;
      while (x < W && (ink(x, y) || ink(x + 1, y))) x++; // a 1-px gap in a dotted/soft line
      const len = x - x0;
      if (len < 8) continue;
      const s = strokes.find(t => t.y1 >= y - 1 && Math.min(t.x1, x - 1) - Math.max(t.x0, x0) >= 0.7 * Math.min(len, t.x1 - t.x0));
      if (s) { s.y1 = y; s.x0 = Math.min(s.x0, x0); s.x1 = Math.max(s.x1, x - 1); } else strokes.push({ x0, x1: x - 1, y0: y, y1: y });
    }
  }
  // Pieces of one rule (a soft photo breaks a long line into dashes) are
  // joined, so a box edge or a page rule is judged by its full length.
  strokes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const joined = [];
  for (const s of strokes) {
    if (s.y1 - s.y0 > 5) continue;
    const prev = joined.find(t => Math.abs(t.y0 - s.y0) <= 2 && s.x0 - t.x1 <= 8 && s.x0 >= t.x0);
    if (prev) { prev.x1 = Math.max(prev.x1, s.x1); prev.y1 = Math.max(prev.y1, s.y1); } else joined.push({ ...s });
  }
  const out = [];
  for (const s of joined) {
    const len = s.x1 - s.x0 + 1;
    if (len < minLen || len > W * 0.5) continue;
    // Empty above (a blank, not underlined text) and no box sides at the ends.
    let above = 0;
    for (let y = s.y0 - 3; y >= Math.max(0, s.y0 - Math.round(len * 0.25)); y--) for (let x = s.x0; x <= s.x1; x++) if (ink(x, y)) above++;
    if (above > len * 0.6) continue;
    let sides = 0;
    for (const x of [s.x0, s.x1]) { let n = 0; while (ink(x, s.y0 - n - 1)) n++; let m = 0; while (ink(x, s.y1 + m + 1)) m++; if (n > 8 || m > 8) sides++; }
    if (sides) continue;
    out.push({ x0: s.x0, x1: s.x1, y: s.y0 });
  }
  return out;
}

module.exports = { jimpFromPng, pngBuffer, isPng, isJpeg, isDecodable, maskPhotos, findGridCells, findFractionBars, estimateSkew, straighten, findPictureRegions, findUnderlines };
