jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const router = require('../../routes/assignments');
const {
  normalise, isPastDue, normalizeText, isGibberishAnswer, gibberishDescribed,
  stripOptionPrefix, normaliseAnswerToOptionText, mcqToFillBlank,
  normalizeQuizQuestion, normalizeQuizQuestions, normalizeQuizCount, buildFallbackQuiz,
} = router._internal;

describe('isPastDue', () => {
  test('a null due date is never past due', () => {
    expect(isPastDue(null)).toBe(false);
  });

  test('a due date far in the past is past due', () => {
    expect(isPastDue('2020-01-01')).toBe(true);
  });

  test('a due date far in the future is not past due', () => {
    expect(isPastDue('2099-01-01')).toBe(false);
  });

  test('closes at the end of the due day (23:59:59), not the start', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-19T10:00:00Z'));
    expect(isPastDue('2026-08-19')).toBe(false);
    jest.setSystemTime(new Date('2026-08-20T00:00:01Z'));
    expect(isPastDue('2026-08-19')).toBe(true);
    jest.useRealTimers();
  });
});

describe('normalise', () => {
  test('hides status/score/aiFeedback for a class-wide row with no student_id', () => {
    const row = { id: 'a1', student_id: null, status: 'completed', score: 90, ai_feedback: 'great', due_date: '2099-01-01' };
    const result = normalise(row);
    expect(result.status).toBe('pending');
    expect(result.score).toBeNull();
    expect(result.aiFeedback).toBeNull();
  });

  test('shows the real status/score for a personal assignment row', () => {
    const row = { id: 'a1', student_id: 's1', status: 'completed', score: 90, ai_feedback: 'great', due_date: '2099-01-01' };
    const result = normalise(row);
    expect(result.status).toBe('completed');
    expect(result.score).toBe(90);
    expect(result.aiFeedback).toBe('great');
  });

  test('marks closed=true for a real past-due row', () => {
    const row = { id: 'a1', student_id: 's1', due_date: '2020-01-01' };
    expect(normalise(row).closed).toBe(true);
  });

  test('defaults array/object fields to real empty values, not undefined', () => {
    const row = { id: 'a1', student_id: 's1', due_date: '2099-01-01' };
    const result = normalise(row);
    expect(result.questions).toEqual([]);
    expect(result.documentUrls).toEqual([]);
    expect(result.taskSteps).toEqual([]);
    expect(result.quizQuestions).toEqual([]);
    expect(result.linesOfInquiry).toEqual([]);
  });
});

describe('normaliseAnswerToOptionText', () => {
  const options = ['A. Paris', 'B. London', 'C. Rome', 'D. Berlin'];

  test('resolves a real numeric index answer to the matching real option', () => {
    expect(normaliseAnswerToOptionText(1, options)).toBe('London');
  });

  test('resolves a real letter-prefixed string answer ("B") to the matching real option', () => {
    expect(normaliseAnswerToOptionText('B', options)).toBe('London');
  });

  test('resolves a real 1-based numeric string answer ("2") to the matching real option', () => {
    expect(normaliseAnswerToOptionText('2', options)).toBe('London');
  });

  test('resolves a real exact-text answer to itself, prefix-stripped', () => {
    expect(normaliseAnswerToOptionText('Rome', options)).toBe('Rome');
  });

  test('an empty options list falls back to the real stripped raw answer', () => {
    expect(normaliseAnswerToOptionText('B. London', [])).toBe('London');
  });
});

describe('mcqToFillBlank', () => {
  test('converts a real mcq question into a real fill_blank question', () => {
    const q = { id: 'q1', question: 'What is the capital of France', type: 'mcq', options: ['Paris', 'Rome'], correct: 'Paris' };
    const result = mcqToFillBlank(q);
    expect(result.type).toBe('fill_blank');
    expect(result.options).toEqual([]);
    expect(result.correct).toBe('Paris');
    expect(result.question).toContain('The answer is ___.');
  });

  test('leaves a real already-fill_blank question unchanged', () => {
    const q = { id: 'q1', type: 'fill_blank', question: 'X? The answer is ___.', correct: 'Paris' };
    expect(mcqToFillBlank(q)).toBe(q);
  });

  test('leaves a real question with no correct answer unchanged (nothing to convert)', () => {
    const q = { id: 'q1', type: 'mcq', question: 'X?', correct: '' };
    expect(mcqToFillBlank(q)).toBe(q);
  });
});

