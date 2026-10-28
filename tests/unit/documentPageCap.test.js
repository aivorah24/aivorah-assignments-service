// A 6-page worksheet OOM-killed Render's 512 MB instance (2026-10-28): every page was
// rendered at OCR resolution. The document model now reads DOCUMENT_MAX_PAGES (default 3).
const LAYOUT_6 = { numPages: 6, pages: [1, 2, 3].map(page => ({ page, width: 600, height: 800, lines: [{ text: 'Q', x: 0, y: 0, w: 10, h: 10 }], images: [] })) };

function load(envValue) {
  jest.resetModules();
  if (envValue === undefined) delete process.env.DOCUMENT_MAX_PAGES; else process.env.DOCUMENT_MAX_PAGES = envValue;
  const rasterize = { rasterizePdfPages: jest.fn(async () => []) };
  const layout = { readPdfLayout: jest.fn(async () => LAYOUT_6) };
  jest.doMock('../../services/worksheet/rasterize', () => rasterize);
  jest.doMock('../../services/worksheet/pdfLayout', () => layout);
  jest.doMock('../../services/supabase', () => ({ from: jest.fn() }));
  return { ...require('../../services/worksheet/documentModel'), rasterize, layout };
}

afterAll(() => { delete process.env.DOCUMENT_MAX_PAGES; });

test('by default only the first 3 pages are laid out and rendered, with a warning', async () => {
  const { buildDocumentModel, DOCUMENT_MAX_PAGES, rasterize, layout } = load(undefined);
  expect(DOCUMENT_MAX_PAGES).toBe(3);
  const doc = await buildDocumentModel({ buffer: Buffer.from('%PDF-1.4'), mime: 'application/pdf', ocrEnabled: true });
  expect(layout.readPdfLayout).toHaveBeenCalledWith(expect.anything(), { maxPages: 3 });
  expect(rasterize.rasterizePdfPages).toHaveBeenCalledWith(expect.anything(), { maxPages: 3 });
  expect(doc.diagnostics.warnings).toContain('Only the first 3 of 6 pages were read.');
});

test('DOCUMENT_MAX_PAGES overrides the cap; bad values fall back to 3', async () => {
  expect(load('5').DOCUMENT_MAX_PAGES).toBe(5);
  expect(load('abc').DOCUMENT_MAX_PAGES).toBe(3);
  expect(load('0').DOCUMENT_MAX_PAGES).toBe(3);
});
