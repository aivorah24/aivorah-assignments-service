// Page renders are PNG: decode them with pngjs into a Jimp bitmap. (Jimp.read
// sniffs formats via a dynamic import that some runtimes, e.g. jest, block.)
function jimpFromPng(buffer) {
  const { PNG } = require('pngjs');
  const { Jimp } = require('jimp');
  const png = PNG.sync.read(buffer);
  return new Jimp({ data: png.data, width: png.width, height: png.height });
}

const isPng = b => Buffer.isBuffer(b) && b.length > 8 && b[0] === 0x89 && b[1] === 0x50;

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

module.exports = { jimpFromPng, isPng, maskPhotos };