describe('normalizeQuizQuestion', () => {
  test('accepts a real well-formed mcq question with exactly 4 options', () => {
    const result = normalizeQuizQuestion({ question: 'Q?', type: 'mcq', options: ['A', 'B', 'C', 'D'], correct: 'B' }, 0);
    expect(result.type).toBe('mcq');
    expect(result.options).toHaveLength(4);
    expect(result.correct).toBe('B');
  });

  test('rejects a real mcq question with fewer than 4 real options', () => {
    const result = normalizeQuizQuestion({ question: 'Q?', type: 'mcq', options: ['A', 'B'], correct: 'A' }, 0);
    expect(result).toBeNull();
  });

  test('rejects a real question with a blank prompt', () => {
    const result = normalizeQuizQuestion({ question: '  ', type: 'mcq', options: ['A', 'B', 'C', 'D'], correct: 'A' }, 0);
    expect(result).toBeNull();
  });

  test('accepts a real fill_blank question needing no options', () => {
    const result = normalizeQuizQuestion({ question: 'Q?', type: 'fill_blank', correct: 'Paris' }, 0);
    expect(result.type).toBe('fill_blank');
    expect(result.options).toEqual([]);
  });

  test('rejects a real fill_blank question with a blank correct answer', () => {
    const result = normalizeQuizQuestion({ question: 'Q?', type: 'fill_blank', correct: '  ' }, 0);
    expect(result).toBeNull();
  });
});

describe('normalizeQuizQuestions', () => {
  test('filters out real invalid questions and keeps real valid ones', () => {
    const items = [
      { question: 'Valid?', type: 'mcq', options: ['A', 'B', 'C', 'D'], correct: 'A' },
      { question: '', type: 'mcq', options: ['A', 'B', 'C', 'D'], correct: 'A' }, // blank prompt
      { question: 'Too few?', type: 'mcq', options: ['A', 'B'], correct: 'A' }, // too few options
    ];
    const result = normalizeQuizQuestions(items);
    expect(result).toHaveLength(1);
  });

  test('truncates to the real requested count when one is given', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, type: 'mcq', options: ['A', 'B', 'C', 'D'], correct: 'A' }));
    expect(normalizeQuizQuestions(items, 3)).toHaveLength(3);
  });
});

describe('normalizeQuizCount', () => {
  test('a null/empty value falls back to the real default', () => {
    expect(normalizeQuizCount(null, 5)).toBe(5);
    expect(normalizeQuizCount('', 5)).toBe(5);
  });

  test('a real value is clamped between 1 and 10', () => {
    expect(normalizeQuizCount(0)).toBe(5); // 0 is falsy-ish → fallback
    expect(normalizeQuizCount(50)).toBe(10);
    expect(normalizeQuizCount(-3)).toBe(1);
  });
});

describe('isGibberishAnswer', () => {
  test('flags real keyboard-mashing text as gibberish', () => {
    expect(isGibberishAnswer('kfjbsdfhbsd asdfghjkl')).toBe(true);
  });

  test('does not flag a real genuine sentence as gibberish', () => {
    expect(isGibberishAnswer('The sun gives us light and heat')).toBe(false);
  });

  test('empty/non-string input is never gibberish', () => {
    expect(isGibberishAnswer('')).toBe(false);
    expect(isGibberishAnswer(null)).toBe(false);
  });
});

describe('gibberishDescribed', () => {
  test('detects the real AI describing an answer as gibberish', () => {
    expect(gibberishDescribed('This looks like keyboard-mashing and is not a real word.')).toBe(true);
  });

  test('does not flag a real normal description', () => {
    expect(gibberishDescribed('The student correctly identified the main character.')).toBe(false);
  });
});

describe('buildFallbackQuiz', () => {
  test('returns the real requested count of fraction-themed questions for a "fractions" chapter', () => {
    const result = buildFallbackQuiz({ subject: 'Mathematics', chapter: 'Fractions', count: 5 });
    expect(result).toHaveLength(5);
    result.forEach(q => expect(q.type).toBe('mcq'));
  });

  test('converts to real fill_blank questions when quizType is fill_blank', () => {
    const result = buildFallbackQuiz({ subject: 'Mathematics', chapter: 'General', count: 3, quizType: 'fill_blank' });
    expect(result).toHaveLength(3);
    result.forEach(q => expect(q.type).toBe('fill_blank'));
  });
});
