// ── Core Gemini vision quiz generation ───────────────────────────────────
// Increment 1 of the worksheet AI-extraction pipeline migration (see
// QUIZ_PIPELINE_MIGRATION.md) — ported from ai-mentor/server/routes/quiz.js
// (2026-09-11). Deliberately minimal: single image in, quiz JSON out, no
// OCR cross-validation, no diagram matching, no answer-verification pass,
// no multi-vendor fallback chain yet — each is a separate, explicitly
// tracked increment, not a permanent omission.
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Comma-separated, tried in order: newer Google projects can't use gemini-2.5-flash,
// and single models are often "high demand" (503) on the free tier.
const GEMINI_MODELS = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').split(',').map(m => m.trim()).filter(Boolean);

// Same shape as a Gemini model; an overloaded or retired model moves on to the next instead of waiting.
function geminiModel(generationConfig) {
  return {
    async generateContent(content) {
      let lastErr;
      for (const name of GEMINI_MODELS) {
        try {
          return await genAI.getGenerativeModel({ model: name, generationConfig }).generateContent(content);
        } catch (e) {
          lastErr = e;
          // Free-tier quota is per model, so a 429 on one model is worth trying the next.
          if (!/503|overloaded|unavailable|high demand|404|no longer available|not found|429|too many requests|quota|rate.?limit|resource_exhausted/i.test(String((e && e.message) || e))) throw e;
          console.log(`[gemini] ${name} unavailable, trying next model`);
        }
      }
      throw lastErr;
    },
  };
}
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ── PDF embedded-image extraction — NO AI vision required ────────────────
// Added 2026-09-12 (Phase 3): a PDF's raster images are stored as regular
// Image XObjects in its object tree - the exact same asset the page
// visually shows, extractable directly via pdf-lib's low-level API. This
// preserves real diagrams/photos in a PDF worksheet even with ZERO vision
// model available (verified live: Gemini unfunded, Qwen quota-depleted,
// Mistral rate-limited) - AI vision is only needed to UNDERSTAND/ASSOCIATE
// a diagram with a specific question, not to physically preserve the
// image asset itself. Verified against a real Puppeteer-generated PDF:
// correctly found the embedded Image XObject, its exact dict metadata
// (Width/Height/ColorSpace/BitsPerComponent/Filter), and reconstructed
// valid pixel data via zlib inflation (FlateDecode) or direct passthrough
// (DCTDecode is already a valid JPEG file, no reconstruction needed).
// Filters this doesn't handle (JPXDecode/JBIG2/CCITTFax - rare in
// consumer-tool-generated PDFs) are skipped per-image, non-fatally.
//
// 2026-10-13: pdfjs is now tried first. Image-heavy IB worksheets are often
// encrypted (permissions-only), keep images inside Form XObjects, or use PNG
// predictors / SMask alpha / ICC colour — pdf-lib can't walk those (it threw
// on the page tree, so NO images survived) while pdfjs decodes every one.
// pdf-lib stays as the fallback if pdfjs itself fails.
async function extractPdfEmbeddedImages(pdfBuffer, opts = {}) {
  try {
    return await extractPdfImagesWithPdfjs(pdfBuffer, opts);
  } catch {
    return extractPdfImagesWithPdfLib(pdfBuffer, opts);
  }
}

const PDFJS_MAX_IMAGES = 40;
const PDFJS_MAX_SIDE = 1600; // downscale huge scans so hosted crops stay light
const FULL_PAGE_AREA = 0.8; // an image covering most of a page is a scan/background, not a diagram

function pdfjsImageToRgba(img, pdfjs) {
  const { width, height, kind, data } = img;
  const out = Buffer.alloc(width * height * 4);
  if (kind === pdfjs.ImageKind.RGBA_32BPP) return Buffer.from(data.buffer, data.byteOffset, width * height * 4);
  if (kind === pdfjs.ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }
  if (kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return out;
  }
  return null;
}

async function extractPdfImagesWithPdfjs(pdfBuffer, { minDimension = 40, maxImages = PDFJS_MAX_IMAGES } = {}) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const { Jimp } = require('jimp');
  const crypto = require('crypto');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    }).promise;
  } catch (err) {
    if (err && /Invalid PDF|password/i.test(String(err.message || err.name))) return []; // not a PDF - nothing to extract
    throw err;
  }
  const images = [];
  const seen = new Set();
  try {
    for (let p = 1; p <= doc.numPages && images.length < maxImages; p++) {
      const page = await doc.getPage(p);
      const [x0, y0, x1, y1] = page.view;
      const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
      const ops = await page.getOperatorList();
      // Track the CTM so a full-page scan/background can be told apart from a diagram.
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const mul = (m, n) => [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
      ];
      for (let i = 0; i < ops.fnArray.length && images.length < maxImages; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === pdfjs.OPS.save) { stack.push(ctm); continue; }
        if (fn === pdfjs.OPS.restore) { ctm = stack.pop() || ctm; continue; }
        if (fn === pdfjs.OPS.transform) { ctm = mul(ctm, args); continue; }
        if (fn === pdfjs.OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args[0])) ctm = mul(ctm, args[0]); continue; }
        if (fn === pdfjs.OPS.paintFormXObjectEnd) { ctm = stack.pop() || ctm; continue; }
        if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintImageXObjectRepeat) continue;
        try {
          const objId = args[0];
          const store = objId.startsWith('g_') ? page.commonObjs : page.objs;
          const img = await new Promise((resolve) => store.get(objId, resolve));
          if (!img || !img.data || img.width < minDimension || img.height < minDimension) continue;
          const drawnArea = Math.hypot(ctm[0], ctm[1]) * Math.hypot(ctm[2], ctm[3]);
          if (drawnArea / pageArea > FULL_PAGE_AREA) continue;
          const rgba = pdfjsImageToRgba(img, pdfjs);
          if (!rgba) continue;
          const hash = crypto.createHash('sha1').update(rgba).digest('hex');
          if (seen.has(hash)) continue; // same logo/picture repeated on every page
          seen.add(hash);
          const jimg = new Jimp({ data: rgba, width: img.width, height: img.height });
          if (Math.max(img.width, img.height) > PDFJS_MAX_SIDE) jimg.scaleToFit({ w: PDFJS_MAX_SIDE, h: PDFJS_MAX_SIDE });
          const buffer = await jimg.getBuffer('image/png');
          images.push({ buffer, mime: 'image/png', width: jimg.bitmap.width, height: jimg.bitmap.height, page: p });
        } catch { /* one bad image must not abort the rest */ }
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return images;
}

async function extractPdfImagesWithPdfLib(pdfBuffer, { minDimension = 40 } = {}) {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const zlib = require('zlib');
  const images = [];
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch {
    return images; // not a valid/parseable PDF - nothing to extract, non-fatal
  }
  let pages;
  try { pages = pdfDoc.getPages(); } catch { return images; } // broken/encrypted page tree
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    let xobjects;
    try {
      const resources = pages[pageIndex].node.Resources();
      const xobjectsRef = resources && resources.get(PDFName.of('XObject'));
      if (!xobjectsRef) continue;
      xobjects = pdfDoc.context.lookup(xobjectsRef);
    } catch { continue; }
    for (const key of xobjects.keys()) {
      try {
        const stream = pdfDoc.context.lookup(xobjects.get(key));
        const dict = stream.dict;
        if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
        const width = dict.get(PDFName.of('Width'))?.asNumber?.() ?? 0;
        const height = dict.get(PDFName.of('Height'))?.asNumber?.() ?? 0;
        if (width < minDimension || height < minDimension) continue; // skip tiny decorative/icon-sized images
        const filterEntry = dict.get(PDFName.of('Filter'));
        const filter = filterEntry ? filterEntry.toString() : '';
        const raw = Buffer.from(stream.contents);

        if (filter.includes('DCTDecode')) {
          // Already a complete, valid JPEG byte stream - no reconstruction needed.
          images.push({ buffer: raw, mime: 'image/jpeg', width, height, page: pageIndex + 1 });
          continue;
        }
        if (filter.includes('FlateDecode') || !filter) {
          const bpc = dict.get(PDFName.of('BitsPerComponent'))?.asNumber?.() ?? 8;
          if (bpc !== 8) continue; // only the common 8-bit-per-channel case is handled
          const csEntry = dict.get(PDFName.of('ColorSpace'));
          const csStr = csEntry ? csEntry.toString() : '';
          // DeviceGray=1 component, DeviceRGB or an ICCBased profile (near-
          // universally 3-component RGB in real-world tool output)=3,
          // DeviceCMYK=4. Anything else is skipped rather than guessed.
          const components = csStr.includes('Gray') ? 1 : csStr.includes('CMYK') ? 4 : 3;
          let pixels;
          try {
            pixels = filter.includes('FlateDecode') ? zlib.inflateSync(raw) : raw;
          } catch { continue; }
          if (pixels.length < width * height * components) continue; // corrupt/truncated - skip, don't guess
          const { Jimp } = require('jimp');
          const img = new Jimp({ width, height, color: 0x000000ff });
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const srcOffset = (y * width + x) * components;
              const r = pixels[srcOffset];
              const g = components >= 3 ? pixels[srcOffset + 1] : r;
              const b = components >= 3 ? pixels[srcOffset + 2] : r;
              img.setPixelColor(((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0, x, y);
            }
          }
          const buffer = await img.getBuffer('image/png');
          images.push({ buffer, mime: 'image/png', width, height, page: pageIndex + 1 });
          continue;
        }
        // JPXDecode (JPEG2000), CCITTFaxDecode, JBIG2Decode - not reconstructed.
      } catch { /* one bad image object must not abort the rest of the page/document */ }
    }
  }
  return images;
}

