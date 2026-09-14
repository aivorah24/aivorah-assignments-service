// extractExplicitMetadata / applyExplicitMetadata / findMissingNamedBlocks
// — added 2026-09-14 after a real manual-test report: a "Subject Focus:
// Language" worksheet was generated with "Subject: Mathematics" in the
// output. Root cause: buildQuizVisionPrompt's schema told the model to
// echo back whatever subject/grade the CALLER passed as generation
// context (defaulting to 'Mathematics'/'PYP 4'), never to read the
// worksheet's own printed metadata line. Per the explicit rule "never use
// an LLM guess when explicit source metadata exists", this is a
// deterministic (non-LLM) regex scan of the extracted source text for
// generic "Label: value" metadata lines, applied as a post-generation
// override — generic label patterns, not tied to any one worksheet's
// wording, and never invents a value when the source doesn't state one.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { extractExplicitMetadata, applyExplicitMetadata, findMissingNamedBlocks } = require('../../services/quizVision');

describe('extractExplicitMetadata - generic label-pattern scan, not tied to one worksheet', () => {
  test('the exact real-world case: "Subject Focus: Language" is extracted', () => {
    const text = 'Name of Learner: ______\nPYP: 4\nSubject Focus: Language\nPurpose: Vocabulary building';
    const meta = extractExplicitMetadata(text);
    expect(meta.subject).toBe('Language');
    expect(meta.grade).toBe('4');
    expect(meta.purpose).toBe('Vocabulary building');
  });

  test('a plain "Subject:" label (not "Subject Focus:") is also recognized - generic, not one exact phrase', () => {
    expect(extractExplicitMetadata('Subject: Science\n').subject).toBe('Science');
  });

  test('"Grade:" and "Class:" are both recognized as grade-equivalent labels', () => {
    expect(extractExplicitMetadata('Grade: 7\n').grade).toBe('7');
    expect(extractExplicitMetadata('Class: 7B\n').grade).toBe('7B');
  });

  test('a document with no explicit metadata lines returns an empty object - never invents a value', () => {
    expect(extractExplicitMetadata('Just a worksheet with some questions.\n1. What is 2+2?')).toEqual({});
  });

  test('empty/null source text is handled safely', () => {
    expect(extractExplicitMetadata('')).toEqual({});
    expect(extractExplicitMetadata(null)).toEqual({});
  });
});

describe('applyExplicitMetadata - overrides the LLM output ONLY when the source explicitly states a value', () => {
  test('the exact real-world bug: LLM said Mathematics, source says Language - source wins', () => {
    const quiz = { subject: 'Mathematics', grade: 'PYP 4' };
    applyExplicitMetadata(quiz, 'Subject Focus: Language\nPYP: 4');
    expect(quiz.subject).toBe('Language');
  });

  test('when the source states nothing explicit, the LLM/caller-provided value is left untouched', () => {
    const quiz = { subject: 'Mathematics', grade: 'PYP 4' };
    applyExplicitMetadata(quiz, 'Just some worksheet text with no metadata labels.');
    expect(quiz.subject).toBe('Mathematics');
    expect(quiz.grade).toBe('PYP 4');
  });

  test('purpose/learningOutcomes are only filled in when the LLM left them empty (source metadata is a fallback here, not an override)', () => {
    const quiz = { purpose: 'Already extracted by the LLM', learningOutcomes: [] };
    applyExplicitMetadata(quiz, 'Purpose: A different purpose line\nLearning Outcome: Some outcome');
    expect(quiz.purpose).toBe('Already extracted by the LLM'); // not overwritten
    expect(quiz.learningOutcomes).toEqual(['Some outcome']); // filled in, was empty
  });
});

describe('findMissingNamedBlocks - generic heading-presence check, not exact-wording-based', () => {
  test('source mentions "Word Bank" but quiz.wordBank is empty -> flagged', () => {
    const quiz = { wordBank: [] };
    const missing = findMissingNamedBlocks(quiz, 'Word Bank: economy, market, trade');
    expect(missing).toContain('Word Bank');
  });

  test('source mentions "Vocabulary List" (a different but equivalent heading) -> still flagged generically', () => {
    const quiz = { wordBank: [] };
    const missing = findMissingNamedBlocks(quiz, 'Vocabulary List\neconomy, market, trade');
    expect(missing).toContain('Word Bank');
  });

  test('quiz.wordBank is populated -> NOT flagged, even though the heading is present', () => {
    const quiz = { wordBank: ['economy', 'market', 'trade'] };
    expect(findMissingNamedBlocks(quiz, 'Word Bank: economy, market, trade')).toEqual([]);
  });

  test('source never mentions Word Bank/checklist/credits at all -> nothing flagged', () => {
    const quiz = { wordBank: [], checklist: [], credits: '' };
    expect(findMissingNamedBlocks(quiz, 'Just a plain worksheet with some questions.')).toEqual([]);
  });

  test('checklist and credits headings are each detected independently', () => {
    const quiz = { checklist: [], credits: '' };
    const missing = findMissingNamedBlocks(quiz, "Learners' Checklist\n- criterion one\nCredits: PYP 4 Team");
    expect(missing).toEqual(expect.arrayContaining(['Learners’ Checklist', 'Credits']));
  });
});
