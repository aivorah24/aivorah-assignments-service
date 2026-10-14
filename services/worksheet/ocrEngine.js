// Offline OCR for worksheet pages (Tesseract.js + bundled @tesseract.js-data).
//
// Why bundled: tesseract.js otherwise downloads traineddata from a CDN on the
// first call of every new container, and its script detector (OSD) needs the
// legacy model that the default worker doesn't load — so detection silently
// fell back to English and Telugu/Hindi pages were OCR'd as Latin garbage.
// Language packs ship in node_modules; they're copied once into a temp
// langPath because tesseract.js reads `<lang>.traineddata.gz` from one folder.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tesseract OSD script name → traineddata code(s).
const SCRIPT_TO_LANGS = {
  Latin: ['eng'],
  Telugu: ['tel'],
  Devanagari: ['hin'],
  Tamil: ['tam'],
  Kannada: ['kan'],
  Malayalam: ['mal'],
  Bengali: ['ben'],
  Gujarati: ['guj'],
  Gurmukhi: ['pan'],
  Oriya: ['ori'],
  Arabic: ['ara', 'urd'],
};

// Unicode ranges → OSD script names, for scripts already visible in a text layer.
const SCRIPT_RANGES = [
  ['Telugu', /[ఀ-౿]/], ['Devanagari', /[ऀ-ॿ]/], ['Tamil', /[஀-௿]/],
  ['Kannada', /[ಀ-೿]/], ['Malayalam', /[ഀ-ൿ]/], ['Bengali', /[ঀ-৿]/],
  ['Gujarati', /[઀-૿]/], ['Gurmukhi', /[਀-੿]/], ['Oriya', /[଀-୿]/],
  ['Arabic', /[؀-ۿ]/],
];

// Language names a teacher/subject may give → OSD script.
const LANGUAGE_TO_SCRIPT = {
  telugu: 'Telugu', hindi: 'Devanagari', marathi: 'Devanagari', sanskrit: 'Devanagari', nepali: 'Devanagari',
  tamil: 'Tamil', kannada: 'Kannada', malayalam: 'Malayalam', bengali: 'Bengali', gujarati: 'Gujarati',
  punjabi: 'Gurmukhi', odia: 'Oriya', oriya: 'Oriya', urdu: 'Arabic', arabic: 'Arabic',
  te: 'Telugu', hi: 'Devanagari', mr: 'Devanagari', sa: 'Devanagari', ne: 'Devanagari', ta: 'Tamil',
  kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali', gu: 'Gujarati', pa: 'Gurmukhi', or: 'Oriya', ur: 'Arabic', ar: 'Arabic',
};

function scriptsInText(text) {
  const s = String(text || '');
  return SCRIPT_RANGES.filter(([, re]) => re.test(s)).map(([name]) => name);
}

function scriptsFromHints(hints = []) {
  const out = new Set();
  for (const h of hints) {
    const words = String(h || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const w of words) if (LANGUAGE_TO_SCRIPT[w] && w.length > 2) out.add(LANGUAGE_TO_SCRIPT[w]);
    const code = String(h || '').trim().toLowerCase();
    if (LANGUAGE_TO_SCRIPT[code]) out.add(LANGUAGE_TO_SCRIPT[code]);
  }
  return [...out];
}

// Always include English: worksheets mix English instructions with the target script.
function langsForScripts(scripts) {
  const langs = new Set();
  for (const s of scripts) for (const l of SCRIPT_TO_LANGS[s] || []) langs.add(l);
  langs.add('eng');
  // Indic/Arabic first: Tesseract weights the first language highest.
  return [...langs].sort((a, b) => (a === 'eng') - (b === 'eng'));
}

let langDirPromise = null;
function bundledLangDir() {
  if (!langDirPromise) {
    langDirPromise = (async () => {
      const dir = path.join(os.tmpdir(), 'aivorah-tessdata');
      await fs.promises.mkdir(dir, { recursive: true });
      const codes = [...new Set(Object.values(SCRIPT_TO_LANGS).flat()), 'osd'];
      for (const code of codes) {
        // best_int for LSTM recognition; OSD needs the legacy 4.0.0 model.
        const variant = code === 'osd' ? '4.0.0' : '4.0.0_best_int';
        let src;
        try { src = require.resolve(`@tesseract.js-data/${code}/${variant}/${code}.traineddata.gz`); } catch { continue; }
        const dest = path.join(dir, `${code}.traineddata.gz`);
        if (!fs.existsSync(dest)) await fs.promises.copyFile(src, dest);
      }
      return dir;
    })().catch((err) => { langDirPromise = null; throw err; });
  }
  return langDirPromise;
}

// One worker at a time: Tesseract WASM is memory-heavy and Render instances are small.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const workers = new Map(); // langKey → worker (kept warm for the pages of one document)
async function getWorker(langs, { legacy = false } = {}) {
  const key = `${legacy ? 'L:' : ''}${langs.join('+')}`;
  if (workers.has(key)) return workers.get(key);
  // Keep at most two warm workers.
  if (workers.size >= 2) {
    const [oldKey, old] = workers.entries().next().value;
    workers.delete(oldKey);
    await old.terminate().catch(() => {});
  }
  const Tesseract = require('tesseract.js');
  const langPath = await bundledLangDir();
  const worker = await Tesseract.createWorker(langs, legacy ? 0 : 1, {
    langPath, cacheMethod: 'none', gzip: true,
    ...(legacy ? { legacyCore: true, legacyLang: true } : {}),
  });
  workers.set(key, worker);
  return worker;
}

