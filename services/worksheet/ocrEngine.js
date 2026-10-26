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
  // One warm worker: each Tesseract WASM worker is ~200 MB and Render has 512 MB.
  if (workers.size >= 1) {
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
// reads only digits (lone "8"s in stacked fractions are otherwise missed).
async function ocrImage(imageBuffer, langs = ['eng'], { sparse = false, digits = false } = {}) {
  if (!isDecodableImage(imageBuffer)) throw new Error('OCR: input is not a decodable image');
  return serial(async () => {
    const worker = await getWorker(langs);
    await worker.setParameters({
      tessedit_pageseg_mode: sparse ? '11' : '6', // 6 = the library default
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

module.exports = {
  ocrImage, detectScript, terminateWorkers, scriptsInText, scriptsFromHints, langsForScripts,
  isDecodableImage, SCRIPT_TO_LANGS,
};
