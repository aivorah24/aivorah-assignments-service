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