async function terminateWorkers() {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map(w => w.terminate().catch(() => {})));
}

function isDecodableImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const jpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp = buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  const bmp = buffer[0] === 0x42 && buffer[1] === 0x4d;
  return png || jpg || webp || bmp;
}

// Grey + contrast-stretched: lifts faint scans and grey photocopies; clean
// renders are unaffected. Non-PNG input (a JPEG photo) is passed through.
async function prepareForOcr(buffer) {
  const { jimpFromPng, pngBuffer, isPng } = require('./pngImage');
  if (!isPng(buffer)) return buffer;
  try {
    const img = jimpFromPng(buffer);
    img.greyscale().normalize();
    return pngBuffer(img);
  } catch {
    return buffer;
  }
}

// OSD script detection. Returns an OSD script name or null when unsure.
async function detectScript(imageBuffer) {
  if (!isDecodableImage(imageBuffer)) return null;
  return serial(async () => {
    try {
      const worker = await getWorker(['osd'], { legacy: true });
      const { data } = await worker.detect(imageBuffer);
      return data && data.script && SCRIPT_TO_LANGS[data.script] ? data.script : null;
    } catch (err) {
      console.warn('[ocr] script detection failed:', err.message);
      return null;
    }
  });
}

// Full OCR with line boxes. `langs` like ['tel', 'eng']; `sparse` reads
// scattered words (labels around pictures) instead of text blocks; `digits`
// reads only digits (lone "8"s in stacked fractions are otherwise missed);
// `line` reads one line of text (a numerator cut out on its own).
async function ocrImage(imageBuffer, langs = ['eng'], { sparse = false, digits = false, line = false } = {}) {
  if (!isDecodableImage(imageBuffer)) throw new Error('OCR: input is not a decodable image');
  return serial(async () => {
    const worker = await getWorker(langs);
    await worker.setParameters({
      tessedit_pageseg_mode: line ? '7' : sparse ? '11' : '6', // 6 = the library default
      tessedit_char_whitelist: digits ? '0123456789' : '',
    });
    const { data } = await worker.recognize(await prepareForOcr(imageBuffer), {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = String(line.text || '').replace(/\s+/g, ' ').trim();
          const words = (line.words || []).map(w => ({ text: String(w.text || '').trim(), confidence: Math.round(w.confidence || 0), bbox: w.bbox })).filter(w => w.text);
          if (text) lines.push({ text, confidence: Math.round(line.confidence || 0), bbox: line.bbox, words });
        }
      }
    }
    return { text: String(data.text || '').trim(), confidence: Math.round(data.confidence || 0), lines, langs };
  });
}

// OSD alone mistakes Telugu photos for Arabic (and is unsure on many phone
// photos). So its guess is checked by reading a band of the page in that
// script and in English; when neither reads confidently, every script is
// tried and the one Tesseract reads with the highest confidence wins (a
// Telugu sheet reads at ~70 in Telugu, ≤45 in any other script).
const CONFIDENT = 58;
async function pickScript(imageBuffer) {
  if (!isDecodableImage(imageBuffer)) return null;
  const { jimpFromPng, pngBuffer, isDecodable } = require('./pngImage');
  let sample = imageBuffer;
  if (isDecodable(imageBuffer)) {
    const img = jimpFromPng(imageBuffer);
    const { width: W, height: H, data: d } = img.bitmap;
    // The band with the most text (a short page has its text near the top):
    // text rows switch light↔dark often; the dark table round a photo doesn't.
    const rowInk = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let prev = false;
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4; const dark = d[o] + d[o + 1] + d[o + 2] < 390;
        if (dark && !prev) rowInk[y]++;
        prev = dark;
      }
    }
    const bandH = Math.max(1, Math.round(H * 0.4));
    let best = 0; let bestY = 0; let sum = 0;
    for (let y = 0; y < H; y++) {
      sum += rowInk[y] - (y >= bandH ? rowInk[y - bandH] : 0);
      if (y >= bandH - 1 && sum > best) { best = sum; bestY = y - bandH + 1; }
    }
    img.crop({ x: 0, y: bestY, w: W, h: Math.min(bandH, H - bestY) });
    if (img.bitmap.width > 1000) img.resize({ w: 1000 });
    sample = pngBuffer(img);
  }
  const scores = new Map();
  const score = async (script) => {
    if (!scores.has(script)) {
      try { scores.set(script, (await ocrImage(sample, SCRIPT_TO_LANGS[script].slice(0, 1))).confidence); } catch { scores.set(script, 0); }
    }
    return scores.get(script);
  };
  const guess = await detectScript(imageBuffer);
  const first = [...new Set([guess || 'Latin', 'Latin'])];
  for (const sc of first) await score(sc);
  const best = () => [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best()[1] < CONFIDENT) for (const sc of Object.keys(SCRIPT_TO_LANGS)) await score(sc);
  const [script, conf] = best();
  // Another script must read clearly better than English: on a page with
  // little text every script scores low and the top one is noise.
  if (script !== 'Latin' && (conf < 50 || conf < scores.get('Latin') + 10)) return 'Latin';
  return script;
}

module.exports = {
  ocrImage, detectScript, pickScript, terminateWorkers, scriptsInText, scriptsFromHints, langsForScripts,
  isDecodableImage, SCRIPT_TO_LANGS,
};
