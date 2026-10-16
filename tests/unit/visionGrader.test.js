// services/visionGrader: drawing/photo grading tries Gemini, then Mistral, then Qwen.
const mockGenerateContent = jest.fn();
const mockGeminiModel = jest.fn(() => ({ generateContent: (...a) => mockGenerateContent(...a) }));
const mockQwen = jest.fn();
jest.mock('../../services/quizVision', () => ({
  geminiModel: (...a) => mockGeminiModel(...a),
  callQwenVisionRaw: (...a) => mockQwen(...a),
}));
const mockMistral = jest.fn();
jest.mock('../../services/worksheet/providers', () => ({ callMistralVision: (...a) => mockMistral(...a) }));

const { callVisionGrader } = require('../../services/visionGrader');

const STUDENT = `data:image/png;base64,${Buffer.from('student-drawing').toString('base64')}`;
const ENV = { ...process.env };

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'g';
  process.env.MISTRAL_API_KEY = 'm';
  process.env.HF_TOKEN = 'h';
  mockGeminiModel.mockClear();
  [mockGenerateContent, mockQwen, mockMistral].forEach((m) => m.mockReset());
  global.fetch = jest.fn();
});
afterAll(() => { process.env = ENV; });

test('Gemini grades the drawing with the prompt and every image, in order', async () => {
  global.fetch.mockResolvedValue({
    ok: true,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () => Buffer.from('worksheet-page'),
  });
  mockGenerateContent.mockResolvedValue({ response: { text: () => '{"score":80}' } });

  await expect(callVisionGrader('grade it', ['https://x/page1.jpg', STUDENT])).resolves.toBe('{"score":80}');

  expect(mockGeminiModel).toHaveBeenCalledWith(expect.objectContaining({ responseMimeType: 'application/json' }));
  const [parts] = mockGenerateContent.mock.calls[0];
  expect(parts[0]).toEqual({ text: 'grade it' });
  expect(parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('worksheet-page').toString('base64') });
  expect(parts[2].inlineData).toEqual({ mimeType: 'image/png', data: Buffer.from('student-drawing').toString('base64') });
  expect(mockMistral).not.toHaveBeenCalled();
});

test('a Gemini failure falls back to Mistral', async () => {
  mockGenerateContent.mockRejectedValue(new Error('429 quota'));
  mockMistral.mockResolvedValue('{"score":70}');

  await expect(callVisionGrader('p', [STUDENT])).resolves.toBe('{"score":70}');
  const [images, prompt] = mockMistral.mock.calls[0];
  expect(prompt).toBe('p');
  expect(images).toHaveLength(1);
  expect(images[0].mime).toBe('image/png');
  expect(mockQwen).not.toHaveBeenCalled();
});

test('Qwen is last and gets only the student image', async () => {
  global.fetch.mockResolvedValue({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('w') });
  mockGenerateContent.mockRejectedValue(new Error('503'));
  mockMistral.mockRejectedValue(new Error('timeout'));
  mockQwen.mockResolvedValue('{"score":60}');

  await expect(callVisionGrader('p', ['https://x/w.jpg', STUDENT])).resolves.toBe('{"score":60}');
  const [buffer, mime, prompt] = mockQwen.mock.calls[0];
  expect(buffer.toString()).toBe('student-drawing');
  expect(mime).toBe('image/png');
  expect(prompt).toBe('p');
});

test('every provider failing throws with each reason, so the caller can flag it for teacher review', async () => {
  mockGenerateContent.mockRejectedValue(new Error('g down'));
  mockMistral.mockRejectedValue(new Error('m down'));
  mockQwen.mockRejectedValue(new Error('q down'));

  await expect(callVisionGrader('p', [STUDENT])).rejects.toThrow('gemini: g down | mistral: m down | qwen: q down');
});

test('providers without a key are skipped', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  mockQwen.mockResolvedValue('{"score":50}');

  await expect(callVisionGrader('p', [STUDENT])).resolves.toBe('{"score":50}');
  expect(mockGenerateContent).not.toHaveBeenCalled();
  expect(mockMistral).not.toHaveBeenCalled();
});

test('no provider configured is an error, not a silent pass', async () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.HF_TOKEN;
  await expect(callVisionGrader('p', [STUDENT])).rejects.toThrow('no vision provider configured');
});

test('a worksheet page that cannot be fetched is dropped; the student image is still graded', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 404 });
  mockGenerateContent.mockResolvedValue({ response: { text: () => '{}' } });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  await callVisionGrader('p', ['https://x/gone.jpg', STUDENT]);
  const [parts] = mockGenerateContent.mock.calls[0];
  expect(parts).toHaveLength(2);
  expect(parts[1].inlineData.mimeType).toBe('image/png');
  warn.mockRestore();
});

test('a student image that cannot be fetched fails the grade', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 404 });
  await expect(callVisionGrader('p', ['https://x/student.jpg'])).rejects.toThrow('image fetch 404');
  expect(mockGenerateContent).not.toHaveBeenCalled();
});
