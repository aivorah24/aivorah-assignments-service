// Shared answer checks (server grade-answer + the student worksheet page).
// 2026-10-13 manual test: Tamil "வணக்கம்" was accepted on a Telugu worksheet.
const { dominantScript, requiredScript, isWrongScript, normalizeAnswer, matchesAnyAnswer } = require('../../utils/answerCheck');

describe('dominantScript', () => {
  test.each([
    ['అమ్మ', 'Telugu'], ['வணக்கம்', 'Tamil'], ['नमस्ते', 'Devanagari'], ['hello', 'Latin'],
    ['12 cm', 'Latin'], ['42', ''], ['అమ్మమ్మ ok', 'Telugu'],
  ])('%s → %s', (text, script) => expect(dominantScript(text)).toBe(script));
});

describe('isWrongScript', () => {
  test('a Tamil or Latin answer to a Telugu answer key is the wrong script', () => {
    expect(isWrongScript('வணக்கம்', 'అమ్మ', 'Telugu')).toBe(true);
    expect(isWrongScript('amma', 'అమ్మ', 'Telugu')).toBe(true);
    expect(isWrongScript('అమ్మా', 'అమ్మ', 'Telugu')).toBe(false);
  });

  test('open questions (no key) on a Telugu worksheet still require Telugu', () => {
    expect(requiredScript('', 'Telugu')).toBe('Telugu');
    expect(isWrongScript('வணக்கம்', '', 'Telugu')).toBe(true);
    expect(isWrongScript('నేను బడికి వెళ్ళాను', '', 'Telugu')).toBe(false);
  });

  test('numbers and English worksheets impose no script', () => {
    expect(isWrongScript('5', '5', 'Telugu')).toBe(false);
    expect(isWrongScript('anything', 'football', 'Latin')).toBe(false);
    expect(isWrongScript('అమ్మ', '', 'Latin')).toBe(false);
  });
});

describe('normalizeAnswer / matchesAnyAnswer', () => {
  test('ignores case, spacing, punctuation and Unicode composition', () => {
    expect(normalizeAnswer('The  Football!')).toBe('thefootball');
    expect(matchesAnyAnswer('గద్ద గాలిలో ఎగురుతుంది.', ['గద్ద గాలిలో ఎగురుతుంది'])).toBe(true);
    expect(matchesAnyAnswer('é', ['é'])).toBe(true);
  });

  test('a different spelling (wrong ottu) does not match', () => {
    expect(matchesAnyAnswer('గద్ర గాలిలో ఎగురుతుంది', ['గద్ద గాలిలో ఎగురుతుంది'])).toBe(false);
  });

  test('any accepted wording matches; empty keys never match', () => {
    expect(matchesAnyAnswer('lake', ['the pond', 'lake'])).toBe(true);
    expect(matchesAnyAnswer('x', ['', null])).toBe(false);
    expect(matchesAnyAnswer('', ['x'])).toBe(false);
  });
});
