// Regression test for a REAL manual-test bug report, 2026-09-14: the
// "Vocabulary Building 28 - PYP 4" worksheet (Language subject, 5 tasks:
// riddles, word sorting, error detection, sentence writing, reflection)
// came back with several silent content-loss defects:
//   - Subject: Mathematics (source explicitly says "Subject Focus: Language")
//   - Word Bank (10 words) missing entirely
//   - Task 3's passage missing (only the correction items were shown)
//   - Task 4's worked example missing
//   - Learners' Checklist (4 criteria) missing
//   - Credits line missing
//   - Task 1 numbered 1-10 in the source rendered as a-j
//
// This test fixes the exact real document's source text as the input (see
// tests/fixtures/vocabulary-building-28-source.txt) and exercises the
// REAL, GENERIC functions each defect maps to - it does not special-case
// "Vocabulary Building 28" in any production code path. A different
// document with the same generic patterns (an explicit "Subject:" line, a
// "Word Bank" heading, a passage before a correction table, a worked
// example, a checklist, a credits line, a sequentially-numbered list) is
// expected to be fixed identically - see explicitMetadataAndContentBlocks
// .test.js for the non-worksheet-specific versions of these same checks.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { applyExplicitMetadata, findMissingNamedBlocks, buildConversionReport } = require('../../services/quizVision');
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');

const SOURCE_TEXT = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'vocabulary-building-28-source.txt'),
  'utf8'
);

describe('Vocabulary Building 28 - regression for the real reported defects', () => {
  test('subject resolves to Language even if the LLM (as it did live) said Mathematics', () => {
    const quiz = { subject: 'Mathematics', grade: 'PYP 4', tasks: [] };
    applyExplicitMetadata(quiz, SOURCE_TEXT);
    expect(quiz.subject).toBe('Language');
  });

  test('a quiz that DID correctly extract wordBank/checklist/credits is NOT flagged (no false alarm)', () => {
    const quiz = {
      wordBank: ['economy', 'production', 'consumption', 'resources', 'goods', 'services', 'market', 'trade', 'buyer', 'seller'],
      checklist: [
        'I can understand new words and solve the riddles and correct errors carefully.',
        'I can use vocabulary words correctly in my sentences to show my understanding.',
        'I can share my ideas clearly, organise my thoughts, and give examples to support my answers.',
        'I can complete my work independently, neatly, and with effort and responsibility.',
      ],
      credits: 'Credits: PYP 4 Team',
    };
    expect(quiz.wordBank.length).toBe(10);
    expect(quiz.checklist.length).toBe(4);
    expect(findMissingNamedBlocks(quiz, SOURCE_TEXT)).toEqual([]);
  });

  test('the exact real regression: wordBank/checklist/credits all silently empty despite the source clearly naming them -> all three flagged', () => {
    const quiz = { wordBank: [], checklist: [], credits: '' };
    const missing = findMissingNamedBlocks(quiz, SOURCE_TEXT);
    expect(missing).toEqual(expect.arrayContaining(['Word Bank', 'Learners’ Checklist', 'Credits']));
  });

  test('buildConversionReport surfaces the missing-named-block regression as REVIEW_REQUIRED, not silently COMPLETE', () => {
    const quiz = {
      subject: 'Language',
      wordBank: [], checklist: [], credits: '',
      tasks: [{ title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] }],
    };
    const report = buildConversionReport(quiz, { sourceText: SOURCE_TEXT });
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
    expect(report.missingContentWarning).toMatch(/Word Bank/);
  });

  test('Task 1 riddle table renders sequential numbering 1-10 (not the internal a-j layout ids) — the exact reported numbering bug', () => {
    const riddles = [
      'I am a place where people come to buy and sell many things.',
      'I am a person who buys things from shops or markets.',
      'I am the person who sells goods to others.',
      'I am the process of making goods using materials and effort.',
      'I am what happens when people use or buy goods and services.',
      'I am things like water, soil, and minerals that help us make products.',
      'I am items you can touch and buy, like books, toys, or fruits.',
      'I am something you cannot touch but can use, like teaching or transport.',
      'I am the buying and selling of goods between people or countries.',
      'I am a system that shows how people produce, buy, and sell things in a place.',
    ];
    const answers = ['market', 'buyer', 'seller', 'production', 'consumption', 'resources', 'goods', 'services', 'trade', 'economy'];
    const quiz = {
      subject: 'Language',
      tasks: [{
        title: 'Task 1: Read each riddle carefully. Choose the correct answer from the word bank above.',
        questions: riddles.map((question, i) => ({ id: String.fromCharCode(97 + i), question, answer: answers[i], type: 'text' })),
      }],
    };
    const html = renderQuizHTML(quiz, {});
    // Sequential 1-10 must appear in the rendered table; the internal
    // letter ids (a, b, c...) must NOT be what's shown as the row number.
    expect(html).toMatch(/>\s*1\s*</);
    expect(html).toMatch(/>\s*10\s*</);
    for (const riddle of riddles) expect(html).toContain(riddle);
  });

  test('Task 3 passage renders verbatim alongside its correction table (not silently dropped)', () => {
    const passage = "In a small town, there was a busy buyer where people came every day. Farmers were involved in consumption, growing crops using natural goods like water and soil. Customers visited the town for production, buying things they needed. A seller would choose items carefully, while a market tried to offer the best price. This exchange of goods and services kept the town's trade active and growing.";
    const quiz = {
      tasks: [{
        title: 'Task 3: Error Detective Alert - Read & Detect Errors',
        passage,
        table: {
          headers: ['Incorrect Word', 'Correct Word'],
          rows: [
            [{ text: 'buyer' }, { input: true, answer: 'market' }],
            [{ text: 'consumption' }, { input: true, answer: 'production' }],
          ],
        },
      }],
    };
    const html = renderQuizHTML(quiz, {});
    expect(html).toContain(passage);
  });

  test('Task 4 worked example renders verbatim alongside the answer area', () => {
    const example = 'The buyer went to the market to purchase goods from the seller.';
    const quiz = {
      tasks: [{ title: 'Task 4: Word to Sentence Challenge!', questions: [{ question: 'Write your own sentence.', example, answer: '', type: 'text' }] }],
    };
    const html = renderQuizHTML(quiz, {});
    expect(html).toContain(example);
  });

  test('the full checklist and credits render together', () => {
    const quiz = {
      checklist: [
        'I can understand new words and solve the riddles and correct errors carefully.',
        'I can use vocabulary words correctly in my sentences to show my understanding.',
        'I can share my ideas clearly, organise my thoughts, and give examples to support my answers.',
        'I can complete my work independently, neatly, and with effort and responsibility.',
      ],
      credits: 'Credits: PYP 4 Team',
      tasks: [],
    };
    const html = renderQuizHTML(quiz, {});
    for (const c of quiz.checklist) expect(html).toContain(c);
    expect(html).toContain('Credits: PYP 4 Team');
    expect((html.match(/type="checkbox"/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});
