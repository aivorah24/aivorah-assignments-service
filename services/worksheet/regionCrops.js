// After generation: get every task's pictures onto the student page.
//   1. A task the model left without a picture gets the document's own
//      pictures that sit in its region of the page (between its heading and
//      the next task's heading) — when the task needs one, or the picture
//      carries printed values (a conversion chart, a table of fractions).
//   2. A task that needs a picture but has none in its region shows the
//      region itself, cropped from the page (vector drawings, grids, shapes
//      drawn with Word's tools).
//   3. A picture that only prints the task's own questions is dropped
//      (never a diagram: its labels may be copied into the question text).
//   4. A diagram no question uses goes to the question printed above it.
//   5. Picture ids from the transcript (img://p1-3) become real URLs — or an
//      inline image when hosting isn't configured, so nothing goes missing.
const { tokensOf } = require('./documentModel');

const MIN_REGION_PT = 40;
const MAX_REGION_RATIO = 0.7; // a whole page is not a "diagram"

function taskNeedsPicture(task) {
  const qs = task.questions || [];
  if (task.picturesAsText) return false;
  if (qs.some(q => q.imageUrl)) return false;
  return !!task.sharedImage || qs.some(q => q.hasImage || q.visualUnderstandingRequired);
}

const hasPicture = task => (task.questions || []).some(q => q.imageUrl);

// The text row that best matches a task title (≥60% of its words).
function findAnchor(title, anchors) {
  const want = tokensOf(title);
  if (!want.length) return null;
  let best = null;
  for (const a of anchors) {
    const have = new Set(tokensOf(a.text));
    const score = want.filter(t => have.has(t)).length / want.length;
    if (score >= 0.6 && (!best || score > best.score)) best = { ...a, score };
  }
  return best;
}

// Each located task's region: from below its heading to the next task heading
// on that page (or above the footer).
function taskRegions(quiz, doc) {
  const located = (quiz.tasks || []).map(t => ({ task: t, anchor: findAnchor(t.title, doc.anchors || []) }));
  return located.filter(l => l.anchor).map(({ task, anchor }) => {
    const size = (doc.pageSizes || []).find(s => s.page === anchor.page) || { width: 0, height: 0 };
    const nextTop = located
      .filter(o => o.anchor && o.anchor.page === anchor.page && o.anchor.y > anchor.y + 1)
      .map(o => o.anchor.y)
      .sort((a, b) => a - b)[0];
    const top = anchor.y + anchor.h + 2;
    const bottom = Math.min(nextTop ? nextTop - 4 : size.height * 0.95, size.height || Infinity);
    return { task, page: anchor.page, top, bottom, size };
  });
}

function attachRegionPictures(quiz, doc) {
  let attached = 0;
  for (const r of taskRegions(quiz, doc)) {
    if (hasPicture(r.task) || !(r.task.questions || []).length) continue;
    const inRegion = (doc.pictures || []).filter(p => p.page === r.page
      && p.bbox.y + p.bbox.h / 2 >= r.top && p.bbox.y + p.bbox.h / 2 <= r.bottom)
      .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const useful = inRegion.filter(p => taskNeedsPicture(r.task) || p.labels);
    if (!useful.length) continue;
    const qs = r.task.questions;
    if (useful.length > 1 && useful.length === qs.length) {
      useful.forEach((p, i) => { qs[i].imageUrl = p.id; }); // one picture per item (matching)
    } else {
      qs[0].imageUrl = useful[0].id;
      r.task.sharedImage = true;
    }
    attached++;
  }
  return attached;
}

// What a picture prints, as tokens: "1) 28/50 ; 8/24" → 28/50, 8/24. Item
// numbers ("1)", a lone "5") are left out — they're the question labels.
function pictureTokens(labels) {
  return String(labels || '').split(/[\s;|]+/)
    .filter(t => t && !/^\d\)?$/.test(t) && !/^[—–-]$/.test(t))
    .map(t => t.toLowerCase());
}

// A picture that only prints the task's own questions (fractions laid out as
// an image) adds nothing once those values are in the questions: showing it
// repeats Q1–Q4 under Q1. Pictures with anything else (a conversion chart,
// unread values) stay.
//
// A diagram is not such a list even when the model copied all its labels
// into a question ("Find the perimeter: 5 m, 6 m, 8 m, 3 m") - the shape is
// still needed. So a picture counts as text-only only when its values are
// spread over several questions, one item each, and are all values (digits),
// not vertex letters. Diagrams drawn as shapes (vector) are never text.
const questionText = q => `${q.question || ''} ${(q.options || []).join(' ')}`.replace(/\s+/g, '').toLowerCase();

function printsOnlyQuestions(pic, qs) {
  if (pic.vector) return false;
  const tokens = pictureTokens(pic.labels);
  if (tokens.length < 2 || !tokens.every(t => /\d/.test(t))) return false;
  const texts = qs.map(questionText);
  const hits = tokens.map(t => texts.findIndex(x => x.includes(t)));
  if (hits.some(i => i < 0)) return false;
  if (new Set(hits).size < 2) return false;
  return !texts.some(x => tokens.every(t => x.includes(t)));
}

function dropTextOnlyPictures(quiz, doc, droppedIds) {
  const byId = new Map(((doc && doc.pictures) || []).map(p => [p.id, p]));
  let dropped = 0;
  for (const task of quiz.tasks || []) {
    const qs = task.questions || [];
    const refs = qs.filter(q => typeof q.imageUrl === 'string' && byId.has(q.imageUrl));
    if (!refs.length) continue;
    const textOnly = refs.every(q => printsOnlyQuestions(byId.get(q.imageUrl), qs));
    if (!textOnly) continue;
    for (const q of qs) {
      if (q.imageUrl && byId.has(q.imageUrl)) {
        if (droppedIds) droppedIds.add(q.imageUrl);
        delete q.imageUrl;
      }
      delete q.hasImage;
      delete q.visualUnderstandingRequired;
    }
    task.sharedImage = false;
    task.picturesAsText = true;
    dropped++;
  }
  return dropped;
}

