// B02 — Correct IB PYP worksheet classification for subject and curriculum.
// Ported from ai-mentor/server/tests/worksheet-curriculum-classification.test.js
// (2026-09-10, B02/B04 follow-up migration) - extractWorksheetContent() now
// lives here, the real live endpoint (useUploadWorksheet.ts calls
// ASSIGNMENTS_SERVER_URL for extract-questions-async).
//
// Fixtures are the REAL worksheets supplied for this defect - see
// tests/fixtures/:
//   b02-ib-pyp-worksheet.pdf         - real PYP2 HLE-13 Telugu worksheet,
//                                       explicitly prints "PYP: 2" and
//                                       "Subject Focus: Language Acquisition-Telugu"
//   b02-no-curriculum-worksheet.pdf  - real Learning A-Z reading passage,
//                                       prints "Grade 2" but NO curriculum
//                                       indicator anywhere - the "don't
//                                       guess" control case.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock-gemini-key';

const fs = require('fs');
const path = require('path');

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: jest.fn() })),
}));
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({})) }));

const { extractWorksheetContent } = require('../../routes/assignments');

function fixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name)).toString('base64');
}
function mockGroqJson(json) {
  mockGroqCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(json) } }] });
}

const IB_PYP_WORKSHEET = fixtureBase64('b02-ib-pyp-worksheet.pdf');
const NO_CURRICULUM_WORKSHEET = fixtureBase64('b02-no-curriculum-worksheet.pdf');

describe('B02 — worksheet curriculum classification (real endpoint: assignments-service)', () => {
  beforeEach(() => mockGroqCreate.mockReset());

  test('THE ORIGINAL REPORTED BUG: an IB PYP worksheet must not keep the teacher\'s CBSE default — curriculum must come from the worksheet itself', async () => {
    mockGroqJson({
      title: 'Ottu Padaalu', chapter: 'THLE-13', subject: 'Language Acquisition',
      language: 'Telugu', grade: 'PYP 2', curriculum: 'IB PYP',
      purpose: '', learningOutcomes: [], taskDescription: '', questions: [],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: IB_PYP_WORKSHEET, mime: 'application/pdf' }]);

    expect(result.curriculum).toBe('IB PYP');
  });

  test('a non-IB curriculum indicator normalizes correctly and is never IB PYP', async () => {
    mockGroqJson({
      title: 'Fractions Worksheet', chapter: 'Ch 5', subject: 'Mathematics',
      language: '', grade: 'Grade 5', curriculum: 'CBSE',
      purpose: '', learningOutcomes: [], taskDescription: '', questions: [],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: IB_PYP_WORKSHEET, mime: 'application/pdf' }]);

    expect(result.curriculum).not.toBe('IB PYP');
    expect(result.curriculum).toBe('NCERT');
  });

  test('no curriculum indicator on the page → must NOT guess (real fixture: a Learning A-Z reading passage)', async () => {
    mockGroqJson({
      title: 'The Force of Water', chapter: '', subject: 'Science',
      language: '', grade: 'Grade 2', curriculum: '',
      purpose: '', learningOutcomes: [], taskDescription: '', questions: [],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: NO_CURRICULUM_WORKSHEET, mime: 'application/pdf' }]);

    expect(result.curriculum).toBe('');
    expect(result.grade).toBe('Grade 2');
  });

  test('an implausible/hallucinated curriculum string is rejected rather than trusted', async () => {
    mockGroqJson({
      title: 'Worksheet', chapter: '', subject: 'Mathematics',
      language: '', grade: 'Grade 3', curriculum: 'this worksheet is definitely from some curriculum, possibly',
      purpose: '', learningOutcomes: [], taskDescription: '', questions: [],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: IB_PYP_WORKSHEET, mime: 'application/pdf' }]);

    expect(result.curriculum).toBe('');
  });

  test('REGRESSION: existing subject/grade/language extraction is unaffected by the curriculum fix', async () => {
    mockGroqJson({
      title: 'Ottu Padaalu', chapter: 'THLE-13', subject: 'Language Acquisition',
      language: 'Telugu', grade: 'PYP 2', curriculum: 'IB PYP',
      purpose: '', learningOutcomes: [], taskDescription: '', questions: [],
      wordBank: [], successCriteria: [], stamps: [], feedbackSection: '',
    });

    const result = await extractWorksheetContent([{ base64: IB_PYP_WORKSHEET, mime: 'application/pdf' }]);

    expect(result.subject).toBe('Language Acquisition');
    expect(result.language).toBe('Telugu');
    expect(result.grade).toBe('PYP 2');
  });
});
