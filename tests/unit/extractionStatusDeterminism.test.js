// computeExtractionStatus / callGroqWithText normalization — added
// 2026-09-13 (Task 2: eliminate content-sparse nondeterminism).
//
// Root cause investigated live: the EXACT same real Telugu worksheet
// (b02-ib-pyp-worksheet.pdf), across repeated identical requests, produced
// THREE different structural outcomes:
//   A. a valid quiz with tasks: [] (title/purpose present, no tasks)
//   B. a valid quiz with 4 tasks, each with questions: [] (title-only tasks)
//   C. an outright job failure: Groq's json_object mode rejected the
//      underlying model's natural-language refusal with
//      "json_validate_failed" - a THROWN error, not a returned result
//
// All three represent the SAME underlying condition (not enough
// extractable source content to generate real questions), but only A and
// B were previously distinguishable from a genuine generation failure -
// C looked identical to a real bug from the job queue's perspective.
// LLM WORDING variability (whether it says "insufficient" one way or
// another) is acceptable; this test suite verifies the STRUCTURAL STATE
// is now always the same regardless of which of the three the underlying
// model happens to produce on a given run.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));

const { callGroqWithText, computeExtractionStatus } = require('../../services/quizVision');

beforeEach(() => mockGroqCreate.mockReset());

describe('callGroqWithText normalizes json_validate_failed to a clean result, not a throw', () => {
  test('a real-shaped json_validate_failed error (the exact live-observed variant C) is caught and normalized', async () => {
    const groqApiError = new Error('400 {"error":{"message":"Failed to generate JSON. Please adjust your prompt. See \'failed_generation\' for more details.","type":"invalid_request_error","code":"json_validate_failed","failed_generation":"I\'m sorry, but I can\'t create an accurate quiz JSON..."}}');
    mockGroqCreate.mockRejectedValue(groqApiError);

    const raw = await callGroqWithText('any prompt');
    const parsed = JSON.parse(raw);

    expect(parsed.tasks).toEqual([]);
    expect(parsed.extractionStatus).toBe('insufficient_source_content');
  });

  test('a genuinely different Groq error (not json_validate_failed) still throws - this normalization is narrowly scoped', async () => {
    mockGroqCreate.mockRejectedValue(new Error('500 Internal Server Error'));
    await expect(callGroqWithText('any prompt')).rejects.toThrow('500 Internal Server Error');
  });

  test('a normal successful call is unaffected - passthrough, no interference', async () => {
    mockGroqCreate.mockResolvedValue({ choices: [{ message: { content: '{"title":"Real Quiz","tasks":[{"title":"T1","questions":[{"q":1}]}]}' } }] });
    const raw = await callGroqWithText('any prompt');
    expect(JSON.parse(raw).title).toBe('Real Quiz');
  });
});

describe('computeExtractionStatus - unifies all three live-observed variants into ONE deterministic state', () => {
  test('variant A: valid quiz with zero tasks', () => {
    expect(computeExtractionStatus({ tasks: [] })).toBe('insufficient_source_content');
  });

  test('variant B: valid quiz with real task titles but zero questions in each', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [] },
      { title: 'Task 2', questions: [] },
      { title: 'Task 3', questions: [] },
      { title: 'Task 4', questions: [] },
    ] };
    expect(computeExtractionStatus(quiz)).toBe('insufficient_source_content');
  });

  test('variant C: already normalized by callGroqWithText (extractionStatus pre-set)', () => {
    expect(computeExtractionStatus({ tasks: [], extractionStatus: 'insufficient_source_content' })).toBe('insufficient_source_content');
  });

  test('a genuinely healthy result with real questions is "ok", not flagged', () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] }] };
    expect(computeExtractionStatus(quiz)).toBe('ok');
  });

  test('a task with alternate content (table/chart) instead of questions is still "ok" - not every task needs literal questions', () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [], table: { headers: ['a'], rows: [[{ text: '1' }]] } }] };
    expect(computeExtractionStatus(quiz)).toBe('ok');
  });

  test('a MIX of one real task and one empty task is still "ok" - partial content is not the same as insufficient content', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] },
      { title: 'Task 2', questions: [] },
    ] };
    expect(computeExtractionStatus(quiz)).toBe('ok');
  });
});
