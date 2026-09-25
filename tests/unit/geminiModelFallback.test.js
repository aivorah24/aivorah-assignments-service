process.env.GEMINI_API_KEY = 'mock-gemini-key';
process.env.GEMINI_MODEL = 'model-a, model-b,model-c';

const mockGetGenerativeModel = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: (...a) => mockGetGenerativeModel(...a) })),
}));
jest.mock('groq-sdk', () => jest.fn());
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => ({})) }));

const { geminiModel } = require('../../services/quizVision');

function modelsBehaving(behaviour) {
  mockGetGenerativeModel.mockImplementation(({ model }) => ({
    generateContent: async () => {
      const b = behaviour[model];
      if (b instanceof Error) throw b;
      return b;
    },
  }));
}

beforeEach(() => mockGetGenerativeModel.mockReset());

test('an overloaded model moves straight on to the next configured model', async () => {
  modelsBehaving({ 'model-a': new Error('[503 Service Unavailable] This model is currently experiencing high demand'), 'model-b': 'B', 'model-c': 'C' });
  await expect(geminiModel({}).generateContent(['x'])).resolves.toBe('B');
  expect(mockGetGenerativeModel.mock.calls.map(([o]) => o.model)).toEqual(['model-a', 'model-b']);
});

test('a model retired for new users is skipped', async () => {
  modelsBehaving({ 'model-a': new Error('[404 Not Found] This model is no longer available to new users'), 'model-b': new Error('503 overloaded'), 'model-c': 'C' });
  await expect(geminiModel({}).generateContent(['x'])).resolves.toBe('C');
});

test('a per-model free-tier quota (429) moves on to the next model', async () => {
  modelsBehaving({ 'model-a': new Error('[429 Too Many Requests] You exceeded your current quota'), 'model-b': 'B' });
  await expect(geminiModel({}).generateContent(['x'])).resolves.toBe('B');
});

test('a billing/auth error is not hidden by trying other models', async () => {
  modelsBehaving({ 'model-a': new Error('[402 Payment Required] Your prepayment credits are depleted'), 'model-b': 'B' });
  await expect(geminiModel({}).generateContent(['x'])).rejects.toThrow(/credits are depleted/);
  expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
});

test('when every model is overloaded the last error is surfaced for the outer retry', async () => {
  modelsBehaving({ 'model-a': new Error('503 a'), 'model-b': new Error('503 b'), 'model-c': new Error('503 c') });
  await expect(geminiModel({}).generateContent(['x'])).rejects.toThrow('503 c');
});

test('the generation config is passed to every model tried', async () => {
  modelsBehaving({ 'model-a': new Error('503'), 'model-b': 'B' });
  await geminiModel({ temperature: 0 }).generateContent(['x']);
  mockGetGenerativeModel.mock.calls.forEach(([o]) => expect(o.generationConfig).toEqual({ temperature: 0 }));
});