// Safety net: a diagram the model left out of every question. It belongs to
// the question printed just above it ("3. Find the area of the rectangle."
// then the rectangle), or to the task whose heading is just above it. Drawn
// diagrams always count; an embedded picture only when that question says it
// needs one. Returns the number of pictures placed.
const ORPHAN_ROWS_ABOVE = 3;
const MATCH_RATIO = 0.6;

function matchScore(rowTokens, text) {
  const have = new Set(tokensOf(text));
  return rowTokens.filter(t => have.has(t)).length / rowTokens.length;
}

function attachOrphanPictures(quiz, doc, droppedIds = new Set()) {
  const tasks = (quiz.tasks || []).filter(t => !t.picturesAsText && (t.questions || []).length);
  const used = new Set();
  for (const t of quiz.tasks || []) for (const q of t.questions || []) if (typeof q.imageUrl === 'string') used.add(q.imageUrl);
  let placed = 0;
  const orphans = (doc.pictures || []).filter(p => p.bbox && !used.has(p.id) && !droppedIds.has(p.id))
    .sort((a, b) => a.page - b.page || a.bbox.y - b.bbox.y);
  for (const pic of orphans) {
    const above = (doc.anchors || [])
      .filter(a => a.page === pic.page && a.y + a.h <= pic.bbox.y + 2)
      .sort((a, b) => b.y - a.y)
      .slice(0, ORPHAN_ROWS_ABOVE);
    let target = null;
    for (const row of above) {
      const want = tokensOf(row.text);
      if (want.length < 2) continue;
      let best = null;
      for (const task of tasks) {
        task.questions.forEach((q) => {
          const s = matchScore(want, q.question || '');
          if (s >= MATCH_RATIO && (!best || s > best.s)) best = { s, task, q };
        });
        const s = matchScore(want, task.title || '');
        if (s >= MATCH_RATIO && (!best || s > best.s)) best = { s, task, q: task.questions[0], shared: true };
      }
      if (best) { target = best; break; }
    }
    if (!target || target.q.imageUrl) continue;
    if (!pic.vector && !(target.q.hasImage || target.q.visualUnderstandingRequired || target.task.sharedImage)) continue;
    target.q.imageUrl = pic.id;
    if (target.shared) target.task.sharedImage = true;
    placed++;
  }
  return placed;
}

async function cropRegion(pageImage, pageSize, top, bottom) {
  const { jimpFromPng, pngBuffer } = require('./pngImage');
  const img = jimpFromPng(pageImage.buffer);
  const k = img.bitmap.width / pageSize.width;
  const y = Math.max(0, Math.floor(top * k));
  const h = Math.min(img.bitmap.height - y, Math.ceil((bottom - top) * k));
  img.crop({ x: 0, y, w: img.bitmap.width, h });
  return { buffer: pngBuffer(img), mime: 'image/png', page: pageImage.page, width: img.bitmap.width, height: h };
}

const dataUri = p => `data:${p.mime || 'image/png'};base64,${p.buffer.toString('base64')}`;

/**
 * Attaches region pictures, then region crops. `hostImages` uploads
 * [{buffer,mime,page}] → [{url}] (empty objects when hosting is unavailable).
 * Returns the number of tasks that received a crop.
 */
async function attachRegionCrops(quiz, doc, hostImages) {
  if (!doc || !doc.anchors) return 0;
  attachRegionPictures(quiz, doc);
  const droppedIds = new Set();
  dropTextOnlyPictures(quiz, doc, droppedIds);
  attachOrphanPictures(quiz, doc, droppedIds);
  if (!doc.pageImages || !doc.pageImages.length) return 0;
  const jobs = [];
  for (const r of taskRegions(quiz, doc)) {
    if (!taskNeedsPicture(r.task) || !r.size.width) continue;
    const pageImage = doc.pageImages.find(p => p.page === r.page);
    if (!pageImage) continue;
    if (r.bottom - r.top < MIN_REGION_PT || (r.bottom - r.top) / r.size.height > MAX_REGION_RATIO) continue;
    jobs.push(r);
  }
  if (!jobs.length) return 0;
  const crops = [];
  for (const j of jobs) crops.push(await cropRegion(doc.pageImages.find(p => p.page === j.page), j.size, j.top, j.bottom));
  const hosted = await hostImages(crops);
  let attached = 0;
  jobs.forEach((j, i) => {
    const url = (hosted[i] && hosted[i].url) || dataUri(crops[i]);
    if (!(j.task.questions || []).length) return;
    j.task.questions[0].imageUrl = url;
    j.task.sharedImage = true;
    j.task.regionCrop = true;
    attached++;
  });
  return attached;
}

// img://… ids → hosted url, or the picture inline when it wasn't hosted.
// Unknown ids (a model inventing one) are dropped.
function resolvePictureRefs(quiz, doc) {
  const byId = new Map(((doc && doc.pictures) || []).map(p => [p.id, p]));
  for (const task of quiz.tasks || []) {
    for (const q of task.questions || []) {
      const ref = q.imageUrl;
      if (typeof ref !== 'string' || !ref.startsWith('img://')) continue;
      const pic = byId.get(ref);
      if (pic) q.imageUrl = pic.url || dataUri(pic);
      else delete q.imageUrl;
    }
  }
  return quiz;
}

module.exports = { attachRegionCrops, attachRegionPictures, dropTextOnlyPictures, attachOrphanPictures, resolvePictureRefs, findAnchor, taskNeedsPicture };
