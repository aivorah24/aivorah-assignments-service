// Judges whether a student's written answer MEANS the same as the answer key.
// Shared by the worksheet page (POST /quiz/grade-answer) and the app quiz's
// fill-in-the-blank (validate-fill-blank and submit), so all three agree.
// Groq first; Gemini if Groq is down. Throws when neither can answer — the
// caller decides what "can't tell" means, never a silent "wrong".
const { dominantScript } = require('../utils/answerCheck');

// Writing system → language name. "Latin" must never reach the model as a
// language: it is the A–Z alphabet (English), and the model used to reply in
// Latin ("Bene tentasti…").
const SCRIPT_LANGUAGES = {
  Latin: 'English', Devanagari: 'Hindi', Telugu: 'Telugu', Tamil: 'Tamil', Kannada: 'Kannada',
  Malayalam: 'Malayalam', Bengali: 'Bengali', Gujarati: 'Gujarati', Gurmukhi: 'Punjabi', Oriya: 'Odia',
  Arabic: 'Urdu', Han: 'Chinese', Kana: 'Japanese', Hangul: 'Korean', Cyrillic: 'Russian', Greek: 'Greek',
};

// The worksheet's language when known (a French worksheet is also A–Z),
// else the language of the answer key's writing system.
function answerLanguage(language, expected) {
  return String(language || '').trim() || SCRIPT_LANGUAGES[dominantScript(expected)] || 'English';
}

async function gradeAnswerMeaning({ expected, student, question = '', acceptableAnswers = [], language = '' }) {
  const keys = [expected, ...acceptableAnswers].map(String).filter(k => k.trim());
  const lang = answerLanguage(language, expected);
  const prompt = `You grade a primary-school student's answer. Judge MEANING, not spelling of minor words.
Rules:
- "correct": the same meaning as the expected answer AND complete — every part it asks for is there (both words of a two-word answer, every item of a list). Other wording, a synonym or a small spelling slip is fine.
- "incorrect": anything else — wrong, off-topic, only part of the answer (e.g. "seller" when the answer is "buyer and seller"), a word that is not in the answer ("consumer"), or a different language than the expected answer. Expected answer language: ${lang}.
Return JSON: {"verdict":"correct|incorrect","reason":"one short, kind sentence for the student, written in ${lang}: for an incorrect answer say what is missing or wrong, without giving the answer away"}.

Question: ${String(question).slice(0, 600)}
Expected answer: ${String(expected).slice(0, 1000)}
${keys.length > 1 ? `Also acceptable: ${keys.slice(1).join(' / ').slice(0, 600)}\n` : ''}Student answer: ${String(student).slice(0, 2000)}`;

  let raw;
  try {
    const { callGroqWithText } = require('./quizVision');
    raw = await callGroqWithText(prompt, { maxTokens: 800 });
  } catch (groqErr) {
    // Groq down or rate-limited: a right answer must not turn "wrong" because
    // of it, so Gemini judges instead.
    if (!process.env.GEMINI_API_KEY) throw groqErr;
    console.warn('[answerGrader] Groq failed, using Gemini:', groqErr.message);
    const { geminiModel } = require('./quizVision');
    const result = await geminiModel({ responseMimeType: 'application/json', temperature: 0 }).generateContent([{ text: prompt }]);
    raw = result.response.text();
  }
  const parsed = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || raw);
  // Only a complete, correct answer counts; anything else (an old "partial" too) is wrong.
  const verdict = parsed.verdict === 'correct' ? 'correct' : 'incorrect';
  return { verdict, reason: String(parsed.reason || '').slice(0, 300) };
}

// Fill-in-the-blank answers worth asking the AI about: words, not numbers or
// signs (those have one right form and are checked exactly).
function isWordAnswer(expected) {
  return /\p{L}/u.test(String(expected)) && !/\d|[<>=≤≥≠]/.test(String(expected));
}

module.exports = { gradeAnswerMeaning, isWordAnswer, answerLanguage };
