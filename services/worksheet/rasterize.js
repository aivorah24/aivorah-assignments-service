// PDF pages → PNG images (pdfjs rendered inside headless Chrome, the same
// Puppeteer dependency docx-to-pdf already uses). One image PER PAGE at OCR
// resolution: the old fallback stitched up to 4 pages into one ~108 dpi strip,
// which is too small for Indic OCR and too tall for vision models.
const fs = require('fs');

const DEFAULT_SCALE = 2.6; // ≈190 dpi — reliable for Telugu/Devanagari OCR

async function rasterizePdfPages(pdfBuffer, { maxPages = 12, scale = DEFAULT_SCALE } = {}) {
  const { launchBrowser } = require('../../utils/browser');
  const pdfjsSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.js'), 'utf8');
  const workerSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.js'), 'utf8');
  const browser = await launchBrowser(['--disable-dev-shm-usage']);
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: pdfjsSrc });
    await page.evaluate(async (b64, wSrc) => {
      // eslint-disable-next-line no-undef
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wSrc], { type: 'application/javascript' }));
      const raw = atob(b64);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      window.__doc = await lib.getDocument({ data }).promise;
    }, pdfBuffer.toString('base64'), workerSrc);
    const numPages = await page.evaluate(() => window.__doc.numPages);
    const out = [];
    // One page per evaluate call keeps each transfer small.
    for (let i = 1; i <= Math.min(numPages, maxPages); i++) {
      const r = await page.evaluate(async (n, s) => {
        const p = await window.__doc.getPage(n);
        const vp = p.getViewport({ scale: s });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await p.render({ canvasContext: ctx, viewport: vp }).promise;
        p.cleanup();
        return { url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
      }, i, scale);
      out.push({ page: i, buffer: Buffer.from(r.url.split(',')[1], 'base64'), width: r.width, height: r.height, scale });
    }
    return out;
  } finally {
    await browser.close();
  }
}

module.exports = { rasterizePdfPages, DEFAULT_SCALE };
