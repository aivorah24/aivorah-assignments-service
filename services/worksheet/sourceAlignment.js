// After generation: check every task against the worksheet's own text and
// put back what the model dropped or flattened. Works on any worksheet — it
// only looks at the shape of the source, never at specific titles or words.
//   0. Instruction lines under the task heading the quiz doesn't show.
//   1. A passage the student must read (a long paragraph in the task's part
//      of the worksheet) that the quiz doesn't contain becomes task.passage.
//   2. A worked example ("Example: …") the quiz doesn't contain becomes
//      task.example.
//   3. A fill-in table in the worksheet (header row + rows with one blank cell
//      each) becomes task.table when every question of the task is one of its
//      rows, so the quiz is laid out like the worksheet instead of a stack of
//      separate answer boxes.

const MIN_PASSAGE_CHARS = 120;
const MIN_PASSAGE_WORDS = 20;

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => collectStrings(v, out));
  return out;
}

// True when the quiz already shows this text (or a large part of it).
function alreadyShown(text, shownNorm) {
  const t = norm(text);
  if (!t) return true;
  return shownNorm.includes(t.slice(0, Math.min(80, t.length)));
}

// Each task's part of the worksheet: from its heading to the next task's heading.
function taskSections(quiz, sourceText) {
  const src = String(sourceText || '');
  const lines = src.split('\n');
  const lineStarts = [];
  let pos = 0;
  for (const l of lines) { lineStarts.push(pos); pos += l.length + 1; }
  const starts = (quiz.tasks || []).map((task) => {
    const title = String(task.title || '');
    const num = title.match(/\btask\s*(\d+)/i);
    if (num) {
      const m = src.match(new RegExp(`(^|\\n)[^\\S\\n]*task\\s*${num[1]}\\b`, 'i'));
      if (m) return m.index + (m[1] ? 1 : 0);
    }
    const core = norm(title.replace(/\btask\s*\d+\s*[:.·\-–]?/i, '')).slice(0, 30);
    if (core.length < 8) return -1;
    const i = lines.findIndex(l => norm(l).startsWith(core) || (norm(l).length > 10 && norm(l).includes(core)));
    return i >= 0 ? lineStarts[i] : -1;
  });
  const sorted = starts.filter(s => s >= 0).sort((a, b) => a - b);
  return starts.map((s) => {
    if (s < 0) return '';
    const next = sorted.find(x => x > s);
    return src.slice(s, next === undefined ? src.length : next);
  });
}

function parseTables(section) {
  const tables = [];
  for (const m of section.matchAll(/\[TABLE[^\]]*\]\n([\s\S]*?)\n?\[\/TABLE\]/g)) {
    const rows = m[1].split('\n').filter(l => l.trim()).map(l => l.split(/\s*\|\s*/).map(c => c.trim()));
    if (rows.length) tables.push(rows);
  }
  return tables;
}

const isProse = line => line.length >= MIN_PASSAGE_CHARS && line.trim().split(/\s+/).length >= MIN_PASSAGE_WORDS;
// A task's instruction ("Read the passage carefully…") is not a passage.
const INSTRUCTION = /^(read|write|use|choose|sort|fill|match|answer|identify|look|complete|circle|draw|find|think|colou?r|underline|rewrite|tick|name|list|label|observe|solve|arrange|correct)\b/i;

function restorePassage(task, section, shownNorm) {
  if (task.passage && String(task.passage).trim()) return false;
  const outsideTables = section.replace(/\[TABLE[^\]]*\][\s\S]*?\[\/TABLE\]/g, '\n');
  const fromTables = parseTables(section).flatMap(rows => rows.flat());
  const paragraphs = [...outsideTables.split('\n').slice(1), ...fromTables] // line 0 is the task heading
    .map(l => l.trim())
    .filter(l => isProse(l) && !INSTRUCTION.test(l) && !/^\[/.test(l) && !alreadyShown(l, shownNorm));
  if (!paragraphs.length) return false;
  task.passage = paragraphs.join('\n\n');
  return true;
}

