// Student worksheet page grading (renderQuizHTML). 2026-10-13 manual test:
// Tamil "வணக்கம்" was marked "Answer recorded ✔" on a Telugu worksheet —
// questions without an answer key were auto-accepted in any script, and the
// keyword matcher only understood Latin words.
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');

const telugu = qs => ({ tasks: [{ title: 'ఇ) వాక్యాలను తిరిగి రాయండి', questions: qs }] });
const answersOf = html => JSON.parse(html.match(/const answers = (\{[\s\S]*?\});\n/)[1]);
const pageScripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('the page knows the worksheet script and carries the shared answer checks', () => {
  const html = renderQuizHTML(telugu([{ question: 'గద్ర గాలిలో ఎగురుతుంది.', answer: 'గద్ద గాలిలో ఎగురుతుంది', type: 'text' }]), {});
  expect(html).toContain('const WORKSHEET_SCRIPT = "Telugu";');
  for (const fn of ['dominantScript', 'requiredScript', 'isWrongScript', 'normalizeAnswer', 'matchesAnyAnswer', 'fmt']) {
    expect(html).toContain(`function ${fn}(`);
  }
  for (const js of pageScripts(html)) expect(() => new Function(js)).not.toThrow();
});

test('wrong-script answers are rejected before any open/auto-accept path', () => {
  const html = renderQuizHTML(telugu([{ question: 'మీ సెలవుల గురించి రాయండి', type: 'long' }]), {});
  const check = html.slice(html.indexOf('async function checkAnswer(id)'));
  expect(check.indexOf('isWrongScript(val')).toBeGreaterThan(-1);
  expect(check.indexOf('isWrongScript(val')).toBeLessThan(check.indexOf('if (a.open)'));
});

test('a Telugu answer key is graded exactly (plus accepted wordings), not by English keyword overlap', () => {
  const html = renderQuizHTML(telugu([
    { question: 'గద్ర గాలిలో ఎగురుతుంది.', answer: 'గద్ద గాలిలో ఎగురుతుంది', acceptableAnswers: ['గద్ద ఆకాశంలో ఎగురుతుంది'], type: 'text' },
  ]), {});
  const a = Object.values(answersOf(html))[0];
  expect(a.theory).toBe(true); // goes to exact check, then the server
  expect(a.alts).toEqual(['గద్ద ఆకాశంలో ఎగురుతుంది']);
  expect(html).toContain("const latinKey = dominantScript(String(a.answer)) === 'Latin';");
  expect(html).toContain('matchesAnyAnswer(val, keysOf(a)) || (latinKey && keywordMatch(val, String(a.answer)))');
});

test('a question with no answer key is recorded for teacher review instead of failing or passing silently', () => {
  const html = renderQuizHTML(telugu([
    { question: 'బొమ్మలో ఏముంది?', answer: null, type: 'text', visualUnderstandingRequired: true },
    { question: 'Write about your holiday', type: 'long' },
  ]), {});
  const [visual, open] = Object.values(answersOf(html));
  expect(visual).toMatchObject({ open: true, review: true });
  expect(open).toMatchObject({ open: true, review: false });
  expect(html).toContain('your teacher will check it');
});

test('the server is told the worksheet script and accepted wordings', () => {
  const html = renderQuizHTML(telugu([{ question: 'q', answer: 'తామర పూలు', type: 'text' }]), {});
  expect(html).toContain('acceptableAnswers: a.alts || [], worksheetScript: WORKSHEET_SCRIPT');
});

