// Grades a student's drawing/photo. Groq has no vision model on this account
// (llama-4-maverick returns 404 model_not_found), so: Gemini → Mistral → Qwen.
// Returns the model's raw text; the caller parses the JSON.

async function toImage(url) {
  const m = String(url).match(/^data:([^;]+);base64,(.*)$/s);
  if (m) return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  return { mime: res.headers.get('content-type') || 'image/jpeg', buffer: Buffer.from(await res.arrayBuffer()) };
}

async function callVisionGrader(prompt, imageUrls) {
  // A worksheet image that can't be fetched is dropped; the student's image (last) must load.
  const loaded = await Promise.all(imageUrls.map((u, i) => toImage(u).catch((e) => {
    if (i === imageUrls.length - 1) throw e;
    console.warn('[visionGrader] worksheet image skipped:', e.message);
    return null;
  })));
  const images = loaded.filter(Boolean);
  const errors = [];

  if (process.env.GEMINI_API_KEY) {
    try {
      const { geminiModel } = require('./quizVision');
      const result = await geminiModel({ responseMimeType: 'application/json', temperature: 0.2 }).generateContent([
        { text: prompt },
        ...images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.buffer.toString('base64') } })),
      ]);
      return result.response.text();
    } catch (e) { errors.push(`gemini: ${e.message}`); }
  }
  if (process.env.MISTRAL_API_KEY) {
    try {
      const { callMistralVision } = require('./worksheet/providers');
      return await callMistralVision(images, prompt);
    } catch (e) { errors.push(`mistral: ${e.message}`); }
  }
  if (process.env.HF_TOKEN) {
    try {
      const { callQwenVisionRaw } = require('./quizVision');
      const student = images[images.length - 1];
      return await callQwenVisionRaw(student.buffer, student.mime, prompt);
    } catch (e) { errors.push(`qwen: ${e.message}`); }
  }
  throw new Error(errors.join(' | ') || 'no vision provider configured');
}

module.exports = { callVisionGrader };
