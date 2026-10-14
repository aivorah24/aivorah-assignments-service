// Provider-agnostic worksheet → quiz (generateQuizFromDocument): every
// provider gets the document-model transcript; Gemini → Mistral vision →
// Groq text. AI calls are mocked; the document model (pdfjs/Chrome/OCR) is real.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGemini = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: (...a) => mockGemini(...a) }),
  })),
}));
const mockGroq = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...a) => mockGroq(...a) } },
})));
const mockUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: () => ({ cloud_name: 'test' }), uploader: { upload: (...a) => mockUpload(...a) } },
}));

process.env.GEMINI_API_KEY = 'test';
const fs = require('fs');
const path = require('path');
const { generateQuizFromDocument } = require('../../services/quizVision');
const documentModel = require('../../services/worksheet/documentModel');

// The real document model, built once per fixture (it's slow under jest);
// picture URLs are re-hosted per call so each test sees its own uploads.
const realBuild = documentModel.buildDocumentModel;
const built = new Map();
jest.spyOn(documentModel, 'buildDocumentModel').mockImplementation(async (input) => {
  const key = input.buffer.length;
  if (!built.has(key)) built.set(key, realBuild({ ...input, hostImages: async imgs => imgs.map((img, i) => ({ url: `https://img.test/${i + 1}.png` })) }));
  return built.get(key);
});

const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures', name));
const groqReply = obj => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) } }] });
const realFetch = global.fetch;
let uploads = 0;

beforeEach(() => {
  // A permanent (per-day) quota error fails fast — no retry backoff.
  mockGemini.mockReset().mockRejectedValue(new Error('429 Too Many Requests: GenerateRequestsPerDay quota exceeded'));
  mockGroq.mockReset();
  uploads = 0;
  mockUpload.mockReset().mockImplementation(async () => ({ secure_url: `https://img.test/${++uploads}.png` }));
  delete process.env.MISTRAL_API_KEY;
});
afterEach(() => { global.fetch = realFetch; });

const TELUGU_QUIZ = {
  title: 'THLE-13', language: 'Telugu',
  tasks: [{ title: 'ఈ) కింది పేరా చదవండి. ప్రశ్నలకు జవాబులు రాయండి.', questions: [
    { id: 'a', type: 'text', question: 'రాణి సరస్సులో ఏమి చూసింది?', answer: 'తామర పూలు', hint: 'పేరా చూడండి', solution: 'తామర పూలు' },
  ] }],
};

test('Gemini down → Mistral reads the page images with the transcript; vision counts as available', async () => {
  process.env.MISTRAL_API_KEY = 'test';
  const bodies = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).includes('api.mistral.ai')) {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(TELUGU_QUIZ) } }] }) };
    }
    return realFetch(url, opts);
  });
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf', subject: 'Language' });

  expect(quiz.provider).toBe('mistral');
  expect(quiz.visualUnderstandingAvailable).toBe(true);
  expect(quiz.tasks[0].questions[0].answer).toBe('తామర పూలు');
  const content = bodies[0].messages[0].content;
  const images = content.filter(c => c.type === 'image_url');
  expect(images).toHaveLength(2); // one per page
  expect(images[0].image_url).toMatch(/^data:image\/jpeg;base64,/);
  const prompt = content.find(c => c.type === 'text').text;
  expect(prompt).toContain('WORKSHEET TRANSCRIPT');
  expect(prompt).toContain('పాము పుట్ట');              // a question only present inside a screenshot
  expect(prompt).toContain('LANGUAGE (CRITICAL');
  expect(mockGroq).not.toHaveBeenCalled();
}, 180000);

test('no vision provider → Groq structures the OCR transcript (the questions are no longer lost)', async () => {
  mockGroq.mockResolvedValue(groqReply(TELUGU_QUIZ));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b02-ib-pyp-worksheet.pdf'), mime: 'application/pdf' });

  expect(quiz.provider).toBe('groq-text');
  expect(quiz.visualUnderstandingAvailable).toBe(false);
  expect(quiz.language).toBe('Telugu');
  const prompt = mockGroq.mock.calls[0][0].messages[0].content;
  expect(prompt).toContain('రాణి సరస్సులో');
  expect(prompt).toContain('తాత పూలను');
  expect(prompt).toMatch(/\[IMAGE: url=img:\/\/p\d+-\d+\]/);
  expect(quiz.documentDiagnostics.pages.map(p => p.source)).toEqual(['ocr', 'ocr']);
}, 180000);

test('pictures reach their tasks: model ids resolved, region pictures attached, else a page crop', async () => {
  mockGroq.mockResolvedValue(groqReply({
    title: 'MHLE 32', tasks: [
      { title: 'Task 1: Answer the following.', questions: [
        { id: 'a', type: 'numeric', question: 'Find the side of this regular polygon if its perimeter is 40 cm.', answer: 5, imageUrl: 'img://p1-2' },
        { id: 'b', type: 'text', question: 'Ghost picture', answer: 'x', imageUrl: 'img://p9-99' },
      ] },
      { title: 'Task 2: Find the perimeter of the L shaped polygon.', questions: [
        { id: 'a', type: 'numeric', question: 'Find the perimeter of the L shaped polygon.', answer: 28, solution: '5+6+8+3+...', hasImage: true },
      ] },
      { title: 'Task 3: Application of area and perimeter in real situations.', questions: [
        { id: 'a', type: 'numeric', question: 'A square playground has sides that are 65 m long. What is the area?', answer: 4225, solution: '65 × 65', hasImage: true },
      ] },
      { title: 'Enrichment Task:', questions: [
        { id: 'a', type: 'numeric', question: 'A rectangular room has a length of 120 m and a breadth of 80 m. How many 40 cm tiles cover it?', answer: 60000 },
      ] },
    ],
  }));
  const quiz = await generateQuizFromDocument({ buffer: fixture('b05-area-perimeter-worksheet.pdf'), mime: 'application/pdf' });
  const [t1, t2, t3] = quiz.tasks;

  expect(t1.questions[0].imageUrl).toBe('https://img.test/2.png');      // id from the model → hosted url
  expect(t1.questions[1].imageUrl).toBeUndefined();                      // invented id dropped
  expect(t2.questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//); // L-shape picture found in its region
  expect(t2.regionCrop).toBeUndefined();
  expect(t3.regionCrop).toBe(true);                                       // no picture in its region → page crop
  expect(t3.questions[0].imageUrl).toMatch(/^https:\/\/img\.test\//);
}, 180000);
