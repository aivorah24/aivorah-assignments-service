// validateQuestionInteraction / estimateSourceSectionCount — added
// 2026-09-14. Interaction-shape validation is read directly from
// quizHtmlRenderer.js's own actual rendering logic (autoDetectMCQ, the
// mcq/matching branches), not assumed - a question can look "present"
// (real question text, not caught by any other validator) while still
// being unrenderable: an mcq with no options, a numeric question with no
// answer and no visual excuse, an image-flagged question with no image
// reference at all. Generic per question TYPE, applies identically
// regardless of subject/worksheet.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { validateQuestionInteraction, estimateSourceSectionCount, buildConversionReport } = require('../../services/quizVision');

describe('validateQuestionInteraction', () => {
  test('a valid mcq (options + answer) passes', () => {
    expect(validateQuestionInteraction({ type: 'mcq', options: ['A', 'B'], answer: 'A' })).toBeNull();
  });
  test('an mcq with fewer than 2 options is invalid', () => {
    expect(validateQuestionInteraction({ type: 'mcq', options: ['A'], answer: 'A' })).toMatch(/fewer than 2 options/);
  });
  test('an mcq with no options array at all is invalid', () => {
    expect(validateQuestionInteraction({ type: 'mcq', answer: 'A' })).toMatch(/fewer than 2 options/);
  });
  test('an mcq with options but no answer and no correct-flag is invalid', () => {
    expect(validateQuestionInteraction({ type: 'mcq', options: ['A', 'B'] })).toMatch(/no correct answer/);
  });
  test('an mcq using the {label,correct} object shape (post-normalization) is valid without a top-level answer', () => {
    expect(validateQuestionInteraction({ type: 'mcq', options: [{ label: 'A', correct: true }, { label: 'B', correct: false }] })).toBeNull();
  });
  test('a valid numeric question passes', () => {
    expect(validateQuestionInteraction({ type: 'numeric', answer: 42 })).toBeNull();
  });
  test('a numeric question with no answer is invalid, UNLESS visually excused', () => {
    expect(validateQuestionInteraction({ type: 'numeric', answer: null })).toMatch(/no answer/);
    expect(validateQuestionInteraction({ type: 'numeric', answer: null, visualUnderstandingRequired: true })).toBeNull();
  });
  test('a question flagged hasImage with a real imageUrl is valid', () => {
    expect(validateQuestionInteraction({ type: 'text', hasImage: true, imageUrl: 'https://x/img.png' })).toBeNull();
  });
  test('a question flagged hasImage with NEITHER an imageUrl NOR a visual excuse is invalid', () => {
    expect(validateQuestionInteraction({ type: 'text', hasImage: true })).toMatch(/neither a real imageUrl/);
  });
  test('a plain open-ended text question with no special flags always passes', () => {
    expect(validateQuestionInteraction({ type: 'text', answer: 'anything, or even empty' })).toBeNull();
    expect(validateQuestionInteraction({ type: 'text' })).toBeNull();
  });
});

describe('estimateSourceSectionCount - deterministic, non-LLM, language-agnostic', () => {
  test('counts blank-line-separated, heading-shaped blocks', () => {
    const text = 'Task 1: Addition\na) 2+2\n\nTask 2: Subtraction\na) 5-3\n\nTask 3: Multiplication\na) 3x3';
    expect(estimateSourceSectionCount(text)).toBe(3);
  });
  test('empty source text returns 0, not an error', () => {
    expect(estimateSourceSectionCount('')).toBe(0);
    expect(estimateSourceSectionCount(null)).toBe(0);
  });
  test('a single block with no blank-line separation still returns at least 1', () => {
    expect(estimateSourceSectionCount('Just one continuous paragraph with no breaks at all.')).toBeGreaterThanOrEqual(1);
  });
});

describe('buildConversionReport - interaction validation integrated', () => {
  test('a task whose only question is an invalid mcq (no options) is flagged REQUIRES_REVIEW, not silently PRESERVED', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [{ question: 'Pick one', type: 'mcq', answer: 'A' }] }] };
    const report = buildConversionReport(quiz);
    expect(report.items[0].status).toBe('REQUIRES_REVIEW');
    expect(report.items[0].reason).toMatch(/options/);
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
  });

  test('a genuinely valid mcq task is still reported PRESERVED (no false positives)', () => {
    const quiz = { tasks: [{ title: 'Task', questions: [{ question: 'Pick one', type: 'mcq', options: ['A', 'B'], answer: 'A' }] }] };
    const report = buildConversionReport(quiz);
    expect(report.items[0].status).toBe('PRESERVED');
    expect(report.overallStatus).toBe('COMPLETE');
  });
});

describe('buildConversionReport - sourceSectionEstimate safety net (whole-task loss, not just thin content)', () => {
  // Live bug, 2026-09-14: a real 5-task worksheet came back with only 2 task
  // OBJECTS - not 2 good + 3 FAILED, just 2 total. Every per-task check
  // passed (nothing wrong with either task that existed), so overallStatus
  // was wrongly COMPLETE. Root cause was a Groq output-token truncation
  // (see callGroqWithText), fixed separately - this check is the
  // independent safety net for any OTHER cause of the same symptom.
  test('few tasks vs a much larger structural estimate flips overallStatus to REVIEW_REQUIRED with a warning', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] },
      { title: 'Task 2', questions: [{ question: 'x', answer: 'y' }] },
    ] };
    const report = buildConversionReport(quiz, { sourceSectionEstimate: 5 });
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
    expect(report.taskCountWarning).toMatch(/2 task.*5 sections/);
  });

  test('task count roughly matching the estimate is NOT flagged (no false alarm)', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] },
      { title: 'Task 2', questions: [{ question: 'x', answer: 'y' }] },
    ] };
    const report = buildConversionReport(quiz, { sourceSectionEstimate: 2 });
    expect(report.overallStatus).toBe('COMPLETE');
    expect(report.taskCountWarning).toBeUndefined();
  });

  test('a small estimate (<3) never triggers the warning, even with 1 task - avoids noise on short worksheets', () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] }] };
    const report = buildConversionReport(quiz, { sourceSectionEstimate: 2 });
    expect(report.taskCountWarning).toBeUndefined();
  });

  test('omitting sourceSectionEstimate entirely never triggers the warning (backward compatible)', () => {
    const quiz = { tasks: [{ title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] }] };
    const report = buildConversionReport(quiz);
    expect(report.taskCountWarning).toBeUndefined();
    expect(report.overallStatus).toBe('COMPLETE');
  });
});