// Uploads extracted PDF images to Cloudinary, returning the same shape
// hostEmbeddedImages (routes/assignments.js) uses for docx images - a
// deliberately shared, simple {url} shape so both paths can feed the same
// downstream marker/instruction format. Non-fatal per image, same pattern
// as hostEmbeddedImages: a failed upload just means that image is skipped,
// not that the whole extraction fails.
async function hostExtractedImages(images) {
  const cloudinary = require('cloudinary').v2;
  if (!cloudinary.config().cloud_name) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  const hosted = [];
  for (const img of images) {
    try {
      const dataUri = `data:${img.mime};base64,${img.buffer.toString('base64')}`;
      const result = await cloudinary.uploader.upload(dataUri, {
        folder: 'ai_mentor/worksheet_images',
        public_id: `pdf_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        resource_type: 'image',
      });
      hosted.push({ url: result.secure_url, page: img.page });
    } catch { /* skip this one image, non-fatal */ }
  }
  return hosted;
}

// Converts mammoth's docx→HTML output into plain text that preserves
// table structure explicitly. Added 2026-09-12 after a real teacher's
// worksheet (see QUIZ_PIPELINE_MIGRATION.md) showed the AI fabricating
// completely different fraction values than a source table actually
// contained (e.g. generated "24/36, 45/60..." when the source table had
// "28/50, 8/24, 30/54..."). Root cause: docx uploads get flattened to a
// PDF and re-read via vision/OCR, discarding mammoth's already-exact
// table-cell text and forcing a much less reliable re-guess of numbers
// from a rendered image. This function recovers that ground truth so it
// can be handed to the generation step directly instead of being thrown
// away - table rows are marked explicitly so the model doesn't have to
// visually infer row/column structure at all, just copy verbatim values.
function htmlToStructuredText(html) {
  let text = String(html || '');
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableHtml) => {
    const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(rowMatch => {
      const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cellMatch =>
        cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      );
      return cells.join(' | ');
    });
    return `\n[TABLE - EXACT VALUES, DO NOT ALTER]\n${rows.join('\n')}\n[/TABLE]\n`;
  });
  // Image markers, added 2026-09-12 (Phase 2 - image/diagram preservation):
  // if the <img> tag's src is a real hosted URL (docxToPdf uploads mammoth's
  // embedded images to Cloudinary before calling this function - see
  // hostEmbeddedImages in routes/assignments.js), include it explicitly so
  // the generation prompt can attach the REAL source image to the nearest
  // question/task instead of trying to describe or redraw it. A src that's
  // still a data: URI (upload failed, or this HTML wasn't pre-processed)
  // falls back to a bare marker - the image's presence is still noted, just
  // without a usable URL.
  text = text.replace(/<img[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/gi, (_, url) => `\n[IMAGE: url=${url}]\n`);
  text = text.replace(/<img[^>]*>/gi, '\n[IMAGE]\n');
  text = text.replace(/<\/(p|h[1-6]|li|div)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

const GEMINI_VISION_TIMEOUT_MS = parseInt(process.env.GEMINI_VISION_TIMEOUT_MS || '75000', 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT:${label}:${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Retry wrapper: exponential backoff on Gemini 429 (rate limit) / 503 (overloaded).
async function geminiRetry(fn, { tries = 6, base = 2500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const is429 = /429|too many requests|quota|resource_exhausted|rate.?limit/i.test(msg);
      const is503 = /503|overloaded|unavailable/i.test(msg);
      lastErr = e;
      // A permanent-billing 429 (daily quota, OR the account itself has no
      // funds/credits left) can't recover by waiting — retrying just holds
      // the request open until a proxy timeout kills it instead of returning
      // a real error. Verified live: a "prepayment credits are depleted" 429
      // isn't a daily-quota message but is exactly as unrecoverable, and the
      // narrower daily-only check let it retry for ~88s before failing.
      if (is429 && /PerDay|per.?day|daily|prepayment|credits?\s+(are\s+)?depleted|billing|insufficient.?(funds|balance)/i.test(msg)) throw e;
      if ((!is429 && !is503) || i === tries - 1) throw e;
      const suggested = msg.match(/retry.?after[^\d]*(\d+)/i) || msg.match(/retryDelay["\s:]+(\d+)/i);
      const wait = suggested ? parseInt(suggested[1], 10) * 1000
        : base * Math.pow(2, i) + Math.floor(Math.random() * 600);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function geminiGenerate(model, content) {
  const result = await geminiRetry(() => model.generateContent(content));
  return result.response.text();
}

function geminiImageParts(imageBuffers) {
  return imageBuffers.map(({ buffer, mime }) => ({
    inlineData: { mimeType: mime || 'image/png', data: buffer.toString('base64') },
  }));
}

// Gemini 2.5 Flash reads PDFs natively (multi-page) via inlineData, same as
// an image part. High-DPI per-page rasterization (what the monolith does as
// an accuracy enhancement on top of this) is a separate, later increment —
// sending the raw PDF directly is what the monolith itself falls back to
// when rasterization isn't available, so this is a real, working path, not
// a stub.
function geminiPdfPart(pdfBuffer) {
  return { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } };
}

function buildQuizVisionPrompt({ grade, subject, school } = {}) {
  return `You are an expert quiz generator for ${grade || 'IB PYP Grade 4'} ${subject || 'Mathematics'}.

STEP 1: CAREFULLY examine the worksheet image(s). Read EVERY number, word, symbol, shape, table, and layout element.

⚠️ ACCURACY IS THE #1 PRIORITY. NEVER guess, approximate, or invent a number. Every number in your output MUST be a number you can actually SEE printed on the worksheet. If you output a problem like "100 + 233" when the worksheet actually shows "326 + 419", that is a CRITICAL FAILURE. Read each digit individually.

⚠️ VERTICAL / COLUMN ARITHMETIC (READ THIS CAREFULLY — this is where most mistakes happen):
Many math worksheets show addition/subtraction as a VERTICAL STACK, not inline. For example:
     326                317
   + 419              - 258
   ─────              ─────
This means "326 + 419" and "317 - 258". To read a vertical stack correctly:
  1. Read the TOP number completely, digit by digit, left to right (e.g. 3-2-6 = 326).
  2. Read the operator on the left (+ or −).
  3. Read the BOTTOM number completely, digit by digit (e.g. 4-1-9 = 419).
  4. The problem is "TOP operator BOTTOM" (e.g. "326 + 419").
Do NOT swap digits, drop digits, or invent a smaller/rounder number. "628" is NOT "68" or "600". Read all THREE digits. If the worksheet has 9 stacked problems, you MUST output those 9 problems with their EXACT numbers — count them and match.

STEP 2: For each task/section in the worksheet, extract:
- The exact title/heading
- Every single question with exact numbers
- Any diagrams, tables, or visual elements
- The operation being performed (+, -, ×, ÷)

STEP 3: Generate quiz JSON that is a PERFECT REPLICA of the worksheet.

RULES:
1. Each Task from the worksheet = one task in JSON. Keep EXACT task title and instructions.
2. Label questions EXACTLY as worksheet does (a, b, c, d, e — NOT q1, q2).
2b. NEVER collapse multiple numbered/lettered items under one instruction into a single
    question. If one instruction covers several sentences/blanks/rows (e.g. "d1) ... d2) ...
    d3) ... d4) ..." or 4 separate sentences each needing its own circled word and blank),
    emit ONE question per item, each with its own id (d1, d2, d3, d4) and its own answer/
    hint/solution — never merge them into a single answer field. Count the actual items in
    the worksheet and make sure your output has that same count of questions for that task.
3. Use the EXACT SAME NUMBERS from the worksheet. Do NOT substitute different numbers.
4. Every question MUST have a correct "answer" field. YOU MUST SOLVE each problem. Think step by step, compute the answer, and write the final result. NEVER write "Not provided in the text" or "N/A" — you are the solver, not just an extractor.
4b. Keep "answer" SHORT — the literal, direct response a student would type in the blank (e.g. "football", "12 cm", "rugby and badminton"). NEVER pack your full working/narrative into "answer" (e.g. do NOT write "20, closer to football" or "Current votes for rugby = 10, so doubled = 20..." as the answer) — that full reasoning belongs ONLY in "solution". A bloated "answer" field makes correct short student responses get marked wrong.
5. Pay careful attention to UNITS.
6. Every question MUST have a "solution" field with a clear step-by-step explanation. NEVER write "Not provided" — work through the problem and explain how to get the answer.
7. Every question MUST have a "hint" field — a short clue that guides the student without giving the full answer. NEVER leave hint empty or omit it.
8. DIAGRAM/IMAGE HANDLING (CRITICAL — read carefully):
   a) If MULTIPLE questions in a task ALL reference the SAME shared diagram/picture (e.g. a picture of objects where Q1-Q4 all ask about the same picture, or a set of weighing scales where all questions refer to the same image), then:
      - Set "sharedImage": true on the TASK object (not on individual questions)
      - Set "sharedImageDescription": description of the shared diagram
      - Set "sharedImagePosition": position on the page ("top-center", "middle-center", etc.)
      - Set "hasImage": false on ALL individual questions (the image belongs to the task, not to any single question)
      Example: A picture showing a book, bench, and foot — with Q1 "The book is ___ foot", Q2 "The bench is ___ feet", Q3 "The book is ___ than the bench" — ALL reference the SAME picture. Use sharedImage on the task.
   b) If a question has its OWN UNIQUE diagram that no other question uses, set "hasImage": true on that question with:
      - "diagramDescription": short description (e.g. "L-shaped polygon with sides 5m, 6m, 8m, 3m")
      - "diagramPosition": approximate position on the page: "top-left", "top-right", "top-center", "middle-left", "middle-right", "middle-center", "bottom-left", "bottom-right", "bottom-center"
   c) For text-only questions with no diagram, set "hasImage": false.
   These fields are used by the server to match cropped images to the correct questions. Getting this wrong causes images to appear on the wrong questions.
   d) If a task/section has an ILLUSTRATION or DECORATIVE IMAGE (e.g. a cartoon character, animal picture, beehive, tree diagram, branching arrows) that provides context but is not a per-question diagram, treat it as a sharedImage on the task:
      - Set "sharedImage": true, "sharedImageDescription": description, "sharedImagePosition": position
      This ensures ALL visual elements from the worksheet are preserved, not just math diagrams.
   e) ⚠️ TRANSCRIBE DATA THAT LIVES INSIDE A PICTURE INTO THE QUESTION TEXT. If the numbers, digits,
      letters, or values a student needs to answer are printed INSIDE an image (e.g. digit/number
      cards "3 5 2 4 1 0", a set of number tiles, dominoes, dice faces, price tags, a clock face),
      you MUST copy those exact values into the "question" text (e.g. "Using the digits 3, 5, 2, 4,
      1, 0 (each once), make two 3-digit numbers…"). The picture may not always render, so the
      question must be fully answerable from its text ALONE. Still set "hasImage"/"sharedImage" so
      the picture is also preserved — but NEVER leave the essential values only inside the image.
9. Do NOT generate SVG, HTML diagrams, or diagramHTML. The server handles all image rendering separately.
10. For questions that reference a graph/chart/image: READ the visual data from the image to compute the answer. For example, if a bar graph shows football=16, tennis=8 and the Y-axis goes 0,2,4,6... then the scale is 2.
11. MATCH-THE-FOLLOWING TASKS (e.g. "match the word to the picture", "match the following", "జతపరచండి"): emit ONE question per item to match. Set "type": "mcq" and "options": an array of ALL candidate words/phrases from the matching column (the full pool — the SAME list for every question in that task, in a different order per question), and "answer": the correct word for that item. Do NOT emit matching items as free-text fill-in questions — the student must pick from the pool, not type it.
12. COUNT THE ANSWER SPACES. If a task provides N blank lines / boxes / spaces for the student to write answers (e.g. 6 blank lines next to a letters table), generate EXACTLY N questions — one per blank line. Count the physical blank lines in the image before writing the questions. Never collapse them into fewer questions.
13. PRESERVE CONTENT THAT ISN'T A QUESTION (CRITICAL — do not silently drop this). A worksheet is the sole source of truth: extract exactly what is printed, verbatim, in every one of the following fields when present. Never invent content for a field that has nothing in the source — leave it as an empty string/array instead.
   a) WORD BANK: if the worksheet provides a labeled list of words/terms for students to choose from (e.g. "Word Bank", "Vocabulary", "Word List" — often used across MULTIPLE tasks, not just one), copy EVERY word verbatim, in the same order, into a top-level "wordBank" array. Do not omit any word, and do not add words that aren't printed.
   b) PASSAGE / CONTEXT TEXT: if a task includes a paragraph, story, or block of body text that the student must read BEFORE answering (not the task's one-line instruction, but real prose content), copy it verbatim into a "passage" field on that task. Preserve it EXACTLY as printed, including any words that are intentionally wrong/misused as part of the exercise (e.g. an "identify the errors" activity) — do NOT correct, paraphrase, or summarize it.
   c) WORKED EXAMPLE: if a task shows a worked example or model answer before the student's own response area (e.g. "Example: ..."), copy it verbatim into an "example" field on that task.
   d) LOOKUP / CORRECTION TABLES: if the worksheet has an actual 2+ column table where one column is a fixed value and another is left blank for the student to fill in (e.g. "Incorrect Word | Correct Word"), represent it as a "table" object on the task: { "headers": ["Incorrect Word", "Correct Word"], "rows": [ [ {"text": "buyer"}, {"input": true, "answer": "market"} ], ... ] }. Do NOT split each row into a separate free-standing question — the table IS the structure, keep it as one.
   e) CHECKLIST: if the document contains a self-assessment/reflection checklist (commonly "I can..." statements, sometimes with checkbox marks), copy every criterion verbatim, in order, into a top-level "checklist" array of strings.
   f) CREDITS: if the document contains a credits/attribution/author line (e.g. "Credits: ...", a team or author name at the bottom), copy it verbatim into a top-level "credits" string.
   g) If uncertain whether something qualifies for one of the fields above, prefer including it over dropping it — losing real content is worse than an over-inclusive extraction.

