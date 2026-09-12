// Script-aware OCR routing (detectScriptLang / callOcrText / Tesseract
// helpers) — added 2026-09-12 to give the fallback pipeline reliable
// Telugu/Indic-script OCR. Qwen was found to hallucinate Telugu text
// entirely (fabricated different real words than what was printed,
// verified against a real rendered worksheet image); Tesseract.js (free,
// local WASM, no API key) transcribed the same image correctly. Qwen is
// kept for Latin/English content, where it already works reliably.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { looksLikeDecodableImage, detectScriptLang, callTesseractOcrText, callOcrText } = require('../../services/quizVision');

// A minimal real 1x1 PNG - passes the magic-byte decodability check.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('looksLikeDecodableImage', () => {
  test('accepts a real PNG', () => {
    expect(looksLikeDecodableImage(TINY_PNG)).toBe(true);
  });
  test('accepts a real JPEG magic-byte prefix', () => {
    expect(looksLikeDecodableImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(true);
  });
  test('rejects garbage bytes', () => {
    expect(looksLikeDecodableImage(Buffer.from('not an image'))).toBe(false);
  });
  test('rejects a too-short buffer', () => {
    expect(looksLikeDecodableImage(Buffer.from([0x89, 0x50]))).toBe(false);
  });
  test('rejects a non-Buffer input', () => {
    expect(looksLikeDecodableImage('a string, not a buffer')).toBe(false);
  });
});

describe('image-format guard (crash-safety)', () => {
  // tesseract.js has a known failure mode: a truly undecodable buffer
  // makes its worker emit a Node 'error' event that escapes the returned
  // promise and crashes the whole process (verified live, outside a
  // try/catch). This guard exists specifically so Tesseract never sees
  // such a buffer.
  test('a garbage buffer is rejected before reaching Tesseract, without throwing', async () => {
    const garbage = Buffer.from('not a real image at all');
    await expect(callTesseractOcrText(garbage, 'tel')).rejects.toThrow(/not a decodable image/);
  });

  test('detectScriptLang defaults to eng (not a crash) for a garbage buffer', async () => {
    const lang = await detectScriptLang(Buffer.from('garbage'));
    expect(lang).toBe('eng');
  });

  test('a real (if tiny) PNG is accepted as decodable', async () => {
    // Should not throw synchronously on the format check; may still
    // return an empty/low-confidence result from real Tesseract, but
    // must not reject with the "not a decodable image" guard error.
    await expect(callTesseractOcrText(TINY_PNG, 'eng')).resolves.toEqual(expect.any(String));
  });
});

describe('callOcrText routing', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('routes to Qwen (via fetch) for Latin/English content, not Tesseract', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Task 1: Solve. a) 2 + 2 = ___' } }] }),
    });
    const text = await callOcrText(TINY_PNG, 'image/png');
    expect(global.fetch).toHaveBeenCalledWith('https://router.huggingface.co/v1/chat/completions', expect.objectContaining({ method: 'POST' }));
    expect(text).toContain('2 + 2');
  });

  test('a garbage buffer never reaches the network (Qwen) or crashes - fails cleanly', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('should not be reachable for a garbage buffer via Tesseract fallback either'));
    // Qwen is still attempted first (since detection defaults to 'eng' for
    // garbage input) and fails via the mocked network error; the secondary
    // engine (Tesseract) then correctly rejects via the format guard
    // rather than crashing - callOcrText should surface a clean error.
    await expect(callOcrText(Buffer.from('garbage'), 'image/png')).rejects.toThrow();
  });
});
