// Upload form auto-fill (2026-10-13 manual test: grade stayed at the
// teacher's Grade 6, curriculum at CBSE, chapter kept "loading"): the only
// source was the AI extraction job, and with Gemini and Qwen down it came
// back empty. Grade / curriculum / chapter code are now read from the printed
// header and the file name, and the extraction falls back to OCR + text model.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock-gemini-key';
delete process.env.MISTRAL_API_KEY;

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(() => ({})), uploader: { upload: jest.fn() } } }));
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({ generateContent: () => Promise.reject(new Error('403 API key not valid')) })),
  })),
}));
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({})) }));

const { detectWorksheetMeta } = require('../../utils/worksheetMeta');

const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

describe('detectWorksheetMeta', () => {
  test.each([
    [{ fileName: 'Revised_PYP4_-MHLE-29.pdf' }, { grade: 'Grade 4', curriculum: 'IB PYP', chapter: 'MHLE-29' }],
    [{ text: 'Name of Learner: PYP: 2  THLE 13' }, { grade: 'Grade 2', curriculum: 'IB PYP', chapter: 'THLE-13' }],
    [{ text: 'CBSE Class VI Mathematics' }, { grade: 'Grade 6', curriculum: 'CBSE', chapter: '' }],
    [{ text: 'NCERT Grade 7' }, { grade: 'Grade 7', curriculum: 'CBSE', chapter: '' }],
    [{ fileName: 'IMG_2034.jpg' }, { grade: '', curriculum: '', chapter: '' }],
  ])('%j', (input, expected) => {
    expect(detectWorksheetMeta(input)).toEqual(expected);
  });

  test('printed text wins over the file name', () => {
    expect(detectWorksheetMeta({ text: 'PYP 3  MHLE-22', fileName: 'PYP4_MHLE-29.pdf' }))
      .toEqual({ grade: 'Grade 3', curriculum: 'IB PYP', chapter: 'MHLE-22' });
  });

  test('prose is not a grade or a code', () => {
    expect(detectWorksheetMeta({ text: 'In class I learned 3 new words. READ 2 pages.' })).toEqual({ grade: '', curriculum: '', chapter: '' });
  });
});

describe('POST /assignments/detect-meta', () => {
  let app;
  beforeAll(() => { app = require('../../index'); });

  test('a real PDF: read from its printed header in well under a second', async () => {
    const started = Date.now();
    const res = await request(app).post('/assignments/detect-meta').send({
      fileBase64: fixture('b06-fractions-measurement-worksheet.pdf').toString('base64'), mimeType: 'application/pdf', fileName: 'worksheet.pdf',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ grade: 'Grade 4', curriculum: 'IB PYP', chapter: 'MHLE-29' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a photo: the file name is used', async () => {
    const res = await request(app).post('/assignments/detect-meta').send({ fileBase64: 'AAAA', mimeType: 'image/jpeg', fileName: 'PYP_3_LHLE_19.jpg' });
    expect(res.body).toEqual({ grade: 'Grade 3', curriculum: 'IB PYP', chapter: 'LHLE-19' });
  });

  test('nothing to read is a 400', async () => {
    const res = await request(app).post('/assignments/detect-meta').send({});
    expect(res.status).toBe(400);
  });
});

describe('extraction with every vision provider down', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    mockGroqCreate.mockReset();
    global.fetch = jest.fn(() => Promise.reject(new Error('HF router down')));
  });
  afterAll(async () => {
    global.fetch = realFetch;
    await require('../../services/worksheet/ocrEngine').terminateWorkers();
  });

  test('an image page is read with OCR and extracted by the text model', async () => {
    mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
      title: 'Draw your farm', chapter: '', subject: 'English', grade: '', curriculum: '', questions: [{ text: 'Draw your farm' }],
    }) } }] });
    const { extractWorksheetContent } = require('../../routes/assignments');
    const result = await extractWorksheetContent(
      [{ base64: fixture('b04-draw-your-farm-worksheet.jpeg').toString('base64'), mime: 'image/jpeg' }],
      { fileName: 'PYP3_LHLE-19.jpeg' },
    );
    const prompt = mockGroqCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/OCR of the page image/);
    expect(prompt).toMatch(/farm/i);
    expect(result.title).toBe('Draw your farm');
    // AI left them blank → filled from the file name.
    expect(result.grade).toBe('Grade 3');
    expect(result.curriculum).toBe('IB PYP');
    expect(result.chapter).toBe('LHLE-19');
  }, 120000);
});