14. LANGUAGE (CRITICAL for language worksheets — Telugu, Hindi, Tamil, French, ...): keep every question, passage, option and answer in the SAME language and script as the worksheet. Never translate the worksheet's content into English and never transliterate it into Latin letters. An English gloss may be added after the original instruction in a task title, but questions and answers stay in the original script. "answer" must be written exactly as a student is expected to write it, in that script (e.g. "గద్ద గాలిలో ఎగురుతుంది"), and for questions with more than one acceptable wording add "acceptableAnswers": ["...", "..."]. Set top-level "language" to the worksheet's language name (e.g. "Telugu"; "English" for English worksheets).
15. NEVER LEAVE A REAL QUESTION WITHOUT AN ANSWER KEY. Fill-in-the-blank, rewrite-the-sentence, find-the-word and comprehension questions ALL have a definite answer you can derive from the worksheet (the passage, the sentences, the word list) — write it. Only genuinely personal/creative prompts (draw, "write about your holiday", opinions) may omit "answer"; mark those "type": "long".

LAYOUT EXTRACTION (CRITICAL — replicate the worksheet's visual layout):
- Look at how questions are arranged: single column, two columns side-by-side, grid, etc.
- For each task, include a "layout" object describing the visual arrangement.
- "layout.type": "single-column" (one column of questions), "two-column" (two side-by-side columns like conversion tables), "grid" (grid of cells), "list" (numbered list)
- "layout.columns": number of columns (1 or 2 typically)
- "layout.columnGroups": array of column groups, each with "questionIds" listing which questions belong to that column (in order, top to bottom)
- If a column group has a diagram/image above its questions, set "hasDiagram": true on that group
- Questions in column 0 are LEFT side, column 1 are RIGHT side
- CRITICAL ID RULE: Every question in a task MUST have a globally unique "id" (e.g. "a", "b", "c", "d", "e" for the left column, and "f", "g", "h", "i", "j" for the right column). Never reuse the same "id" within a task, even if the worksheet repeats question labels (like two columns both labeled 'a', 'b', 'c'). This "id" is an INTERNAL identifier only (used for layout/image matching) — it is never shown to the student as a question number, so it does not need to match the worksheet's own numbering style.

METADATA RULE (CRITICAL): "${subject || 'Mathematics'}" and "${grade || 'PYP 4'}" below are only FALLBACK context, used solely when the worksheet itself states nothing. ALWAYS check the worksheet FIRST for its own explicit subject/grade/class text (e.g. "Subject:", "Subject Focus:", "Grade:", "Class:", "PYP:"). If the worksheet states its own subject/grade, YOU MUST use that EXACT text instead of the fallback below, even if it conflicts with the fallback context — the worksheet is authoritative, the fallback is only a guess for when the worksheet is silent on the matter.

Return this EXACT JSON structure:
{
  "title": "worksheet title",
  "subject": "${subject || 'Mathematics'}",
  "grade": "${grade || 'PYP 4'}",
  "school": "${school || ''}",
  "language": "the worksheet's language, e.g. English / Telugu / Hindi",
  "purpose": "the Purpose/objective line stated on the worksheet, verbatim (empty string if none)",
  "learningOutcomes": ["each Learning Outcome bullet point, exactly as written on the worksheet"],
  "wordBank": ["each word from a printed Word Bank/Vocabulary List, verbatim, in order — empty array if none"],
  "checklist": ["each self-assessment/reflection checklist criterion, verbatim — empty array if none"],
  "credits": "credits/attribution line verbatim, e.g. 'Credits: PYP 4 Team' — empty string if none",
  "concepts": [{ "term": "name", "definition": "short child-friendly definition", "unit": "unit" }],
  "tasks": [
    {
      "tier": "<section label exactly as printed, e.g. 'Must Do' — or '' if none>",
      "title": "Task 1: exact title from worksheet",
      "sourcePage": 1,
      "passage": "verbatim body/context text the student must read before answering — omit this field entirely if the task has none",
      "example": "verbatim worked example shown before the student's own response — omit this field entirely if the task has none",
      "layout": {
        "type": "two-column",
        "columns": 2,
        "columnGroups": [
          { "hasDiagram": true, "questionIds": ["a","b","c","d","e"] },
          { "hasDiagram": true, "questionIds": ["f","g","h","i","j"] }
        ]
      },
      "questions": [
        { "id": "a", "type": "numeric", "question": "4 kg = ___ gm", "unit": "gm", "answer": 4000, "hint": "1 kg = 1000 gm", "solution": "4 × 1000 = 4000 gm", "hasImage": false },
        { "id": "f", "type": "numeric", "question": "5 l = ___ ml", "unit": "ml", "answer": 5000, "hint": "1 l = 1000 ml", "solution": "5 × 1000 = 5000 ml", "hasImage": false }
      ]
    },
    {
      "tier": "<this task's own section label, exactly as printed>",
      "title": "Task 3: Observe the picture and fill in the blanks",
      "sourcePage": 2,
      "sharedImage": true,
      "sharedImageDescription": "Picture showing a book, a bench, and a foot as measurement unit",
      "sharedImagePosition": "top-center",
      "layout": { "type": "single-column", "columns": 1 },
      "questions": [
        { "id": "a", "type": "numeric", "question": "The length of the book is ___ foot.", "unit": "foot", "answer": 1, "hasImage": false },
        { "id": "b", "type": "numeric", "question": "The length of the bench is ___ feet.", "unit": "feet", "answer": 4, "hasImage": false }
      ]
    },
    {
      "tier": "",
      "title": "Task 3: Error Detective Alert - Read & Detect Errors (EXAMPLE of a lookup/correction table - use 'table', not one question per row)",
      "sourcePage": 2,
      "passage": "the full passage text goes here verbatim, unchanged, even if it contains intentionally wrong words",
      "table": {
        "headers": ["Incorrect Word", "Correct Word"],
        "rows": [
          [ { "text": "buyer" }, { "input": true, "answer": "market" } ],
          [ { "text": "consumption" }, { "input": true, "answer": "production" } ]
        ]
      }
    }
  ]
}`;
}

// Ported verbatim from the monolith — strips markdown fences, slices to the
// outermost JSON object (fallback engines sometimes wrap the JSON in prose),
// quotes bare fraction answers, and strips // comments a model occasionally emits.
function cleanLLMJson(raw) {
  let s = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  s = s.replace(/"answer":\s*(\d+\/\d+)/g, '"answer": "$1"');
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    out += c;
  }
  return out;
}

// ── Provider-availability classification ──────────────────────────────────
// Added 2026-09-12 (Phase 2): the Qwen quota-depletion outage silently
// affected ordinary English worksheets for an unknown period before being
// noticed - it looked like "just another engine failure" in the logs,
// indistinguishable from a one-off network blip. This classifies a
// provider error into an explicit status so an outage is DIAGNOSABLE from
// logs going forward, not just "it failed, moved on." Intentionally
// simple (pattern-matching known error shapes from Gemini/Qwen/Mistral,
// not a generic provider-SDK abstraction) - a full provider-registry
// rearchitecture was judged out of scope for what this actually needs to
// solve: making the CLASS of failure visible, not building a plugin system.
const PROVIDER_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  AUTH_FAILURE: 'AUTH_FAILURE',
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',
  UNSUPPORTED: 'UNSUPPORTED',
  DISABLED: 'DISABLED',
});

function classifyProviderError(providerName, err) {
  const msg = String((err && err.message) || err || '');
  let status;
  if (/not configured/i.test(msg)) status = PROVIDER_STATUS.DISABLED;
  else if (/depleted|exhausted|quota|monthly included credits/i.test(msg)) status = PROVIDER_STATUS.QUOTA_EXHAUSTED;
  else if (/rate.?limit|429|too many requests/i.test(msg)) status = PROVIDER_STATUS.RATE_LIMITED;
  else if (/401|403|unauthorized|invalid.?api.?key|authentication/i.test(msg)) status = PROVIDER_STATUS.AUTH_FAILURE;
  else if (/503|overloaded|unavailable|ECONNRESET|ETIMEDOUT|timeout/i.test(msg)) status = PROVIDER_STATUS.TEMPORARY_FAILURE;
  else status = PROVIDER_STATUS.TEMPORARY_FAILURE; // unknown shape - treat as transient, not a hard outage, by default
  console.log(`[vision-provider] ${providerName}: ${status} - ${msg.slice(0, 200)}`);
  return status;
}

// ── Gemini Vision — primary engine (free, excellent accuracy) ────────────────
async function callGeminiVision(parts, { grade, subject, school, structuredText } = {}) {
  if (!genAI) throw new Error('GEMINI_API_KEY not configured');
  // temperature: 0 — a pure reading task, not a creative one; without this
  // Gemini defaults to ~1.0 and gives a different "guess" run to run.
  const model = geminiModel({ responseMimeType: 'application/json', temperature: 0 });
  let prompt = buildQuizVisionPrompt({ grade, subject, school });
  // Ground-truth supplement for docx-sourced uploads, added 2026-09-12: the
  // PDF Gemini sees here is a flattened RENDER of the original docx, so any
  // table/number in it still has to be visually re-read - exactly the step
  // that was found fabricating wrong fraction values on a real worksheet
  // (mammoth's own docx→HTML conversion gets these values with zero
  // ambiguity). Handing that exact text over as an explicit authority
  // doesn't change what Gemini is asked to produce, it just removes the
  // need to guess numbers it already has an exact source for.
  if (structuredText && structuredText.trim().length > 20) {
    prompt += `\n\nGROUND TRUTH TEXT (extracted with 100% accuracy from the original document, including exact table cell values marked with [TABLE]/[/TABLE]): use these EXACT values for any text/numbers/table cells - do NOT visually re-read or guess a number/word from the image if it's given here, even if the image is hard to read. The image is still your source for layout, diagrams, and anything not covered by this text.\n\n${structuredText.slice(0, 12000)}`;
  }
  return geminiGenerate(model, [...parts, { text: prompt }]);
}

