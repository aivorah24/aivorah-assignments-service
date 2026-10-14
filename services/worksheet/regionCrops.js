// After generation: get every task's pictures onto the student page.
//   1. A task the model left without a picture gets the document's own
//      pictures that sit in its region of the page (between its heading and
//      the next task's heading) — when the task needs one, or the picture
//      carries printed values (a conversion chart, a table of fractions).
//   2. A task that needs a picture but has none in its region shows the
//      region itself, cropped from the page (vector drawings, grids, shapes
//      drawn with Word's tools).
//   3. A picture that only prints the task's own questions is dropped.
//   4. Picture ids from the transcript (img://p1-3) become real URLs — or an
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
function dropTextOnlyPictures(quiz, doc) {
  const byId = new Map(((doc && doc.pictures) || []).map(p => [p.id, p]));
  let dropped = 0;
  for (const task of quiz.tasks || []) {
    const qs = task.questions || [];
    const text = qs.map(q => `${q.question || ''} ${(q.options || []).join(' ')}`).join(' ').replace(/\s+/g, '').toLowerCase();
    const refs = qs.filter(q => typeof q.imageUrl === 'string' && byId.has(q.imageUrl));
    if (!refs.length) continue;
    const textOnly = refs.every((q) => {
      const tokens = pictureTokens(byId.get(q.imageUrl).labels);
      return tokens.length >= 2 && tokens.every(t => text.includes(t));
    });
    if (!textOnly) continue;
    for (const q of qs) {
      if (q.imageUrl && byId.has(q.imageUrl)) delete q.imageUrl;
      delete q.hasImage;
      delete q.visualUnderstandingRequired;
    }
    task.sharedImage = false;
    task.picturesAsText = true;
    dropped++;
  }
  return dropped;
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
  dropTextOnlyPictures(quiz, doc);
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

module.exports = { attachRegionCrops, attachRegionPictures, dropTextOnlyPictures, resolvePictureRefs, findAnchor, taskNeedsPicture };
