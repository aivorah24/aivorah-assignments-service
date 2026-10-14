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