// ── Qwen 2.5-VL-72B Vision (via HuggingFace router) — fallback when Gemini
// fails ─────────────────────────────────────────────────────────────────
// Live-verified 2026-09-11: this key/model responds successfully right now,
// unlike the only available Gemini key (depleted). Image-only for now (no
// PDF support — HF's chat-completions API takes image_url data URIs, not a
// native PDF part like Gemini's inlineData); PDF generation stays
// Gemini-only until page rasterization is added (see
// QUIZ_PIPELINE_MIGRATION.md).
const HF_TOKEN = process.env.HF_TOKEN;
const QWEN_VISION_MODEL = 'Qwen/Qwen2.5-VL-72B-Instruct';

// Generic Qwen vision call with an arbitrary prompt — used both by
// callQwenVision (quiz-generation prompt) and by other vision fallbacks
// (e.g. worksheet metadata/text extraction) that need their own prompt.
async function callQwenVisionRaw(imageBuffer, mime, prompt) {
  if (!HF_TOKEN) throw new Error('HF_TOKEN not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: QWEN_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${imageBuffer.toString('base64')}` } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: 8192,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HF router ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callQwenVision(imageBuffer, mime, { grade, subject, school } = {}) {
  const prompt = buildQuizVisionPrompt({ grade, subject, school });
  return callQwenVisionRaw(imageBuffer, mime, prompt);
}

function parseQuizResponse(raw) {
  try {
    return JSON.parse(cleanLLMJson(raw));
  } catch {
    const err = new Error('AI returned invalid JSON');
    err.raw = raw;
    throw err;
  }
}

// ── Deterministic visual-grounding enforcement ────────────────────────────
// Added 2026-09-13 after a live production test caught real hallucination:
// a text-only fallback (no vision provider available) answered "What
// colors do you see?" with a confident but WRONG guess ("red, blue,
// yellow" - the real image also had green) for a question it fundamentally
// could not see. This happened even though the SAME fallback correctly
// declined (answer: null) on a diagram-dependent math question in a
// different worksheet the same day - the model's own judgment about when
// to decline is not reliable enough on its own, especially for open-ended
// "describe what you see" phrasing that gives it just enough of a hint to
// fabricate a plausible-sounding list. Per explicit instruction: this must
// be enforced at the pipeline/data-validation layer, not by prompt wording
// alone (prompt wording is what failed here in the first place).
//
// Rule, applied only when visualUnderstandingAvailable is false (no vision
// provider was actually used for this generation):
//   - A question is "visual-dependent" if it's flagged hasImage/sharedImage,
//     OR its own text matches a visual-reference pattern ("what do you
//     see", "look at the picture/diagram/photo", "name this shape/object",
//     "identify the...", etc.) - covers cases where the model didn't set
//     the flag but the question itself is unambiguously about an image.
//   - A visual-dependent question's answer is trusted ONLY if it's
//     independently grounded in the actual extracted source text (i.e. the
//     answer's own words/numbers genuinely appear in what was extracted -
//     e.g. the L-shaped-polygon case, where 6m/8m/3m are printed as real
//     text labels next to the diagram, not only visible in the graphic).
//   - Otherwise, the answer/solution are overridden to an explicit,
//     honest "visual understanding unavailable" state - never left as
//     the model's ungrounded guess.
const VISUAL_DEPENDENCY_PATTERN = /what (do|colou?rs?|shapes?|animals?|objects?) (do |can )?you see|look at the (picture|image|diagram|photo|graph|chart|map|figure)|describe the (picture|image|diagram|photo|scene)|name (the|this) (shape|object|animal|picture|figure)|identify the|in the (picture|image|diagram|photo)|based on the (picture|image|diagram|photo|graph|chart)/i;

function isVisuallyDependentQuestion(question, task) {
  return !!(question.hasImage || task.sharedImage || VISUAL_DEPENDENCY_PATTERN.test(question.question || ''));
}

// A deliberately simple, deterministic substring-overlap check - NOT an
// AI call (that would just move the reliability problem, not solve it).
// "Grounded" means: at least one non-trivial token from the model's
// answer also appears literally in the extracted source text. This is
// permissive by design (a false negative here just means a genuinely
// text-derivable answer gets needlessly hidden, which is the SAFE
// direction to err in - never the reverse).
// Checks BOTH the answer and the solution against the source text -
// checking the answer alone would wrongly reject a legitimately COMPUTED
// answer (e.g. "28" as the sum of printed side lengths 6+8+3+... is
// correct math, but "28" itself is never printed anywhere in the source;
// only its inputs are). A real caught regression during testing: the
// L-shaped-polygon perimeter case (grounded, correct, printed measurements)
// was being wrongly nulled until this was fixed to also check the
// solution text, which restates the actual given numbers used.
// Found via a blind unseen-document test (2026-09-14, a Computer Science
// worksheet never used to develop this code): a diagram literally showing
// "PC A -- Router -- PC B" was answered "switch" - wrong, but plausible-
// sounding, because "switch" is a real word from an EARLIER, unrelated
// section of the same document (a term-matching table) and the original
// word-token-overlap check accepted ANY match anywhere in the source text
// as proof of grounding. Common vocabulary re-used across different parts
// of one document (here, "router"/"switch"/"modem" all appear multiple
// times for different purposes) makes word-overlap alone unsafe evidence
// for a visually-dependent question - a specific NUMBER (a measurement,
// a count) is a much rarer, more reliable coincidence-resistant signal
// than a common noun. word-token grounding is now used ONLY as a second-
// tier signal alongside a length floor to reduce trivial-word false
// positives; numeric grounding (via the solution's own cited numbers,
// the L-shaped-polygon-perimeter case) remains the strongest signal and
// is checked first.
function isAnswerGroundedInSource(answer, solution, sourceText) {
  if (answer === null || answer === undefined || answer === '') return false;
  const haystack = String(sourceText || '').toLowerCase();
  if (!haystack) return false;
  // NUMERIC evidence only (a measurement/count actually cited in the
  // solution's working, e.g. the L-shaped-polygon-perimeter case: 6/8/3
  // printed near the diagram). Word/phrase matching was tried and
  // REMOVED after a blind unseen-document test caught it failing: a real
  // diagram showed "PC A -- Router -- PC B", but the system confidently
  // answered "switch" - wrong, yet "grounded" by this check, because
  // "switch" is a real word from an EARLIER, unrelated part of the same
  // document (a term-matching table). Common vocabulary reused across
  // different sections of one document makes ANY word/phrase-overlap
  // check unsafe evidence for a visually-dependent question - a specific
  // number is a much rarer, more coincidence-resistant signal than a
  // common noun, so it's the only evidence trusted here. This is
  // deliberately conservative: some genuinely-answerable text-labeled
  // visual questions will now be declined that a smarter check might
  // have allowed - an acceptable tradeoff against confidently answering
  // wrong, per the explicit "never guess" requirement.
  const solutionNumbers = String(solution || '').match(/\d+(\.\d+)?/g) || [];
  return solutionNumbers.length > 0 && solutionNumbers.some(n => haystack.includes(n.toLowerCase()));
}

const VISUAL_UNAVAILABLE_MESSAGE = 'Visual understanding unavailable — this question requires the worksheet image/diagram, which could not be analyzed without a working vision-capable AI provider.';

function enforceVisualGrounding(quiz, { visualUnderstandingAvailable, sourceText }) {
  if (visualUnderstandingAvailable) return quiz; // a real vision provider actually looked at the image - trust it
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) {
      if (!isVisuallyDependentQuestion(q, task)) continue;
      if (isAnswerGroundedInSource(q.answer, q.solution, sourceText)) continue; // genuinely derivable from real text, e.g. printed measurements
      q.answer = null;
      q.solution = VISUAL_UNAVAILABLE_MESSAGE;
      q.hint = q.hint || 'Look at the image in the original worksheet to answer this question.';
      q.visualUnderstandingRequired = true;
    }
  }
  return quiz;
}

// ── Language-agnostic text-content grounding (Task 3: source grounding) ──
// Added 2026-09-14 after a live determinism run on the real Telugu
// worksheet surfaced a DIFFERENT fabrication mode than the visual-
// grounding case above: the source text for a "rewrite these given
// sentences" task contains ONLY the instruction line (the actual example
// sentences exist only as blank handwriting lines/graphics, unreadable by
// text-only extraction) - and the model, given no example content to
// reference, invented entirely new Telugu sentences wholesale rather than
// declining. enforceVisualGrounding did NOT catch this: the question
// isn't flagged hasImage/sharedImage, and VISUAL_DEPENDENCY_PATTERN is
// English-only phrasing, so it silently misses non-English worksheets -
// exactly the "do not create a Telugu-only special case, but Telugu/
// Indic text needs particular attention" requirement. This check is
// fully language-agnostic (Unicode-property tokenization, not keyword
// matching): if NONE of a task's question content (beyond its own title's
// vocabulary) appears anywhere in the real extracted source text, the
// content is likely invented rather than derived. Deliberately NON-
// destructive (unlike enforceVisualGrounding's null-and-decline) - fully
// suppressing fabricated-but-plausible practice content would make many
// legitimate worksheets unusable, since some pedagogically-valid
// generation (e.g. new practice problems following a given pattern) can
// legitimately share no literal tokens with the source. Instead it
// surfaces an explicit, honest flag for teacher review before publishing,
// satisfying "if source content is blank, do not invent educational
// content [silently]" without being destructively aggressive.
function extractContentTokens(text) {
  // \p{M} (combining marks) is required alongside \p{L} for scripts like
  // Telugu/Devanagari, where vowel signs and virama are separate
  // combining-mark codepoints, not letters - without it, words split into
  // meaningless fragments at every combining-mark boundary (caught live
  // while writing this: "మారము" split into "రమ" instead of staying whole).
  return String(text || '').match(/[\p{L}\p{M}\p{N}]{2,}/gu) || [];
}

const CONTENT_GROUNDING_NOTE = 'The specific examples in this task could not be verified against the extracted worksheet text and may not match the original source exactly — please review before publishing.';

function flagUngroundedTaskContent(quiz, { visualUnderstandingAvailable, sourceText }) {
  if (visualUnderstandingAvailable) return quiz; // a real vision provider saw the actual page - trust it
  const haystack = String(sourceText || '');
  if (!haystack) return quiz;
  for (const task of quiz.tasks || []) {
    const titleTokens = new Set(extractContentTokens(task.title));
    const questionTokens = [];
    for (const q of task.questions || []) {
      if (q.visualUnderstandingRequired) continue; // already handled by enforceVisualGrounding above
      for (const tok of extractContentTokens(q.question)) {
        if (!titleTokens.has(tok)) questionTokens.push(tok);
      }
    }
    if (questionTokens.length === 0) continue;
    const grounded = questionTokens.some(tok => haystack.includes(tok));
    if (!grounded) {
      task.contentGroundingUncertain = true;
      task.contentGroundingNote = CONTENT_GROUNDING_NOTE;
    }
  }
  return quiz;
}

