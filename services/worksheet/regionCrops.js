// Safety net for visuals the transcript can't carry (vector drawings, grids,
// shapes drawn with Word's shape tools, charts made of lines): when a task
// needs a picture but none was attached, show students the task's own region
// of the worksheet page — from its heading down to the next task's heading.
const { tokensOf } = require('./documentModel');

const MIN_REGION_PT = 40;
const MAX_REGION_RATIO = 0.7; // a whole page is not a "diagram"

function taskNeedsPicture(task) {
  const qs = task.questions || [];
  if (qs.some(q => q.imageUrl)) return false;
  return !!task.sharedImage || qs.some(q => q.hasImage || q.visualUnderstandingRequired);
}

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

async function cropRegion(pageImage, pageSize, top, bottom) {
  const { jimpFromPng } = require('./pngImage');
  const img = jimpFromPng(pageImage.buffer);
  const k = img.bitmap.width / pageSize.width;
  const y = Math.max(0, Math.floor(top * k));
  const h = Math.min(img.bitmap.height - y, Math.ceil((bottom - top) * k));
  img.crop({ x: 0, y, w: img.bitmap.width, h });
  return { buffer: await img.getBuffer('image/png'), mime: 'image/png', page: pageImage.page, width: img.bitmap.width, height: h };
}

/**
 * Attaches a cropped page region to every task that needs a picture but has
 * none. `hostImages` uploads [{buffer,mime,page}] → [{url}].
 * Returns the number of tasks that received a crop.
 */
async function attachRegionCrops(quiz, doc, hostImages) {
  if (!doc || !doc.anchors || !doc.pageImages || !doc.pageImages.length) return 0;
  const tasks = quiz.tasks || [];
  const located = tasks.map(t => ({ task: t, anchor: findAnchor(t.title, doc.anchors) }));
  const jobs = [];
  for (const { task, anchor } of located) {
    if (!anchor || !taskNeedsPicture(task)) continue;
    const size = doc.pageSizes.find(s => s.page === anchor.page);
    const pageImage = doc.pageImages.find(p => p.page === anchor.page);
    if (!size || !size.width || !pageImage) continue;
    // Region ends at the next task heading on the same page, else above the footer.
    const nextTop = located
      .filter(o => o.anchor && o.anchor.page === anchor.page && o.anchor.y > anchor.y + 1)
      .map(o => o.anchor.y)
      .sort((a, b) => a - b)[0];
    const top = anchor.y + anchor.h + 2;
    const bottom = Math.min(nextTop ? nextTop - 4 : size.height * 0.95, size.height);
    if (bottom - top < MIN_REGION_PT || (bottom - top) / size.height > MAX_REGION_RATIO) continue;
    jobs.push({ task, pageImage, size, top, bottom });
  }
  if (!jobs.length) return 0;
  const crops = [];
  for (const j of jobs) crops.push(await cropRegion(j.pageImage, j.size, j.top, j.bottom));
  const hosted = await hostImages(crops);
  let attached = 0;
  jobs.forEach((j, i) => {
    const url = hosted[i] && hosted[i].url;
    if (!url || !(j.task.questions || []).length) return;
    j.task.questions[0].imageUrl = url;
    j.task.sharedImage = true;
    j.task.regionCrop = true;
    attached++;
  });
  return attached;
}

module.exports = { attachRegionCrops, findAnchor, taskNeedsPicture };
