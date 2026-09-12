// POST /assignments/docx-to-pdf — ported from the monolith (2026-09-11, B05).
// Uses real .docx fixtures (borrowed from mammoth's own test suite) through
// the REAL mammoth + puppeteer conversion — no mocking of the conversion
// itself, since the whole point of this route is that the conversion
// actually works. Puppeteer launches a real headless Chromium; this test
// is slower than the others in this suite as a result.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../index');

function fixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name)).toString('base64');
}

// PDF parsing to confirm the real text made it through — pdf-parse is
// already a dependency here (used by /assignments/pdf-to-quiz).
const pdfParse = require('pdf-parse');

describe('POST /assignments/docx-to-pdf — validation', () => {
  test('requires fileBase64', async () => {
    const res = await request(app).post('/assignments/docx-to-pdf').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fileBase64 required/);
  });
});

describe('POST /assignments/docx-to-pdf — real conversion', () => {
  test('a real single-paragraph docx converts to a real, readable PDF', async () => {
    const res = await request(app).post('/assignments/docx-to-pdf').send({
      fileBase64: fixtureBase64('single-paragraph.docx'),
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.pdfBase64).toBe('string');
    expect(res.body.pdfBase64.length).toBeGreaterThan(1000);

    const pdfBuffer = Buffer.from(res.body.pdfBase64, 'base64');
    expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF'); // real PDF file header

    const parsed = await pdfParse(pdfBuffer);
    expect(parsed.text).toContain('Walking on imported air');
  }, 30000);

  test('a real docx containing a table converts to a PDF preserving the table text', async () => {
    const res = await request(app).post('/assignments/docx-to-pdf').send({
      fileBase64: fixtureBase64('tables.docx'),
    });

    expect(res.status).toBe(200);
    const pdfBuffer = Buffer.from(res.body.pdfBase64, 'base64');
    const parsed = await pdfParse(pdfBuffer);
    // tables.docx (mammoth's fixture) is a 2x2 grid with these real cell values
    expect(parsed.text).toMatch(/Top left/);
    expect(parsed.text).toMatch(/Bottom right/);
  }, 30000);

  // Root cause found via a real teacher's worksheet (2026-09-12, see
  // QUIZ_PIPELINE_MIGRATION.md): quiz generation was re-deriving table
  // numbers from a flattened PDF render via vision/OCR, and fabricated
  // completely different fraction values than the source table actually
  // had. structuredText recovers mammoth's exact table-cell text so the
  // generation step never has to re-guess a number it already has an
  // exact source for.
  test('also returns structuredText with the table cells preserved exactly, marked as a table block', async () => {
    const res = await request(app).post('/assignments/docx-to-pdf').send({
      fileBase64: fixtureBase64('tables.docx'),
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.structuredText).toBe('string');
    expect(res.body.structuredText).toMatch(/\[TABLE/);
    expect(res.body.structuredText).toMatch(/Top left \| Top right/);
    expect(res.body.structuredText).toMatch(/Bottom left \| Bottom right/);
  }, 30000);
});

describe('POST /assignments/docx-to-pdf — real failure handling', () => {
  test('a corrupt/non-docx payload surfaces as a 500, not a hang', async () => {
    const res = await request(app).post('/assignments/docx-to-pdf').send({
      fileBase64: Buffer.from('not a real docx file').toString('base64'),
    });
    expect(res.status).toBe(500);
  }, 30000);
});