// Unified, deterministic top-level signal for "was there actually enough
// source content to generate real questions" - added 2026-09-13 after
// live testing found the SAME real, content-sparse worksheet producing
// three different structural outcomes across repeated identical runs
// (valid tasks:[], 4 tasks with 0 questions each, and an outright
// json_validate_failed API rejection normalized by callGroqWithText
// above). The exact WORDING/shape of "not enough content" can still vary
// (that's acceptable LLM variability), but callers must be able to rely
// on ONE explicit field rather than having to guess from tasks.length,
// per-task question counts, or the presence of a thrown error.
function computeExtractionStatus(quiz) {
  if (quiz.extractionStatus === 'insufficient_source_content') return quiz.extractionStatus; // already set by callGroqWithText's own normalization
  const tasks = quiz.tasks || [];
  if (tasks.length === 0) return 'insufficient_source_content';
  const allTasksEmpty = tasks.every(t => !taskHasRealContent(t));
  return allTasksEmpty ? 'insufficient_source_content' : 'ok';
}

// ── Interaction-shape validation ─────────────────────────────────────────
// Added 2026-09-14: checks a generated question's shape against what
// quizHtmlRenderer.js actually requires to render it - read directly from
// that file's own logic (autoDetectMCQ, the mcq/matching branches), not
// assumed. A question that LOOKS present (has "question" text, isn't
// empty) can still be unrenderable - an "mcq" with no options array, a
// numeric question with no answer and no visual-pending excuse, an
// image-flagged question with no image reference at all. Generic per
// question TYPE, not per subject/worksheet - the same checks apply
// whether the mcq came from a Science true/false task or a Math
// multiple-choice task.
function validateQuestionInteraction(q) {
  const type = q.type || 'text';
  if (type === 'mcq') {
    if (!Array.isArray(q.options) || q.options.length < 2) return 'MCQ/matching question has fewer than 2 options.';
    const hasAnswer = q.answer !== null && q.answer !== undefined && String(q.answer).trim() !== '';
    const hasCorrectFlag = q.options.some(o => o && typeof o === 'object' && o.correct);
    if (!hasAnswer && !hasCorrectFlag && !q.visualUnderstandingRequired) return 'MCQ/matching question has no correct answer specified.';
    return null;
  }
  if (type === 'numeric') {
    if ((q.answer === null || q.answer === undefined || q.answer === '') && !q.visualUnderstandingRequired) {
      return 'Numeric question has no answer and is not marked as visually-dependent.';
    }
    return null;
  }
  if (q.hasImage && !q.imageUrl && !q.visualUnderstandingRequired) {
    return 'Question is flagged hasImage but has neither a real imageUrl nor a visualUnderstandingRequired fallback.';
  }
  return null; // text/open-ended questions just need question text, already checked by normalizeQuestionFields
}

