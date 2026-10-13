// Worksheet document model (no AI): text layer + per-page OCR + pictures
// placed inline. 2026-10-13 manual test RCA — with no vision provider the old
// text path trusted the broken Telugu text layer, skipped OCR (≥300 chars),
// and never saw questions pasted as screenshots, so they were all lost.
// Real fixtures, real pdfjs/Chrome/Tesseract (bundled, offline language data).
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { buildDocumentModel } = require('../../services/worksheet/documentModel');

const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures', name));
const fakeHost = async imgs => imgs.map((img, i) => ({ url: `https://img.test/p${img.page}-${i + 1}.png` }));

describe('Telugu worksheet with questions pasted as screenshots', () => {
  let doc;
  beforeAll(async () => {
    doc = await buildDocumentModel({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf', hostImages: fakeHost });
  }, 180000);

  test('pages are read by Telugu OCR, not the broken text layer', () => {
    expect(doc.scripts).toContain('Telugu');
    expect(doc.diagnostics.ocrLangs).toEqual(['tel', 'eng']);
    expect(doc.diagnostics.pages.map(p => p.source)).toEqual(['ocr', 'ocr']);
    expect(doc.diagnostics.pages.every(p => p.ocrConfidence >= 70)).toBe(true);
  });

  test('questions that exist only inside screenshots are in the transcript', () => {
    expect(doc.text).toContain('పాము పుట్ట');          // (2) చెట్టు కింద పాము పుట్ట ఉంది
    expect(doc.text).toContain('రాణి సరస్సులో');        // comprehension question 2
    expect(doc.text).toContain('తాత పూలను');            // comprehension question 3
    expect(doc.text).toMatch(/ప్రశ్నలకు జవాబులు రాయండి/);
    expect(doc.text).not.toContain('సింబింధించిన');     // the text layer's broken shaping
  });

  test('screenshots of plain text are not pictures; the logo is dropped; the riddle picture is kept inline', () => {
    const decisions = doc.diagnostics.pages.flatMap(p => p.imageDecisions.map(d => d.kind));
    expect(decisions.filter(k => k === 'text').length).toBeGreaterThanOrEqual(3); // question screenshots
    expect(doc.diagnostics.pages[0].decorative).toBe(1);                         // school logo
    expect(doc.text).not.toMatch(/SHRI RAM/i);
    // The riddle + honeycomb is one screenshot: its text is read AND it stays a picture.
    expect(doc.text).toMatch(/ఆకాశాన అరవై గదులు/);
    expect(doc.pictures.some(p => p.page === 2)).toBe(true);
    expect(doc.text).toMatch(/--- Page 2 ---[\s\S]*\[IMAGE: url=https:\/\/img\.test\/p2-\d+\.png\]/);
  });

  test('page images are available for vision providers', () => {
    expect(doc.pageImages).toHaveLength(2);
    expect(doc.pageImages[0].buffer.slice(1, 4).toString()).toBe('PNG');
  });
});

describe('English maths worksheet (text layer + pictures)', () => {
  let doc;
  beforeAll(async () => {
    doc = await buildDocumentModel({ buffer: fixture('b05-area-perimeter-worksheet.pdf'), mime: 'application/pdf', hostImages: fakeHost });
  }, 180000);

  test('uses the PDF text layer and keeps every question', () => {
    expect(doc.diagnostics.pages[1].source).toBe('text-layer');
    expect(doc.text).toContain('Find the perimeter of the L shaped polygon');
    expect(doc.text).toContain('A square playground has sides that are 65 m long');
  });

  test('side-by-side diagrams stay on one row, and labels inside a picture are read', () => {
    expect(doc.text).toMatch(/\[IMAGE: url=[^\]]+\][^\n]*\|[^\n]*\[IMAGE: url=[^\]]+\]/);
    expect(doc.text).toMatch(/\[IMAGE: url=[^\]]+\] \(text in picture: [^)]*8m[^)]*\)/);
  });

  test('no logo text and no duplicated header lines', () => {
    expect(doc.text).not.toMatch(/SHRI RAM/i);
    expect(doc.text.match(/Name of Learner/g)).toHaveLength(1);
  });
});

describe('degrades instead of failing', () => {
  test('an unparseable PDF yields an empty model without launching Chrome', async () => {
    const doc = await buildDocumentModel({ buffer: Buffer.from('%PDF-fake'), mime: 'application/pdf' });
    expect(doc.text).toBe('');
    expect(doc.pageImages).toEqual([]);
  });

  test('OCR off: the text layer is still used', async () => {
    const doc = await buildDocumentModel({ buffer: fixture('b05-area-perimeter-worksheet.pdf'), mime: 'application/pdf', ocrEnabled: false });
    expect(doc.text).toContain('L shaped polygon');
    expect(doc.pageImages).toEqual([]);
  }, 60000);
});