// 2026-10-16 manual test: one shared keyword was enough ("not Paris" passed),
// while right answers worded differently ("make" for "making") failed.
describe('instant answer check on the worksheet page', () => {
  const html = renderQuizHTML({ tasks: [{ title: 'Answer', questions: [{ question: 'Capital of France?', answer: 'Paris', type: 'text' }] }] }, {});
  const block = html.slice(html.indexOf('const STOPWORDS'), html.indexOf('// Track when each question'));
  const toNumberSrc = html.match(/function toNumber\(v\) \{.*\}/)[0];
  // eslint-disable-next-line no-new-func
  const { keywordMatch, toNumber } = new Function(`${block}\n${toNumberSrc}\nreturn { keywordMatch, toNumber };`)();

  test.each([
    ['Paris', 'The answer is Paris.'], ['Paris', 'I think it is paris'], ['Paris', 'Parris'],
    ['football and hockey', 'Footballs & Hockey'], ['tilling, making seedbeds and sowing', 'till, make seedbeds and sow'],
    ['Plants need sunlight and water', 'plant needs water and sunlight'],
    ['Yes, because 9/12 is more than 8/12.', 'yes because 9/12 is more than 8/12'],
  ])('right answer in other words: "%s" ← "%s"', (key, typed) => {
    expect(keywordMatch(typed, key)).toBe(true);
  });

  test.each([
    ['Paris', 'not Paris'], ['Paris', 'Paris and London'], ['Paris', 'Parks'],
    ['football and hockey', 'football'], ['football and hockey', 'football and swimming'],
    ['tilling, making seedbeds and sowing', 'tilling and sowing'],
    ['Plants need sunlight and water', 'plants do not need sunlight and water'],
    ['Yes, because 9/12 is more than 8/12.', 'Yes'], ['Yes, because 9/12 is more than 8/12.', 'Yes, because 5/12 is more than 8/12'],
  ])('not accepted instantly (wrong, or for the AI to judge): "%s" ← "%s"', (key, typed) => {
    expect(keywordMatch(typed, key)).toBe(false);
  });

  test('number answers read thousands separators', () => {
    expect(toNumber('4,000')).toBe(4000);
    expect(toNumber('1,000,000')).toBe(1000000);
    expect(toNumber('4000.5')).toBe(4000.5);
  });

  test('when the AI meaning check cannot run, the answer goes to the teacher instead of being marked wrong', () => {
    expect(html).toContain("needsReview: true };");
    expect(html).toContain('Answer recorded — your teacher will check it');
  });
});

test('the page sends the worksheet language with the AI meaning check', () => {
  const html = renderQuizHTML({ language: 'English', tasks: [{ title: 'T', questions: [{ question: 'Capital of France?', answer: 'Paris', type: 'text' }] }] }, {});
  expect(html).toContain('const WORKSHEET_LANGUAGE = "English";');
  expect(html).toContain('language: WORKSHEET_LANGUAGE');
  for (const js of pageScripts(html)) expect(() => new Function(js)).not.toThrow();
});

test('header: curriculum as text, subject alone, no level label in the title', () => {
  const html = renderQuizHTML({ school: 'Vethathiri', curriculum: 'CBSE', grade: 'Grade 4', title: 'PYP: 4 Vocabulary Building',
    subject: 'Language Purpose: Vocabulary building Learning Outcome: Learner uses spell check.', tasks: [] }, {});
  expect(html).toContain('<div class="header-sub">Vethathiri &middot; CBSE &middot; Grade 4</div>');
  expect(html).toContain('<h1>Vocabulary Building</h1>');
  expect(html).toMatch(/Subject: Language &nbsp;\|/);
});

// 2026-10-16: "hoepef ewwjfwejfeo" was "Answer recorded ✔" on a reflection
// question, under an empty "Solution" panel.
describe('questions with no single right answer', () => {
  const Q = 'Why is it important to use the correct economic terms in a sentence?';
  const html = renderQuizHTML({ tasks: [{ title: 'Task 5', questions: [{ question: Q, type: 'long' }] }] }, {});

  test('the answer is checked as a real attempt at the question before it is recorded', () => {
    const a = Object.values(answersOf(html))[0];
    expect(a.open).toBe(true);
    expect(a.question).toBe(Q);
    const open = html.slice(html.indexOf('if (a.open) {'));
    expect(open.indexOf("expected: '', student: val, question: a.question")).toBeGreaterThan(-1);
    expect(open.indexOf("expected: '', student: val")).toBeLessThan(open.indexOf('Answer recorded'));
  });

  test('an empty solution box is never shown; one with a solution still is', () => {
    expect(html).toMatch(/class="solution-box" data-empty="1"/);
    expect(html).toContain('.solution-box[data-empty] { display: none !important; }');
    const withSolution = renderQuizHTML({ tasks: [{ title: 'T', questions: [{ question: 'Capital of France?', answer: 'Paris', solution: 'Paris is the capital.', type: 'text' }] }] }, {});
    expect(withSolution).not.toMatch(/class="solution-box" data-empty/);
  });
});

