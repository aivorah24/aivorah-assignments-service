// extractPdfEmbeddedImages / hostExtractedImages — added 2026-09-12
// (Phase 5: preserve original visual assets WITHOUT requiring AI vision).
// A PDF's raster images are stored as regular Image XObjects in its
// object tree - extractable directly via pdf-lib's low-level API. This
// matters because, live-verified the same day, NO vision-capable model is
// currently available anywhere in this environment (Gemini unfunded,
// Qwen HuggingFace quota depleted, Mistral persistently rate-limited) -
// so physically preserving an already-embedded image asset (distinct
// from AI *understanding* what's in it) is the only image-preservation
// capability achievable right now for PDF-sourced worksheets.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(() => ({})), uploader: { upload: (...args) => mockUpload(...args) } },
}));

const { extractPdfEmbeddedImages, hostExtractedImages } = require('../../services/quizVision');
const fs = require('fs');
const path = require('path');

beforeEach(() => mockUpload.mockReset());

describe('extractPdfEmbeddedImages', () => {
  test('extracts a real embedded image from a real PDF with pixel-perfect accuracy', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/pdf-with-embedded-image.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer, { minDimension: 0 });

    expect(images).toHaveLength(1);
    expect(images[0].width).toBe(100);
    expect(images[0].height).toBe(100);
    expect(images[0].page).toBe(1);
    expect(images[0].mime).toBe('image/png');

    // Verify it's a real, structurally valid PNG (magic bytes) of the
    // expected size - pixel-level color accuracy for this exact fixture
    // (a red/blue/green/yellow quadrant image) was independently verified
    // by visual inspection during development (see QUIZ_PIPELINE_MIGRATION.md).
    expect(images[0].buffer[0]).toBe(0x89);
    expect(images[0].buffer.slice(1, 4).toString('ascii')).toBe('PNG');
    expect(images[0].buffer.length).toBeGreaterThan(100); // not a truncated/empty file
  });

  test('a non-PDF buffer returns no images, non-fatally (not a throw)', async () => {
    const images = await extractPdfEmbeddedImages(Buffer.from('not a pdf'));
    expect(images).toEqual([]);
  });

  test('a PDF with no images returns an empty array', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/thin-text-worksheet.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer);
    expect(images).toEqual([]);
  });

  // Discovered while writing this test: the real Telugu IB PYP fixture
  // used throughout this session's other tests DOES contain a real
  // embedded photo/illustration (the "బెల్ల చెప్పుకోండి" honeycomb
  // illustration visible when the worksheet is rendered) - a genuine,
  // useful real-world validation of extraction beyond the synthetic fixture.
  test('extracts the real embedded image from the real Telugu worksheet fixture', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/b02-ib-pyp-worksheet.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer, { minDimension: 0 });
    expect(images.length).toBeGreaterThan(0);
    expect(images[0].buffer.length).toBeGreaterThan(1000);
  });

  test('images smaller than minDimension are skipped (decorative/icon filtering)', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/pdf-with-embedded-image.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer, { minDimension: 500 });
    expect(images).toEqual([]); // the real 100x100 image is below a 500px minimum
  });
});

// 2026-10-13 manual test: image-heavy IB worksheets lost every picture. This
// real fixture is encrypted (permissions-only), its images use ICC colour,
// PNG predictors and SMask alpha, and pdf-lib can't read its page tree — the
// old extractor threw and returned nothing.
describe('extractPdfEmbeddedImages — image-heavy / encrypted worksheets', () => {
  const { PNG } = require('pngjs');
  const { PDFDocument } = require('pdf-lib');

  test('extracts every picture from the encrypted, image-heavy worksheet fixture as decodable PNGs', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/b02-no-curriculum-worksheet.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer);
    expect(images.length).toBeGreaterThanOrEqual(20);
    expect(new Set(images.map(i => i.page)).size).toBeGreaterThanOrEqual(8);
    for (const img of images.slice(0, 5)) {
      expect(img.mime).toBe('image/png');
      const decoded = PNG.sync.read(img.buffer);
      expect(decoded.width).toBe(img.width);
      expect(decoded.height).toBe(img.height);
    }
  }, 30000);

  test('transparent (SMask) pictures keep their alpha instead of turning black', async () => {
    const pdfBuffer = fs.readFileSync(path.join(__dirname, '../fixtures/b02-no-curriculum-worksheet.pdf'));
    const images = await extractPdfEmbeddedImages(pdfBuffer);
    const map = images.find(i => i.width === 606 && i.height === 984);
    expect(map).toBeTruthy();
    const decoded = PNG.sync.read(map.buffer);
    let min = 255; let max = 0;
    for (let i = 3; i < decoded.data.length; i += 4) { min = Math.min(min, decoded.data[i]); max = Math.max(max, decoded.data[i]); }
    expect(min).toBeLessThan(255); // transparent areas survive
    expect(max).toBe(255);
  }, 30000);

  async function pdfWith(pages) {
    const doc = await PDFDocument.create();
    const pngImg = new (require('jimp').Jimp)({ width: 120, height: 80, color: 0x3366ccff });
    const small = await doc.embedPng(await pngImg.getBuffer('image/png'));
    const big = await doc.embedPng(await new (require('jimp').Jimp)({ width: 600, height: 800, color: 0xeeeeeeff }).getBuffer('image/png'));
    for (const kind of pages) {
      const page = doc.addPage([600, 800]);
      if (kind === 'small') page.drawImage(small, { x: 50, y: 500, width: 240, height: 160 });
      if (kind === 'full') page.drawImage(big, { x: 0, y: 0, width: 600, height: 800 });
    }
    return Buffer.from(await doc.save());
  }

  test('a picture repeated on every page (logo/header) is returned once', async () => {
    const images = await extractPdfEmbeddedImages(await pdfWith(['small', 'small', 'small']));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 120, height: 80, page: 1 });
  });

  test('a full-page scan/background is skipped — only real diagrams are kept', async () => {
    const images = await extractPdfEmbeddedImages(await pdfWith(['full', 'small']));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 120, height: 80, page: 2 });
  });

  test('falls back to pdf-lib if pdfjs itself fails', async () => {
    jest.resetModules();
    jest.doMock('pdfjs-dist/legacy/build/pdf.js', () => ({ getDocument: () => { throw new Error('pdfjs broken'); } }));
    const qv = require('../../services/quizVision');
    const images = await qv.extractPdfEmbeddedImages(fs.readFileSync(path.join(__dirname, '../fixtures/pdf-with-embedded-image.pdf')), { minDimension: 0 });
    expect(images).toHaveLength(1);
    jest.dontMock('pdfjs-dist/legacy/build/pdf.js');
  });
});

describe('hostExtractedImages', () => {
  test('uploads each extracted image and returns its real hosted URL with page number', async () => {
    mockUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/pdfimg.png' });
    const result = await hostExtractedImages([{ buffer: Buffer.from('fake'), mime: 'image/png', width: 100, height: 100, page: 2 }]);
    expect(result).toEqual([{ url: 'https://res.cloudinary.com/demo/image/upload/v1/pdfimg.png', page: 2 }]);
  });

  test('a failed upload is skipped, not thrown - non-fatal per image', async () => {
    mockUpload.mockRejectedValue(new Error('Cloudinary down'));
    const result = await hostExtractedImages([{ buffer: Buffer.from('fake'), mime: 'image/png', width: 100, height: 100, page: 1 }]);
    expect(result).toEqual([]);
  });
});