// ── Per-task conversion ledger (zero-silent-content-loss gate) ──────────
// Added 2026-09-14: findIncompleteTasks/enforceVisualGrounding/
// flagUngroundedTaskContent each independently detect a different way a
// task can be unusable or uncertain, but none of them gave a caller
// (teacher UI, publish flow) a single, explicit answer to "was EVERY
// detected task actually preserved, or did something silently not make
// it?". This is schema-driven, not tied to any task type/subject - it
// only asks the same three questions already answered elsewhere in this
// file (does it have real content, is it visually blocked, is its
// content unverified against source) and rolls them into one per-task
// status plus one overall status, so a partial conversion can never be
// presented as a complete one.
// sourceSectionEstimate is now an optional SAFETY NET, not just an advisory
// display number - added 2026-09-14 after a live bug where whole tasks
// (not just thin content within an existing task) vanished from the output
// entirely: a 5-task worksheet came back with only 2 task OBJECTS, so
// every per-task check above passed (there was nothing wrong with either
// of the 2 tasks that existed) and overallStatus was wrongly COMPLETE.
// Root cause (see callGroqWithText) is fixed separately, but this check
// stays as defense-in-depth against ANY other cause of whole-task loss.
// Deliberately conservative to avoid false alarms on correct conversions
// with unusual formatting: only fires when the model produced fewer than
// HALF the structurally-estimated sections, and only when the estimate
// itself is large enough (>=3) to be a meaningful signal.
// Generic (label-pattern-based, not worksheet-specific) check: the source
// text names a content block by a common heading, but the corresponding
// field came back empty - e.g. a document says "Word Bank" somewhere but
// quiz.wordBank has zero entries. Deliberately only checks for the
// PRESENCE of a heading pattern, never for exact wording/count, so it
// stays generic across arbitrary documents rather than tuned to one.
const NAMED_BLOCK_PATTERNS = {
  wordBank: { pattern: /\bword\s*bank\b|\bvocabulary\s*(list|bank)\b/i, label: 'Word Bank' },
  checklist: { pattern: /\blearners?['’]?\s*checklist\b|\bself[\s-]?assessment\b/i, label: 'Learners’ Checklist' },
  credits: { pattern: /\bcredits?\s*:/i, label: 'Credits' },
};
function findMissingNamedBlocks(quiz, sourceText) {
  const text = String(sourceText || '');
  if (!text) return [];
  const missing = [];
  for (const [field, { pattern, label }] of Object.entries(NAMED_BLOCK_PATTERNS)) {
    if (!pattern.test(text)) continue;
    const value = quiz[field];
    const isEmpty = Array.isArray(value) ? value.length === 0 : !value;
    if (isEmpty) missing.push(label);
  }
  return missing;
}

// Text-only conversions: a number in a question that appears nowhere in the
// worksheet transcript was guessed (e.g. fractions printed as a picture the
// OCR couldn't read). Those tasks are flagged for review, never passed off as
// exact. A vision provider read the page itself, so it isn't second-guessed.
function flagUnverifiedNumbers(quiz, { visualUnderstandingAvailable, sourceText }) {
  if (visualUnderstandingAvailable || !sourceText) return quiz;
  const known = new Set(String(sourceText).match(/\d+(?:\.\d+)?/g) || []);
  for (const task of quiz.tasks || []) {
    const missing = new Set();
    for (const q of task.questions || []) {
      const texts = [q.question, ...(Array.isArray(q.options) ? q.options.map(o => (o && typeof o === 'object' ? o.text : o)) : [])];
      const nums = texts.join(' ').match(/\d+(?:\.\d+)?/g) || [];
      const unknown = [...new Set(nums)].filter(n => !known.has(n));
      if (unknown.length) {
        q.unverifiedValues = unknown;
        unknown.forEach(n => missing.add(n));
      }
    }
    if (missing.size) task.unverifiedValues = [...missing];
  }
  return quiz;
}

function buildConversionReport(quiz, { sourceSectionEstimate, sourceText } = {}) {
  const items = (quiz.tasks || []).map(t => {
    if (!taskHasRealContent(t)) {
      return { title: t.title, status: 'FAILED', reason: 'No content could be extracted or generated for this task from the source document.' };
    }
    const anyVisualPending = (t.questions || []).some(q => q.visualUnderstandingRequired);
    if (anyVisualPending) {
      return { title: t.title, status: 'REQUIRES_REVIEW', reason: 'Contains one or more questions that depend on visual content (diagram/image/chart) which could not be analyzed without a working vision-capable AI provider.' };
    }
    if (t.contentGroundingUncertain) {
      return { title: t.title, status: 'REQUIRES_REVIEW', reason: t.contentGroundingNote || CONTENT_GROUNDING_NOTE };
    }
    if (Array.isArray(t.unverifiedValues) && t.unverifiedValues.length) {
      return { title: t.title, status: 'REQUIRES_REVIEW', reason: `Some values (${t.unverifiedValues.slice(0, 8).join(', ')}) were not found in the worksheet's text and may be misread from a picture — check them against the original before publishing.` };
    }
    const interactionIssue = (t.questions || []).map(validateQuestionInteraction).find(Boolean);
    if (interactionIssue) {
      return { title: t.title, status: 'REQUIRES_REVIEW', reason: interactionIssue };
    }
    return { title: t.title, status: 'PRESERVED' };
  });
  const possibleMissingTasks = typeof sourceSectionEstimate === 'number'
    && sourceSectionEstimate >= 3
    && items.length < sourceSectionEstimate / 2;
  const overallStatus = items.length === 0 ? 'FAILED'
    : (items.some(i => i.status !== 'PRESERVED') || possibleMissingTasks) ? 'REVIEW_REQUIRED' : 'COMPLETE';
  const missingNamedBlocks = findMissingNamedBlocks(quiz, sourceText);
  const report = {
    overallStatus: missingNamedBlocks.length ? 'REVIEW_REQUIRED' : overallStatus,
    taskCount: items.length,
    items,
  };
  if (possibleMissingTasks) {
    report.taskCountWarning = `Only ${items.length} task(s) were generated, but the source document appears to have roughly ${sourceSectionEstimate} sections - some tasks may be missing entirely. Please compare against the original document before publishing.`;
  }
  if (missingNamedBlocks.length) {
    report.missingContentWarning = `The source document appears to mention ${missingNamedBlocks.join(', ')}, but it wasn't found in the generated worksheet. Please compare against the original document before publishing.`;
  }
  return report;
}

// ── Deterministic (non-LLM) section-count estimate ────────────────────
// Added 2026-09-14: a purely structural signal - blank-line-separated
// blocks whose first line is short (heading-shaped) - counted WITHOUT any
// keyword/language assumption ("Task", "Activity", numbering style, etc
// are all deliberately NOT used, since the source can use any convention
// in any language). This exists so the generated task count isn't only
// ever cross-checked against the same model that generated it - an
// independent, if approximate, second opinion. Deliberately advisory,
// NOT used to force overallStatus: a structural heuristic like this WILL
// disagree with a correct conversion sometimes (e.g. a worksheet with no
// blank lines between sections at all), and treating every disagreement
// as a hard failure would trade one class of false confidence (silent
// loss) for another (false alarms on correct conversions). Surfaced in
// the report for human/teacher judgment, not enforced automatically.
function estimateSourceSectionCount(sourceText) {
  const text = String(sourceText || '').trim();
  if (!text) return 0;
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const headingLikeBlocks = blocks.filter(b => {
    const firstLine = b.split('\n')[0].trim();
    return firstLine.length > 0 && firstLine.length <= 100;
  });
  return Math.max(1, headingLikeBlocks.length || blocks.length);
}

// ── Deterministic explicit-metadata extraction ─────────────────────────
// Added 2026-09-14 after a real manual-test report: a "Subject Focus:
// Language" worksheet was generated with "Subject: Mathematics" in the
// output, because buildQuizVisionPrompt's schema literally tells the
// model to echo back whatever subject/grade the CALLER passed in (which
// defaults to 'Mathematics'/'PYP 4' when the frontend doesn't have an
// explicit value) - the model was never asked to read the worksheet's
// OWN printed metadata line at all. Per the explicit requirement "never
// use an LLM guess when explicit source metadata exists", this is a
// regex-based, non-LLM scan of the extracted source text for common
// "Label: value" metadata lines - generic label patterns, not tied to
// any specific worksheet's wording - and OVERRIDES the model's output
// only when a real match is found. Never invents a value: an absent
// label leaves the LLM's own (or the caller's default) value untouched.
const EXPLICIT_METADATA_PATTERNS = {
  subject: /^\s*subject(?:\s*focus)?\s*[:\-]\s*(.+)$/im,
  grade: /^\s*(?:grade|class|pyp|year)\s*[:\-]\s*(.+)$/im,
  purpose: /^\s*purpose\s*[:\-]\s*(.+)$/im,
  learningOutcome: /^\s*learning\s*outcome[s]?\s*[:\-]\s*(.+)$/im,
};
function extractExplicitMetadata(sourceText) {
  const text = String(sourceText || '');
  const found = {};
  for (const [field, pattern] of Object.entries(EXPLICIT_METADATA_PATTERNS)) {
    const m = text.match(pattern);
    if (m && m[1] && m[1].trim()) found[field] = m[1].trim();
  }
  return found;
}
function applyExplicitMetadata(quiz, sourceText) {
  const explicit = extractExplicitMetadata(sourceText);
  if (explicit.subject) quiz.subject = explicit.subject;
  if (explicit.grade) quiz.grade = explicit.grade;
  if (explicit.purpose && !quiz.purpose) quiz.purpose = explicit.purpose;
  if (explicit.learningOutcome && !(quiz.learningOutcomes && quiz.learningOutcomes.length)) {
    quiz.learningOutcomes = [explicit.learningOutcome];
  }
  return quiz;
}

// ── Schema-field normalization ─────────────────────────────────────────
// Added 2026-09-14 after a live determinism test caught a real, separate
// correctness gap: the model occasionally writes a question's text under
// a non-canonical field name ("prompt" instead of "question", sometimes
// alongside extra unspecified fields like "task_id"/"instruction"). This
// is NOT caught by findIncompleteTasks (the questions array is non-empty
// - it just has the wrong key), so it would have reached the renderer as
// a question with BLANK text shown to the student. Runs first, before
// any other validation, so everything downstream (completeness checks,
// visual grounding, retry) sees a consistent shape regardless of which
// field name the model happened to use on a given run.
const QUESTION_TEXT_ALIASES = ['prompt', 'text', 'q', 'questionText'];
function normalizeQuestionFields(quiz) {
  for (const task of quiz.tasks || []) {
    if (!Array.isArray(task.questions)) continue;
    for (const q of task.questions) {
      if (!q.question || !String(q.question).trim()) {
        for (const alias of QUESTION_TEXT_ALIASES) {
          if (q[alias] && String(q[alias]).trim()) {
            q.question = q[alias];
            break;
          }
        }
      }
    }
    // A question with no recoverable text under any known field name is
    // worse than no question at all (blank UI shown to the student) -
    // drop it, which naturally makes findIncompleteTasks re-flag the task
    // for retry if that was its only content, rather than shipping it.
    task.questions = task.questions.filter(q => q.question && String(q.question).trim());
  }
  return quiz;
}

// Shared by findIncompleteTasks and computeExtractionStatus (previously
// duplicated inline in both) - true if a task has ANY real content shape
// the renderer supports: literal questions, a table, a chart, pyramids,
// or diagram-fill blanks. Deliberately schema-driven, not task-type-
// driven - a Science matching task, a Social Studies table activity, and
// a Math fraction task all satisfy this the same way, through whichever
// field they actually populated. This is what makes findIncompleteTasks/
// computeExtractionStatus/buildConversionReport general rather than
// hardcoded to any one subject or the three example worksheets.
function taskHasRealContent(t) {
  const hasQuestions = Array.isArray(t.questions) && t.questions.length > 0;
  const hasTable = (t.table && Array.isArray(t.table.rows) && t.table.rows.length) || (Array.isArray(t.tables) && t.tables.length);
  const hasChart = t.chart && Array.isArray(t.chart.bars) && t.chart.bars.length;
  const hasPyramids = Array.isArray(t.pyramids) && t.pyramids.length;
  const hasDiagramFill = Array.isArray(t.diagramFillBlanks) && t.diagramFillBlanks.length;
  return hasQuestions || hasTable || hasChart || hasPyramids || hasDiagramFill;
}

// A task is "incomplete" if it has a title but no actual content for a
// student to answer - no questions, and none of the alternate content
// shapes the renderer supports (table/tables/chart/pyramids/diagramFill).
// Found via a live manual-test report (2026-09-12): a real English math
// worksheet's "Compare fractions with <, >, or =" task came back with a
// title and zero questions - not a Telugu/OCR issue, not a known
// post-processing bug (audited quizHtmlRenderer.js's table-building
// normalizers; none match this task's phrasing) - the underlying
// generation step itself just didn't produce items for that task. Since
// ANY uploaded document can contain ANY task type/phrasing, patching one
// task type at a time doesn't scale - this is a general safety net.
function findIncompleteTasks(quiz) {
  return (quiz.tasks || []).filter(t => !taskHasRealContent(t));
}

// Loose title match: models reliably paraphrase/drop prefixes ("Task 2: "),
// punctuation, and casing even when told to echo a title exactly (verified
// live - see the 2026-09-12 retry-merge bug in QUIZ_PIPELINE_MIGRATION.md).
// Comparing on stripped/lowercased content only, in both directions
// (substring either way), tolerates that without requiring a perfect match.
function normalizeTaskTitle(title) {
  return String(title || '').toLowerCase().replace(/^task\s*\d+\s*[:.\-]?\s*/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Generic one-shot retry: re-prompts the SAME engine that produced the
// quiz (via retryFn, a closure over that engine's own source - the image
// parts, the PDF part, or the extracted/OCR'd text) asking specifically
// for the tasks that came back empty, then merges any successfully
// re-generated tasks back in. Matched primarily by POSITION (we asked for
// exactly these tasks, in this order, and told the model not to return
// the others), with a normalized-title check as a sanity guard against a
// misaligned/reordered response; falls back to fuzzy title matching if
// the position doesn't look right. Engine-agnostic by design, so it works
// the same whether the quiz came from Gemini, Qwen OCR + Groq, or plain
// Groq text - whichever engine actually answered. Exactly one retry
// attempt: if it also fails or is still incomplete, the original
// (partially incomplete) quiz is returned rather than looping - a
// systemic safety net, not a guarantee of 100% completeness.
async function retryIncompleteTasks(quiz, retryFn) {
  const incomplete = findIncompleteTasks(quiz);
  if (!incomplete.length) return quiz;
  const titleList = incomplete.map(t => `- ${t.title}`).join('\n');
  const retryPrompt = `You previously extracted this worksheet into a quiz, but these tasks came back with NO questions:\n${titleList}\n\nRe-examine the worksheet content and produce ONLY these specific tasks, IN THE SAME ORDER LISTED ABOVE, fully populated with real questions, answers, hints, and solutions, using the exact same JSON schema and rules as before. Return {"tasks": [...]} containing just these tasks. Do not return the other tasks again.`;
  let retryRaw;
  try {
    retryRaw = await retryFn(retryPrompt);
  } catch {
    return quiz; // retry failed - keep the original, still better than throwing away a partial result
  }
  let retryData;
  try {
    retryData = JSON.parse(cleanLLMJson(retryRaw));
  } catch {
    return quiz;
  }
  const retryTasks = retryData.tasks || [];
  retryTasks.forEach((rt, i) => {
    if (!Array.isArray(rt.questions) || !rt.questions.length) return;
    const target = incomplete[i]; // positional match against what we asked for
    let idx = target ? quiz.tasks.indexOf(target) : -1;
    if (idx === -1 || (target && rt.title && !normalizeTaskTitle(rt.title).includes(normalizeTaskTitle(target.title).slice(0, 15)))) {
      // Position looks wrong (or no positional slot) - fall back to a
      // fuzzy title search across the remaining incomplete tasks.
      idx = (quiz.tasks || []).findIndex(t => {
        const a = normalizeTaskTitle(t.title), b = normalizeTaskTitle(rt.title);
        return a && b && (a.includes(b) || b.includes(a));
      });
    }
    if (idx !== -1) quiz.tasks[idx] = { ...quiz.tasks[idx], ...rt, title: quiz.tasks[idx].title };
  });
  return quiz;
}

// Single image → quiz JSON. Same provider-agnostic flow as PDFs: see
// generateQuizFromDocument.
async function generateQuizFromImage(imageBuffer, mime, { grade, subject, school, language } = {}) {
  return generateQuizFromDocument({ buffer: imageBuffer, mime: mime || 'image/png', grade, subject, school, language });
}

// Structures already-extracted worksheet TEXT into quiz JSON via Groq's
// text model - confirmed reliable on this account at following complex
// structured-JSON instructions (unlike Groq's vision models, which 404,
// AND unlike Qwen vision, which reads images fine but is unreliable at
// following this prompt's full JSON-structuring rules in one shot - see
// the 2026-09-12 finding in QUIZ_PIPELINE_MIGRATION.md). Used for both
// text extracted directly via pdf-parse and text OCR'd off a rasterized
// image via callQwenOcrText - either way, structuring is Groq's job.
async function buildQuizFromWorksheetText(content, { grade, subject, school } = {}) {
  const prompt = buildQuizVisionPrompt({ grade, subject, school });
  const imageInstructions = `\n\nIMAGE HANDLING FOR THIS TEXT (overrides the general image instructions above, which assume a picture you can look at - here you cannot): the text below may contain markers like "[IMAGE: url=https://...]" or a bare "[IMAGE]". These mark exactly where a real image/diagram/figure appeared in the source document.
- For "[IMAGE: url=...]": this is a REAL, already-hosted image of the actual source content. Copy that EXACT url into "imageUrl" on a QUESTION object - NEVER on the task itself, "imageUrl" is only ever read from a question. Put it on the single question the image is most clearly tied to by position (the one immediately after the marker); if it clearly applies to the whole task instead of one specific question, put it on the FIRST question of that task AND set "sharedImage": true on the task (matching the existing shared-image rules above - the renderer looks for the image specifically on questions[0] in that case). Do NOT also write a "diagramDescription"/"sharedImageDescription" guessing what's in the image - the real image will be shown directly, so don't describe or invent its contents.
- For a bare "[IMAGE]" (no url - the image existed but couldn't be hosted): set "hasImage": true on the nearest question and write a brief, generic "diagramDescription" noting an image was present, without inventing specific visual details you cannot see.
- Never fabricate an image url that isn't given in the text, and never invent an image marker that isn't there.`;
  return callGroqWithText(`${prompt}${imageInstructions}\n\nThe worksheet was provided as text (already transcribed from a PDF or image), not an image - there is no image to look at directly (rely on any [IMAGE] markers per the instructions above for image handling instead). Use ONLY the text below as your source for everything else; ignore any OTHER instructions above about reading images, diagrams, or visual layout that assume you can see a picture.\n\nWORKSHEET TEXT:\n${content.slice(0, 12000)}`);
}

// Raw Groq text call, factored out so retryIncompleteTasks can re-prompt
// the exact same engine with an arbitrary follow-up prompt.
// A content-sparse worksheet occasionally makes the underlying model write
// a natural-language refusal ("I can't create an accurate quiz JSON
// because...") instead of the required JSON object shape, which Groq's
// own json_object mode then rejects with "json_validate_failed" - live-
// verified 2026-09-13: the EXACT same real Telugu worksheet input
// produced, across repeated runs, a valid-but-empty tasks:[] result, a
// 4-tasks-with-0-questions result, AND this outright API rejection - the
// same underlying "not enough content" condition surfacing as three
// structurally different states. Per explicit requirement, blank/
// insufficient source content must be a DETERMINISTIC STATE, not
// sometimes a clean result and sometimes a thrown error - this normalizes
// the json_validate_failed case to the same shape as the other "found the
// task boundaries but no derivable question content" outcomes, instead of
// letting it surface as an opaque job failure.
// GROQ_OUTPUT_TRUNCATED marks a response cut off mid-JSON by the completion-
// token budget - thrown rather than returned so callers can't mistake a
// truncated (silently task-dropping) result for a genuinely complete one.
const GROQ_OUTPUT_TRUNCATED = 'GROQ_OUTPUT_TRUNCATED';

// Live root-caused 2026-09-14: a real 5-task worksheet (28 questions total)
// came back with only 2 tasks - not "2 tasks + 3 FAILED", but 2 tasks
// TOTAL, the other 3 never existing in the JSON at all, so conversionReport
// (which only inspects tasks that exist) reported "COMPLETE". Direct
// reproduction against Groq showed finish_reason: "length" - gpt-oss-120b
// spent 1364 of its 3072 default completion tokens on hidden
// "reasoning_tokens" (not part of the visible JSON), leaving too little
// budget for the actual output, which cut off mid-task and silently
// dropped everything after. Fix verified live: max_tokens: 16000 +
// reasoning_effort: 'low' dropped reasoning_tokens to 185 and produced all
// 5 tasks with finish_reason: "stop". Even with headroom raised, a
// sufficiently large worksheet could still truncate, so finish_reason is
// checked explicitly rather than trusted to "probably not happen again".
async function callGroqWithText(promptText, { maxTokens = 16000 } = {}) {
  const Groq = require('groq-sdk');
  const groq = require('./groqResilient').withTextFallback(new Groq({ apiKey: process.env.GROQ_API_KEY }));
  try {
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      temperature: 0,
      max_tokens: maxTokens,
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' },
    });
    if (completion.choices[0].finish_reason === 'length') {
      // One retry at double the budget before giving up - covers worksheets
      // even larger than the one that surfaced this bug, without doubling
      // cost on every normal-sized request.
      if (maxTokens < 32000) return callGroqWithText(promptText, { maxTokens: maxTokens * 2 });
      throw new Error(GROQ_OUTPUT_TRUNCATED);
    }
    return completion.choices[0].message.content;
  } catch (err) {
    if (/json_validate_failed/i.test(String(err.message))) {
      return JSON.stringify({ title: '', tasks: [], extractionStatus: 'insufficient_source_content' });
    }
    throw err;
  }
}

// Qwen used ONLY for OCR (its strength), not full structured extraction
// (its weakness, per the finding above): transcribe the worksheet's
// visible text as plainly as possible, then hand that text to Groq (see
// buildQuizFromWorksheetText) to do the actual quiz-structuring work.
async function callQwenOcrText(imageBuffer, mime) {
  return callQwenVisionRaw(imageBuffer, mime,
    'Transcribe ALL text visible in this worksheet image, exactly as printed, preserving the order top-to-bottom and left-to-right - headings, instructions, every numbered/lettered item, and any text inside diagrams or tables. Do not summarize, translate, explain, or add anything. Output ONLY the raw transcribed text.');
}

// ── Tesseract.js OCR — for Telugu/Indic-script content, added 2026-09-12 ──
// Benchmarked against the real deployed pipeline's Qwen OCR fallback: Qwen
// was found to hallucinate Telugu text entirely (fabricated different real
// words than what was actually printed - verified by rendering the source
// image and comparing). Tesseract.js (free, local WASM, no API key, no
// per-request cost or external dependency) transcribed the same image
// correctly. No dedicated OCR cloud credential (Google Vision, Azure,
// Textract, ABBYY) exists anywhere in this codebase's 19 repos, so a paid
// alternative was not evaluated live - see QUIZ_PIPELINE_MIGRATION.md for
// the full comparison. Qwen is KEPT (not replaced) for Latin/English
// content, where it already works reliably and needs no extra model
// download; Tesseract is used only when Tesseract.detect() identifies a
// non-Latin script on the image itself (works with zero prior text, so it
// applies equally to a bare image upload or a rasterized PDF page).
const TESSERACT_SCRIPT_TO_LANG = {
  Telugu: 'tel', Devanagari: 'hin', Tamil: 'tam', Kannada: 'kan',
  Malayalam: 'mal', Bengali: 'ben', Gujarati: 'guj', Gurmukhi: 'pan',
  Oriya: 'ori', Latin: 'eng',
};

// Guards every Tesseract call below: tesseract.js has a known failure mode
// where a truly undecodable buffer (not just an unusual format - garbage
// bytes) makes its underlying worker emit a Node 'error' event that
// escapes the returned promise entirely and crashes the whole process
// (verified live: `Buffer.from('fake-png-bytes')` took down the Node
// process even inside a try/catch around Tesseract.detect/recognize).
// A magic-byte check on real image formats sidesteps this by never
// handing Tesseract a buffer it can't decode in the first place - real
// uploads and Puppeteer-rasterized PNGs always pass this; only genuinely
// corrupt/non-image input is rejected, cleanly, before reaching Tesseract.
function looksLikeDecodableImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  const isBmp = buffer[0] === 0x42 && buffer[1] === 0x4d;
  return isPng || isJpeg || isWebp || isBmp;
}

// Fast, local script identification (Tesseract's OSD mode) - no full OCR
// pass, so it's cheap to run before deciding which OCR engine to use.
// Defaults to 'eng' (keeping Qwen as the OCR engine) on any detection
// failure or unrecognized/Latin script - this only ever ADDS Tesseract
// for scripts it's confirmed better at, never removes Qwen's coverage.
// Uses the bundled, offline language packs (services/worksheet/ocrEngine.js):
// the default Tesseract.detect needs the legacy OSD model + a CDN download,
// so it failed and every page was OCR'd as English.
async function detectScriptLang(imageBuffer) {
  if (!looksLikeDecodableImage(imageBuffer)) return 'eng';
  const { detectScript } = require('./worksheet/ocrEngine');
  const script = await detectScript(imageBuffer);
  return TESSERACT_SCRIPT_TO_LANG[script] || 'eng';
}

async function callTesseractOcrText(imageBuffer, lang) {
  if (!looksLikeDecodableImage(imageBuffer)) throw new Error('Tesseract: input is not a decodable image');
  const { ocrImage } = require('./worksheet/ocrEngine');
  const { text } = await ocrImage(imageBuffer, lang === 'eng' ? ['eng'] : [lang, 'eng']);
  return text || '';
}

// OCR router - Tesseract is now PRIMARY for every script, English
// included, with Qwen as an opportunistic secondary. Changed 2026-09-12
// after live testing found Qwen's HuggingFace router returning
// "You have depleted your monthly included credits" in production - an
// availability failure, not just the Telugu accuracy problem found
// earlier. Tesseract has no quota/billing dependency at all (local WASM),
// and was independently verified highly accurate on a real English
// worksheet fixture in the same test pass (correctly read task titles,
// numeric measurements, and instructions - only minor noise on a
// diagram-heavy region, not on real text). Qwen is kept as a secondary
// only in case Tesseract itself fails on a given image; if Qwen's quota
// is still depleted when that happens, callOcrText simply throws instead
// of silently returning nothing, which is the correct behavior per the
// "OCR failure must be handled safely" requirement - a genuinely bad
// result should fail visibly, not produce a confident wrong quiz.
async function callOcrText(imageBuffer, mime) {
  const lang = await detectScriptLang(imageBuffer);
  const primary = () => callTesseractOcrText(imageBuffer, lang);
  const secondary = () => callQwenOcrText(imageBuffer, mime);
  try {
    return (await primary()).trim();
  } catch (tesseractErr) {
    classifyProviderError('tesseract', tesseractErr);
    try {
      return (await secondary()).trim();
    } catch (qwenErr) {
      classifyProviderError('qwen', qwenErr);
      throw qwenErr;
    }
  }
}

// PDF text-extraction fallback, added 2026-09-12: pdf-parse first (works
// for any digitally-generated worksheet, including docx->PDF), but many
// real worksheets (e.g. an IB PYP Telugu fixture) have their actual
// question content as non-selectable graphics/blank writing lines, so
// pdf-parse alone can return almost nothing (just section headers). When
// that happens, rasterize the PDF and use Qwen OCR instead - whichever
// source produced more real content wins.
async function callGroqTextVisionFallback(pdfBuffer, { grade, subject, school, structuredText } = {}) {
  // For a docx-sourced upload, mammoth's own conversion (structuredText)
  // is strictly more accurate than re-deriving text from the flattened
  // PDF via pdf-parse or OCR - it has exact table cell values with zero
  // read-back risk. Use it outright when present and skip straight to
  // structuring; only fall through to pdf-parse/OCR when it's absent
  // (non-docx sources: a native PDF upload, or a bare image).
  if (structuredText && structuredText.trim().length > 20) {
    const text = structuredText.trim();
    const raw = await buildQuizFromWorksheetText(text, { grade, subject, school });
    const retryFn = (retryPrompt) => callGroqWithText(`${retryPrompt}\n\nWORKSHEET TEXT:\n${text.slice(0, 12000)}`);
    return { raw, retryFn, sourceText: text };
  }
  const pdfParse = require('pdf-parse');
  let text = '';
  try {
    const parsed = await pdfParse(pdfBuffer);
    text = (parsed.text || '').trim();
  } catch { /* fall through to OCR below */ }
  if (text.length < 300) {
    try {
      const image = await rasterizePdfPagesToImage(pdfBuffer);
      const ocrText = await callOcrText(image, 'image/png');
      if (ocrText.length > text.length) text = ocrText;
    } catch { /* keep whatever pdf-parse got, even if thin */ }
  }
  if (!text) throw new Error('Could not extract any worksheet content (Gemini failed, and OCR returned nothing)');
  // Preserve real embedded images from the PDF itself - no AI vision
  // needed for this (see extractPdfEmbeddedImages). Best-effort: a
  // failure here must never block text generation, which is why this is
  // wrapped separately from the required `text` extraction above.
  try {
    const embedded = await extractPdfEmbeddedImages(pdfBuffer);
    if (embedded.length) {
      const hosted = await hostExtractedImages(embedded);
      if (hosted.length) {
        text += `\n\n[DETECTED IMAGES - real, extracted directly from the source document, not AI-generated]\n${hosted.map(h => `[IMAGE: url=${h.url}]`).join('\n')}`;
      }
    }
  } catch { /* image preservation is best-effort; text generation must proceed regardless */ }
  const raw = await buildQuizFromWorksheetText(text, { grade, subject, school });
  const retryFn = (retryPrompt) => callGroqWithText(`${retryPrompt}\n\nWORKSHEET TEXT:\n${text.slice(0, 12000)}`);
  return { raw, retryFn, sourceText: text };
}

// PDF page rasterization for the fallback path, added 2026-09-12. Root
// cause found via live testing: many real worksheets (e.g. an IB PYP
// Telugu worksheet fixture) have their actual question content as
// non-selectable graphics/blank writing lines - pdf-parse extracts only
// the printed instruction headers, leaving callGroqTextVisionFallback
// with nothing to build real questions from (empty "questions": []).
// Fix: render each PDF page to an image (same technique the frontend
// already uses in pdfHelpers.ts's pdfToImages - pdfjs-dist + <canvas>,
// just run inside a Puppeteer page instead of a browser tab, since
// Puppeteer is already a proven-working dependency on this service), then
// route through the already-working Qwen vision path - giving the PDF
// fallback the same visual reading capability Gemini has.
async function rasterizePdfPagesToImage(pdfBuffer, { maxPages = 4 } = {}) {
  const { launchBrowser } = require('../utils/browser');
  const fs = require('fs');
  const pdfjsSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.js'), 'utf8');
  const pdfjsWorkerSrc = fs.readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.js'), 'utf8');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: pdfjsSrc });
    const base64 = pdfBuffer.toString('base64');
    const stitchedDataUrl = await page.evaluate(async (b64, maxP, workerSrc) => {
      // eslint-disable-next-line no-undef
      const pdfjsLib = window.pdfjsLib;
      // A real worker (as a blob URL) is required in pdfjs 3.x - it no
      // longer has a fully-synchronous no-worker fallback.
      const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
      const raw = atob(b64);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
      const pageCount = Math.min(doc.numPages, maxP);
      const canvases = [];
      let totalHeight = 0, maxWidth = 0;
      for (let i = 1; i <= pageCount; i++) {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        canvases.push(canvas);
        totalHeight += canvas.height;
        maxWidth = Math.max(maxWidth, canvas.width);
      }
      const combined = document.createElement('canvas');
      combined.width = maxWidth;
      combined.height = totalHeight;
      const combinedCtx = combined.getContext('2d');
      combinedCtx.fillStyle = '#fff';
      combinedCtx.fillRect(0, 0, combined.width, combined.height);
      let y = 0;
      for (const c of canvases) { combinedCtx.drawImage(c, 0, y); y += c.height; }
      return combined.toDataURL('image/png');
    }, base64, maxPages, pdfjsWorkerSrc);
    return Buffer.from(stitchedDataUrl.split(',')[1], 'base64');
  } finally {
    await browser.close();
  }
}

