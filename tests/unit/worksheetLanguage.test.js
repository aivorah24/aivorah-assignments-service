// 2026-10-13 manual test: Hindi/Telugu (any language) worksheets — students
// couldn't type answers in the worksheet's language and the language switcher
// didn't work (the IME called /quiz/transliterate on the frontend host).
const { renderQuizHTML, resolveQuizLanguage } = require('../../utils/quizHtmlRenderer');

const quiz = (q, extra = {}) => ({ tasks: [{ title: 'Words', questions: [{ question: q, answer: 'x', type: 'text' }] }], ...extra });

describe('resolveQuizLanguage', () => {
  test.each([
    ['అమ్మ ను రాయండి', 'te'], ['माँ लिखो', 'hi'], ['அம்மா எழுது', 'ta'], ['ಅಮ್ಮ ಬರೆಯಿರಿ', 'kn'],
    ['അമ്മ എഴുതുക', 'ml'], ['মা লেখো', 'bn'], ['માં લખો', 'gu'], ['ਮਾਂ ਲਿਖੋ', 'pa'],
    ['ମା ଲେଖ', 'or'], ['اكتب', 'ar'], ['写字', 'zh'], ['Write the word', 'en'],
  ])('detects %s → %s from the worksheet script', (text, code) => {
    expect(resolveQuizLanguage(quiz(text))).toBe(code);
  });

  test("the teacher's chosen language (name or code) wins over detection", () => {
    expect(resolveQuizLanguage(quiz('Write the word', { language: 'Tamil' }))).toBe('ta');
    expect(resolveQuizLanguage(quiz('माँ लिखो', { language: 'mr' }))).toBe('mr');
  });

  test('falls back to the subject name, then English', () => {
    expect(resolveQuizLanguage(quiz('Write the word', { subject: 'Kannada' }))).toBe('kn');
    expect(resolveQuizLanguage(quiz('Écris le mot', {}))).toBe('fr');
    expect(resolveQuizLanguage(quiz('Write', { language: 'auto' }))).toBe('en');
  });
});

describe('renderQuizHTML — typing answers in any language', () => {
  test('answer inputs carry the worksheet lang, dir=auto and no autocorrect', () => {
    const html = renderQuizHTML(quiz('அம்மா எழுது'), {});
    expect(html).toContain('<html lang="ta">');
    expect(html).toMatch(/<input[^>]*class="(q|lang)-input"[^>]*lang="ta" dir="auto"[^>]*spellcheck="false"/);
  });

  test('the IME calls the baked-in assignments-service origin, not the iframe host', () => {
    const html = renderQuizHTML(quiz('అమ్మ'), {}, { apiBase: 'https://assignments.example.com/' });
    expect(html).toContain('const API_BASE = "https://assignments.example.com" ||');
    expect(html).toContain("API_BASE + '/quiz/transliterate?text='");
  });

  test('the switcher lists every IME language plus "My keyboard", defaulting to the worksheet language', () => {
    const html = renderQuizHTML(quiz('ಅಮ್ಮ'), {});
    expect(html).toContain("return l.code === 'kn'");
    for (const name of ['Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam', 'Bengali']) expect(html).toContain(`"name":"${name}"`);
    expect(html).toContain('My keyboard (type directly)');
    expect(html).toContain("id = 'lang-menu'");
  });

  test('an English worksheet has no IME or switcher', () => {
    const html = renderQuizHTML(quiz('Write the word'), {});
    expect(html).not.toContain("id = 'lang-indicator'");
  });

  test('IME leaves native keyboard composition alone and highlights via data-active', () => {
    const html = renderQuizHTML(quiz('माँ'), {});
    expect(html).toContain('if (!enabled || composing || e.isComposing) return;');
    expect(html).toContain("dropdown.querySelector('div[data-active]')");
    expect(html).not.toContain('div[style*="rgba(147,176,172,0.15)"]');
  });

  test('answers are compared and saved NFC-normalized, and keyword matching keeps non-Latin letters', () => {
    const html = renderQuizHTML(quiz('అమ్మ'), {});
    expect(html).toContain('ok = matchesAnyAnswer(val, keysOf(a));');
    expect(html).toContain('function normalizeAnswer(text)');
    expect(html).toContain("data.answer.normalize('NFC')");
    expect(html).toContain('[^\\p{L}\\p{M}\\p{N}\\s]/gu');
    // The page's own script must still parse.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const js of scripts) expect(() => new Function(js)).not.toThrow();
  });
});
