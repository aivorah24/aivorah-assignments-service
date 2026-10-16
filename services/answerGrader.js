// Judges whether a student's written answer MEANS the same as the answer key.
// Shared by the worksheet page (POST /quiz/grade-answer) and the app quiz's
// fill-in-the-blank (validate-fill-blank and submit), so all three agree.
// Groq first; Gemini if Groq is down. Throws when neither can answer — the
// caller decides what "can't tell" means, never a silent "wrong".
const { dominantScript } = require('../utils/answerCheck');

async function gradeAnswerMeaning({ expected, student, question = '', acceptableAnswers = [] }) {
  const keys = [expected, ...acceptableAnswers].map(String).filter(k => k.trim());
  const prompt = `You grade a primary-school student's answer. Judge MEANING, not spelling of minor words.
Rules:
- "correct": same meaning as the expected answer (a paraphrase or a shorter form that still answers the question is fine).
- "partial": partly right (one of two required parts, or the right idea with a factual slip).
- "incorrect": wrong, off-topic, empty of meaning, or in a different language than the expected answer. Expected answer language/script: ${dominantScript(expected) || 'any'}.
Return JSON: {"verdict":"correct|partial|incorrect","reason":"one short, kind sentence for the student, in the language of the expected answer"}.

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
  const verdict = ['correct', 'partial', 'incorrect'].includes(parsed.verdict) ? parsed.verdict : 'incorrect';
  return { verdict, reason: String(parsed.reason || '').slice(0, 300) };
}

// Fill-in-the-blank answers worth asking the AI about: words, not numbers or
// signs (those have one right form and are checked exactly).
function isWordAnswer(expected) {
  return /\p{L}/u.test(String(expected)) && !/\d|[<>=≤≥≠]/.test(String(expected));
}

module.exports = { gradeAnswerMeaning, isWordAnswer };