// PDF (or a docx already converted to PDF upstream, with its exact
// structuredText) → quiz JSON. Powers /quiz/generate and the queued
// /quiz/generate-async job.
async function generateQuizFromPdf(pdfBuffer, { grade, subject, school, structuredText, language } = {}) {
  return generateQuizFromDocument({ buffer: pdfBuffer, mime: 'application/pdf', grade, subject, school, structuredText, language });
}

// ── Provider-agnostic worksheet → quiz ────────────────────────────────────
// 1. Document model (no AI): per-page text layer + OCR + pictures placed
//    inline (services/worksheet/documentModel.js).
// 2. First provider that answers, each given that transcript as ground truth:
//    Gemini vision (whole PDF/image) → Mistral vision (page images) → Groq
//    text (transcript only). Only the last is "text-only".
// 3. The same post-processing for every provider.
// Root cause this replaces (2026-10-13): with Gemini unavailable every
// worksheet fell to a text path that trusted a broken Indic text layer,
// skipped OCR when it had ≥300 chars, OCR'd a stitched ~108dpi strip, and
// listed pictures without positions — ~20% of real worksheets converted.
const DOCUMENT_MODEL_TIMEOUT_MS = parseInt(process.env.DOCUMENT_MODEL_TIMEOUT_MS || '150000', 10);
// With a second vision provider configured, a rate-limited Gemini isn't worth
// waiting out (its retries back off for up to GEMINI_VISION_TIMEOUT_MS).
const GEMINI_TIMEOUT_WITH_FALLBACK_MS = parseInt(process.env.GEMINI_TIMEOUT_WITH_FALLBACK_MS || '30000', 10);

