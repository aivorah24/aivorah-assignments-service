// Drawn diagrams. Most maths diagrams in worksheets are not pictures but
// shapes drawn in the PDF itself (Word shapes, geometry figures, number lines,
// bar charts), so they never showed up as pictures and the generated quiz
// kept the question text but lost its diagram. This groups the page's drawn
// shapes (pdfLayout.js `drawings`) into figures, so they can be cut from the
// page render and placed like any picture.
//
// What is NOT a figure (all common in worksheets): answer lines and
// underlines (flat), table borders (Word draws them as hairline strips),
// page / section frames, boxes around headings or instructions, rounded
// "Words to Know" panels and speech bubbles full of text, empty answer boxes.

const CLUSTER_GAP = 8;        // shapes closer than this (pt) belong together
const LABEL_REACH = 14;       // labels this close to a figure belong to it
const PAD = 6;                // margin around the cut
const MIN_SIDE = 24;          // a figure is at least this tall AND wide (pt)...
const MIN_FLAT_WIDTH = 60;    // ...or this wide with several marks (a number line)
const MIN_FLAT_MARKS = 5;
const MAX_PER_PAGE = 12;

const letters = s => (String(s).match(/\p{L}/gu) || []).length;
const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;

// A label on a diagram: "5m", "8 cm", "60°", "A", "x", "3/4" - or a row of
// them read as one line ("0 | 1/4 | 2/4 | 3/4 | 1" under a number line).
function isLabel(text) {
  const parts = String(text || '').split(/\s+\|\s+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every(t => t.length <= 14 && (/\d/.test(t) || letters(t) <= 3));
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const inside = (item, box, ratio = 0.6) => overlapArea(item, box) >= ratio * Math.max(1, item.w * item.h);
const grow = (b, d) => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
const union = (a, b) => {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const touches = (a, b) => overlapArea(grow(a, CLUSTER_GAP / 2), grow(b, CLUSTER_GAP / 2)) > 0
  || (a.x <= b.x + b.w + CLUSTER_GAP && b.x <= a.x + a.w + CLUSTER_GAP && a.y <= b.y + b.h + CLUSTER_GAP && b.y <= a.y + a.h + CLUSTER_GAP);

// Shapes that touch (within CLUSTER_GAP) form one group.
function cluster(marks) {
  const parent = marks.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = marks.map((m, i) => i).sort((a, b) => marks[a].x - marks[b].x);
  for (let a = 0; a < order.length; a++) {
    const A = marks[order[a]];
    for (let b = a + 1; b < order.length; b++) {
      const B = marks[order[b]];
      if (B.x > A.x + A.w + CLUSTER_GAP) break; // sorted by x: nothing further can touch A
      if (touches(A, B)) parent[find(order[a])] = find(order[b]);
    }
  }
  const groups = new Map();
  marks.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });
  return [...groups.values()];
}

/**
 * @param {object} page  { drawings, lines, images, width, height } from pdfLayout
 * @returns {{ bbox, labels: string, labelBoxes: object[], marks: number, reason: string }[]} figures, top to bottom
 *   plus `skipped` (why other groups were not figures) for diagnostics.
 */
function findVectorFigures({ drawings = [], lines = [], images = [], width = 0, height = 0 } = {}) {
  const skipped = [];
  if (!width || !height || !drawings.length) return Object.assign([], { skipped });

  // Page backgrounds and invisible specks are never part of a figure.
  const marks = drawings.filter(d => d.w + d.h >= 1 && !(d.w > width * 0.9 && d.h > height * 0.9));
  const figures = [];

  for (const group of cluster(marks)) {
    const box = group.reduce((acc, m) => (acc ? union(acc, m) : { x: m.x, y: m.y, w: m.w, h: m.h }), null);
    const curves = group.some(m => m.curves);
    const diagonal = group.some(m => m.diagonal);
    const axisOnly = !curves && !diagonal;
    const filled = group.some(m => m.paint !== 'stroke');
    const rectsOnly = group.every(m => m.onlyRects);
    const textIn = lines.filter(l => inside(l, box));
    const textLetters = textIn.reduce((n, l) => n + letters(l.text), 0);
    const near = lines.filter(l => isLabel(l.text) && overlapArea(l, grow(box, LABEL_REACH)) > 0);
    const skip = (reason) => skipped.push({ reason, bbox: box, marks: group.length });

    // Lines and strips: answer lines, underlines, table borders.
    const twoD = box.w >= MIN_SIDE && box.h >= MIN_SIDE;
    // A flat figure (number line, ruler, timeline) has upright ticks across a
    // long line, or curves/slants (a jump arrow). A dotted answer line ("1) ……")
    // is many small marks too, but all lying flat.
    const ticks = group.filter(m => m.h > m.w && m.h >= 4).length;
    const flatFigure = box.w >= MIN_FLAT_WIDTH && group.length >= MIN_FLAT_MARKS
      && (diagonal || curves || (ticks >= 3 && near.length >= 1));
    if (!twoD && !flatFigure) { skip('flat'); continue; }
    // Frames around the page or a whole section.
    if (axisOnly && box.w > width * 0.85 && box.h > height * 0.5) { skip('page-frame'); continue; }
    // Boxes, panels and bubbles holding words (instructions, headings, word banks).
    if (textIn.some(l => words(l.text) >= 4 || l.text.length >= 30) || textLetters >= 60) { skip('text-container'); continue; }
    // Table grids: straight unshaded lines around several cells of text.
    if (axisOnly && !filled && textIn.length >= 4 && textIn.some(l => !isLabel(l.text))) { skip('table'); continue; }
    // A plain rectangle is a figure only when it is labelled like one ("8 cm"),
    // or is a grid of squares; otherwise it is an answer box or a frame.
    if (rectsOnly && group.length < 6 && (textIn.some(l => !isLabel(l.text)) || near.length === 0)) { skip('box'); continue; }
    // Publisher / school logos drawn in the header or footer (same rule as
    // documentModel.isDecorative for embedded logos): small, unlabelled.
    const small = box.h < height * 0.1 && box.w < width * 0.45;
    if (small && near.length === 0 && (box.y + box.h < height * 0.13 || box.y > height * 0.8)) { skip('decorative'); continue; }
    // Already a picture (a border drawn around an embedded image).
    if (images.some(img => overlapArea(img.bbox, box) >= 0.5 * box.w * box.h)) { skip('raster-picture'); continue; }

    // The figure with its labels ("5m", "A", "60°") and a small margin.
    let region = box;
    for (const l of near) region = union(region, l);
    region = grow(region, PAD);
    const x = Math.max(0, region.x); const y = Math.max(0, region.y);
    region = { x, y, w: Math.min(width, region.x + region.w) - x, h: Math.min(height, region.y + region.h) - y };
    // The margin must not cut into the question text around the figure.
    let top = region.y; let bottom = region.y + region.h; let left = region.x; let right = region.x + region.w;
    for (const l of lines) {
      if (isLabel(l.text) || overlapArea(l, region) <= 0) continue;
      if (l.y + l.h <= box.y + 1) top = Math.max(top, l.y + l.h + 1);
      else if (l.y >= box.y + box.h - 1) bottom = Math.min(bottom, l.y - 1);
      else if (l.x + l.w <= box.x + 1) left = Math.max(left, l.x + l.w + 1);
      else if (l.x >= box.x + box.w - 1) right = Math.min(right, l.x - 1);
    }
    region = { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
    const labelLines = lines.filter(l => isLabel(l.text) && inside(l, region, 0.8))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    figures.push({
      bbox: region,
      labels: labelLines.map(l => l.text).join(' ; '),
      labelBoxes: labelLines.map(l => ({ x: l.x, y: l.y, w: l.w, h: l.h, text: l.text })),
      marks: group.length,
      reason: curves ? 'curves' : diagonal ? 'diagonal-lines' : filled ? 'shapes' : 'lines',
    });
  }

  // Two figures that grew into each other through shared labels are one.
  const merged = [];
  for (const f of figures.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const host = merged.find(m => overlapArea(m.bbox, f.bbox) > 0);
    if (host) {
      host.bbox = union(host.bbox, f.bbox);
      host.labels = [host.labels, f.labels].filter(Boolean).join(' ; ');
      host.labelBoxes.push(...f.labelBoxes);
      host.marks += f.marks;
    } else merged.push({ ...f, labelBoxes: [...f.labelBoxes] });
  }
  return Object.assign(merged.slice(0, MAX_PER_PAGE), { skipped });
}

module.exports = { findVectorFigures, isLabel };
