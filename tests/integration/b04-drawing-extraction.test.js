// B04 Phase 2 — extractWorksheetContent() must identify when a worksheet
// task requires a drawing/photo response, not a text answer. Ported from
// ai-mentor/server/tests/b04-drawing-extraction.test.js (2026-09-10) - see
// b02-curriculum-classification.test.js's header for why this function
// lives here now, not just the monolith.
//
// Fixture: the REAL "Draw your farm" worksheet page you supplied for B04
// (tests/fixtures/b04-draw-your-farm-worksheet.jpeg) - a real photo, so it
// goes through the Gemini vision extraction branch, not pdf-parse.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock-gemini-key';

const fs = require('fs');
const path = require('path');

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({ generateContent: (...args) => mockGenerateContent(...args) })),
  })),
}));
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({})) }));

const { extractWorksheetContent } = require('../../routes/assignments');

const FARM_WORKSHEET_BASE64 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'b04-draw-your-farm-worksheet.jpeg')).toString('base64');

function mockGeminiResponse(json) {
  mockGenerateContent.mockResolvedValueOnce({ response: { text: () => JSON.stringify(json) } });
}

describe('B04 — extraction identifies drawing-response questions (real endpoint: assignments-service)', () => {
  beforeEach(() => mockGenerateContent.mockReset());

  test('THE ORIGINAL GAP: a drawing task extracted without responseType defaults to "text"', async () => {
    mockGeminiResponse({
      title: 'Draw Your Farm', chapter: '', subject: 'Visual Arts', language: '', grade: 'PYP 2', curriculum: 'IB PYP',
      purpose: '', learningOutcomes: [], taskDescription: '',
      questions: [{ text: 'Draw your farm in the space provided below.', needsImage: false, imageYStart: 0, imageYEnd: 0 }],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: FARM_WORKSHEET_BASE64, mime: 'image/jpeg' }]);

    expect(result.questions[0].responseType).toBe('text');
  });

  test('a real drawing task is extracted with responseType: "drawing"', async () => {
    mockGeminiResponse({
      title: 'Draw Your Farm', chapter: '', subject: 'Visual Arts', language: '', grade: 'PYP 2', curriculum: 'IB PYP',
      purpose: '', learningOutcomes: [], taskDescription: '',
      questions: [
        { text: 'Draw your farm in the space provided below.', needsImage: false, imageYStart: 0, imageYEnd: 0, responseType: 'drawing' },
        { text: 'Write your paragraph in the space provided below, using the Word Bank.', needsImage: false, imageYStart: 0, imageYEnd: 0, responseType: 'text' },
      ],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: FARM_WORKSHEET_BASE64, mime: 'image/jpeg' }]);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].responseType).toBe('drawing');
    expect(result.questions[1].responseType).toBe('text');
  });

  test('an unrecognized/hallucinated responseType value is rejected, not trusted', async () => {
    mockGeminiResponse({
      title: 'Draw Your Farm', chapter: '', subject: 'Visual Arts', language: '', grade: 'PYP 2', curriculum: 'IB PYP',
      purpose: '', learningOutcomes: [], taskDescription: '',
      questions: [{ text: 'Draw your farm.', needsImage: false, imageYStart: 0, imageYEnd: 0, responseType: 'a picture maybe, possibly a sketch' }],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: FARM_WORKSHEET_BASE64, mime: 'image/jpeg' }]);

    expect(result.questions[0].responseType).toBe('text');
  });

  test('REGRESSION: needsImage (a separate, pre-existing concept) is unaffected by responseType', async () => {
    mockGeminiResponse({
      title: 'Draw Your Farm', chapter: '', subject: 'Mathematics', language: '', grade: 'Grade 4', curriculum: '',
      purpose: '', learningOutcomes: [], taskDescription: '',
      questions: [{ text: 'Find the area of the irregular shape.', needsImage: true, imageYStart: 20, imageYEnd: 60, responseType: 'text' }],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: FARM_WORKSHEET_BASE64, mime: 'image/jpeg' }]);

    expect(result.questions[0]).toMatchObject({ needsImage: true, imageYStart: 20, imageYEnd: 60, responseType: 'text' });
  });
});