async function buildWorksheetDocument({ buffer, mime, structuredText, hints }) {
  const { buildDocumentModel } = require('./worksheet/documentModel');
  const { hostPictures } = require('./worksheet/providers');
  try {
    return await withTimeout(buildDocumentModel({ buffer, mime, structuredText, hints, hostImages: hostPictures }), DOCUMENT_MODEL_TIMEOUT_MS, 'document-model');
  } catch (err) {
    console.warn('[quiz] document model failed, continuing without it:', err.message);
    return null;
  }
}

async function generateQuizFromDocument({ buffer, mime, grade, subject, school, structuredText, language } = {}) {
  const { callMistralVision, transcriptBlock } = require('./worksheet/providers');
  const isPdf = /pdf/i.test(mime || '');
  const doc = await buildWorksheetDocument({ buffer, mime, structuredText, hints: [language, subject] });
  const transcript = doc && doc.text ? doc.text : (structuredText || '');
  const basePrompt = buildQuizVisionPrompt({ grade, subject, school });

  let raw, retryFn, provider;
  let sourceText = transcript;

  // Gemini: reads the original file natively.
  try {
    const parts = isPdf ? [geminiPdfPart(buffer)] : geminiImageParts([{ buffer, mime }]);
    let prompt = basePrompt + transcriptBlock(transcript, { canSeePages: true });
    if (structuredText && structuredText.trim().length > 20 && !doc) {
      prompt += `\n\nGROUND TRUTH TEXT (extracted with 100% accuracy from the original document, including exact table cell values marked with [TABLE]/[/TABLE]): use these EXACT values for any text/numbers/table cells.\n\n${structuredText.slice(0, 12000)}`;
    }
    if (!genAI) throw new Error('GEMINI_API_KEY not configured');
    const model = geminiModel({ responseMimeType: 'application/json', temperature: 0 });
    const geminiBudget = process.env.MISTRAL_API_KEY ? Math.min(GEMINI_TIMEOUT_WITH_FALLBACK_MS, GEMINI_VISION_TIMEOUT_MS) : GEMINI_VISION_TIMEOUT_MS;
    raw = await withTimeout(geminiGenerate(model, [...parts, { text: prompt }]), geminiBudget, 'gemini-vision');
    retryFn = (retryPrompt) => geminiGenerate(model, [...parts, { text: retryPrompt + transcriptBlock(transcript, { canSeePages: true }) }]);
    provider = 'gemini';
  } catch (geminiErr) {
    classifyProviderError('gemini', geminiErr);
  }

  // Mistral: looks at the rendered pages.
  const pageImages = doc && doc.pageImages.length ? doc.pageImages : (!isPdf ? [{ buffer, mime }] : []);
  if (!provider && pageImages.length) {
    try {
      const prompt = basePrompt + transcriptBlock(transcript, { canSeePages: true });
      raw = await callMistralVision(pageImages, prompt);
      retryFn = (retryPrompt) => callMistralVision(pageImages, retryPrompt + transcriptBlock(transcript, { canSeePages: true }));
      provider = 'mistral';
    } catch (mistralErr) {
      classifyProviderError('mistral', mistralErr);
    }
  }

  // Groq text: the transcript only.
  if (!provider) {
    if (transcript && transcript.trim().length > 20) {
      raw = await buildQuizFromWorksheetText(transcript, { grade, subject, school });
      retryFn = (retryPrompt) => callGroqWithText(`${retryPrompt}\n\nWORKSHEET TEXT:\n${transcript.slice(0, 14000)}`);
    } else if (isPdf) {
      // Document model unavailable — previous text/OCR path.
      const fallback = await callGroqTextVisionFallback(buffer, { grade, subject, school, structuredText });
      raw = fallback.raw; retryFn = fallback.retryFn; sourceText = fallback.sourceText;
    } else {
      sourceText = await callOcrText(buffer, mime);
      raw = await buildQuizFromWorksheetText(sourceText, { grade, subject, school });
      retryFn = (retryPrompt) => callGroqWithText(`${retryPrompt}\n\nWORKSHEET TEXT:\n${sourceText.slice(0, 12000)}`);
    }
    provider = 'groq-text';
  }

  const visualUnderstandingAvailable = provider === 'gemini' || provider === 'mistral';
  const quiz = applyExplicitMetadata(normalizeQuestionFields(parseQuizResponse(raw)), sourceText);
  const result = applyExplicitMetadata(normalizeQuestionFields(await retryIncompleteTasks(quiz, retryFn)), sourceText);
  result.visualUnderstandingAvailable = visualUnderstandingAvailable;
  result.provider = provider;
  if (doc) {
    result.documentDiagnostics = doc.diagnostics;
    if (!result.language && doc.scripts.length) result.language = SCRIPT_LANGUAGE_NAMES[doc.scripts[0]] || '';
  }
  enforceVisualGrounding(result, { visualUnderstandingAvailable, sourceText });
  flagUngroundedTaskContent(result, { visualUnderstandingAvailable, sourceText });
  flagUnverifiedNumbers(result, { visualUnderstandingAvailable, sourceText });
  if (doc) {
    // Tasks without pictures get their region's pictures, or the region itself;
    // then picture ids become real (or inline) images.
    const { attachRegionCrops, resolvePictureRefs } = require('./worksheet/regionCrops');
    const { hostPictures } = require('./worksheet/providers');
    result.regionCrops = await attachRegionCrops(result, doc, hostPictures).catch((err) => {
      console.warn('[quiz] region crops failed:', err.message);
      return 0;
    });
    resolvePictureRefs(result, doc);
  }
  result.extractionStatus = computeExtractionStatus(result);
  const sourceSectionEstimate = estimateSourceSectionCount(sourceText);
  result.conversionReport = buildConversionReport(result, { sourceSectionEstimate, sourceText });
  result.conversionReport.sourceSectionEstimate = sourceSectionEstimate;
  return result;
}

const SCRIPT_LANGUAGE_NAMES = {
  Telugu: 'Telugu', Devanagari: 'Hindi', Tamil: 'Tamil', Kannada: 'Kannada', Malayalam: 'Malayalam',
  Bengali: 'Bengali', Gujarati: 'Gujarati', Gurmukhi: 'Punjabi', Oriya: 'Odia', Arabic: 'Urdu',
};

module.exports = {
  generateQuizFromImage, generateQuizFromPdf, generateQuizFromDocument, callGeminiVision, callQwenVision, callQwenVisionRaw, callGroqTextVisionFallback, callQwenOcrText, callTesseractOcrText, detectScriptLang, callOcrText, looksLikeDecodableImage, buildQuizFromWorksheetText, callGroqWithText, rasterizePdfPagesToImage, buildQuizVisionPrompt, cleanLLMJson, findIncompleteTasks, retryIncompleteTasks, htmlToStructuredText, extractPdfEmbeddedImages, hostExtractedImages,
  geminiImageParts, geminiPdfPart, geminiRetry, geminiGenerate, geminiModel, withTimeout, GEMINI_VISION_TIMEOUT_MS,
  PROVIDER_STATUS, classifyProviderError,
  enforceVisualGrounding, isVisuallyDependentQuestion, isAnswerGroundedInSource, VISUAL_UNAVAILABLE_MESSAGE, flagUnverifiedNumbers,
  computeExtractionStatus, normalizeQuestionFields, flagUngroundedTaskContent, extractContentTokens, CONTENT_GROUNDING_NOTE,
  buildConversionReport, taskHasRealContent, validateQuestionInteraction, estimateSourceSectionCount,
  GROQ_OUTPUT_TRUNCATED,
  extractExplicitMetadata, applyExplicitMetadata, findMissingNamedBlocks,
};
