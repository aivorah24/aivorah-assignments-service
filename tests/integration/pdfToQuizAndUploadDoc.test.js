// POST /assignments/pdf-to-quiz and POST /assignments/upload-doc — ported
// from the monolith (2026-09-11, B05). Neither needs Puppeteer (unlike
// docx-to-pdf, which stays on the monolith for now): pdf-to-quiz only needs
// pdf-parse (text PDFs) or Groq vision (images) + Groq for question
// generation; upload-doc only needs Cloudinary, already configured here for
// the evidence-upload path (see b04-drawing-evidence.test.js).
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload: (...args) => mockCloudinaryUpload(...args) } },
}));

const mockPdfParse = jest.fn();
jest.mock('pdf-parse', () => (...args) => mockPdfParse(...args));

const request = require('supertest');
const app = require('../../index');

function groqJson(obj) {
  return Promise.resolve({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}
function groqText(text) {
  return Promise.resolve({ choices: [{ message: { content: text } }] });
}

beforeEach(() => {
  mockGroqCreate.mockReset();
  mockCloudinaryUpload.mockReset();
  mockPdfParse.mockReset();
});

describe('POST /assignments/pdf-to-quiz — validation', () => {
  test('requires fileBase64', async () => {
    const res = await request(app).post('/assignments/pdf-to-quiz').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fileBase64 required/);
  });
});

describe('POST /assignments/pdf-to-quiz — text PDF path (pdf-parse)', () => {
  test('extracts text via pdf-parse and generates MCQ questions from it', async () => {
    mockPdfParse.mockResolvedValue({ text: 'The water cycle has three stages: evaporation, condensation, precipitation.' });
    mockGroqCreate.mockResolvedValue(groqJson({
      questions: [{ id: 'q1', question: 'What is the first stage?', type: 'mcq', options: ['A. Evaporation', 'B. Condensation', 'C. Precipitation', 'D. Collection'], correct: 'A' }],
    }));

    const res = await request(app).post('/assignments/pdf-to-quiz').send({
      fileBase64: 'ZmFrZS1wZGY=', mimeType: 'application/pdf', subject: 'Science', grade: 'Grade 4', count: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    expect(res.body.extractedText).toMatch(/water cycle/);
    expect(mockPdfParse).toHaveBeenCalled();
  });

  test('an empty PDF (no extractable text) returns an empty question set, not an error', async () => {
    mockPdfParse.mockResolvedValue({ text: '   ' });
    const res = await request(app).post('/assignments/pdf-to-quiz').send({ fileBase64: 'ZmFrZQ==', mimeType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
  });
});

describe('POST /assignments/pdf-to-quiz — image path (Qwen vision text extraction)', () => {
  // Groq no longer offers a vision-capable model on this account
  // (llama-4-scout 404s model_not_found) - the image path now extracts text
  // via Qwen (HF router) instead; MCQ generation from that text still uses
  // Groq's text model, unaffected.
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('extracts text via Qwen vision, then generates MCQ questions from it', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Photosynthesis converts sunlight into energy.' } }] }),
    });
    mockGroqCreate.mockResolvedValue(groqJson({ questions: [{ id: 'q1', question: 'What does photosynthesis convert?', type: 'mcq', options: ['A. Sunlight', 'B. Water', 'C. Soil', 'D. Air'], correct: 'A' }] }));

    const res = await request(app).post('/assignments/pdf-to-quiz').send({
      fileBase64: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/jpeg', subject: 'Science', count: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    expect(mockPdfParse).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith('https://router.huggingface.co/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
  });
});

describe('POST /assignments/pdf-to-quiz — real failure handling', () => {
  test('a pdf-parse exception surfaces as a 500, not a hang', async () => {
    mockPdfParse.mockRejectedValue(new Error('corrupt PDF'));
    const res = await request(app).post('/assignments/pdf-to-quiz').send({ fileBase64: 'ZmFrZQ==', mimeType: 'application/pdf' });
    expect(res.status).toBe(500);
  });
});

describe('POST /assignments/upload-doc — validation', () => {
  test('requires fileBase64', async () => {
    const res = await request(app).post('/assignments/upload-doc').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fileBase64 required/);
  });
});

describe('POST /assignments/upload-doc — success', () => {
  test('uploads to Cloudinary and returns the secure URL + public ID', async () => {
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/ai_mentor/doc_123.pdf', public_id: 'ai_mentor/assignments/doc_123' });

    const res = await request(app).post('/assignments/upload-doc').send({
      fileBase64: 'ZmFrZS1wZGY=', fileName: 'worksheet.pdf', mimeType: 'application/pdf',
    });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://res.cloudinary.com/ai_mentor/doc_123.pdf');
    expect(res.body.publicId).toBe('ai_mentor/assignments/doc_123');
    expect(mockCloudinaryUpload).toHaveBeenCalledWith(
      expect.stringContaining('data:application/pdf;base64,'),
      expect.objectContaining({ folder: 'ai_mentor/assignments', resource_type: 'auto' })
    );
  });
});

describe('POST /assignments/upload-doc — real failure handling', () => {
  test('a Cloudinary exception surfaces as a 500 with its real message', async () => {
    mockCloudinaryUpload.mockRejectedValue(new Error('Cloudinary quota exceeded'));
    const res = await request(app).post('/assignments/upload-doc').send({ fileBase64: 'ZmFrZQ==' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cloudinary quota exceeded');
  });
});