// The task's instruction lines ("Read the passage carefully. … correct them.")
// right under its heading, when the quiz doesn't show them.
function restoreInstructions(task, section, shownNorm) {
  if (task.instructions && String(task.instructions).trim()) return false;
  const lines = [];
  for (const raw of section.split('\n').slice(1)) {
    const line = raw.trim();
    if (!line) { if (lines.length) break; continue; }
    if (!INSTRUCTION.test(line) || line.startsWith('[')) break;
    lines.push(line);
  }
  const missing = lines.filter(l => !alreadyShown(l, shownNorm));
  if (!missing.length) return false;
  task.instructions = missing.join(' ');
  return true;
}

function restoreExample(task, section, shownNorm) {
  if (task.example || (task.questions || []).some(q => q.example)) return false;
  for (const line of section.split('\n')) {
    const m = line.trim().match(/^(?:[→\-•*]\s*)?(?:e\.g\.|for example|example)\s*[:\-–]\s*(.{6,})$/i);
    if (m && !alreadyShown(m[1], shownNorm)) {
      task.example = m[1].trim();
      return true;
    }
  }
  return false;
}

// A worksheet table with one blank cell per row, where each row is one of the
// task's questions ("Incorrect word: buyer — correct word:" ↔ row "buyer | ").
function rebuildTable(task, section) {
  if ((task.table && (task.table.rows || []).length) || (Array.isArray(task.tables) && task.tables.length)) return false;
  const qs = (task.questions || []).filter(q => q && q.question);
  if (qs.length < 2 || qs.length !== (task.questions || []).length) return false;
  if (qs.some(q => ['mcq', 'drawing', 'photo', 'venn', 'activity', 'long'].includes(q.type))) return false;

  for (let rows of parseTables(section)) {
    let header = rows[0];
    let body = rows.slice(1);
    // A side-by-side layout flattened into one header row: the passage cell
    // sits in front of the real column headings.
    if (header.length === (body[0] || []).length + 1 && isProse(header[0])) header = header.slice(1);
    if (header.length < 2 || header.some(c => !c) || body.length !== qs.length) continue;
    if (!body.every(r => r.length === header.length && r.filter(c => !c).length === 1)) continue;

    const used = new Set();
    const rowQuestion = body.map((r) => {
      const labels = r.filter(Boolean).map(norm);
      const hit = qs.findIndex((q, i) => !used.has(i) && labels.every(l => ` ${norm(q.question)} `.includes(` ${l} `)));
      if (hit >= 0) used.add(hit);
      return hit;
    });
    if (rowQuestion.some(i => i < 0)) continue;

    task.table = {
      headers: header,
      rows: body.map((r, ri) => {
        const q = qs[rowQuestion[ri]];
        return r.map(c => (c ? { text: c } : { input: true, answer: q.answer == null ? '' : q.answer, _qtype: q.type === 'numeric' ? 'numeric' : 'text' }));
      }),
    };
    task.questions = [];
    task._tableFromSource = true;
    return true;
  }
  return false;
}

function alignTasksWithSource(quiz, sourceText) {
  const report = { instructions: 0, passages: 0, examples: 0, tables: 0 };
  if (!quiz || !Array.isArray(quiz.tasks) || !String(sourceText || '').trim()) return report;
  const sections = taskSections(quiz, sourceText);
  quiz.tasks.forEach((task, i) => {
    const section = sections[i];
    if (!section) return;
    const shownNorm = norm(collectStrings(quiz).join(' '));
    if (restoreInstructions(task, section, shownNorm)) report.instructions++;
    if (restorePassage(task, section, shownNorm)) report.passages++;
    if (restoreExample(task, section, shownNorm)) report.examples++;
    if (rebuildTable(task, section)) report.tables++;
  });
  return report;
}

module.exports = { alignTasksWithSource, taskSections, parseTables };
