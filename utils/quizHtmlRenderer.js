// Self-contained HTML template renderer for interactive quizzes.
// Extracted from ai-mentor/server/routes/quiz.js (renderQuizHTML and its
// direct helpers) — used by GET /assignments to live-regenerate the
// interactive-quiz HTML on every read so template fixes propagate to
// existing assignments (see assignments.js's normalise()).

const fs   = require('fs');
const path = require('path');
const { dominantScript, requiredScript, isWrongScript, normalizeAnswer, matchesAnyAnswer } = require('./answerCheck');

function solveVerticalMath(vm) {
  if (!vm || !vm.top || !vm.bottom) return { solvable: false };
  const op = vm.operator === '+' ? '+' : '-';
  const width = Math.max(vm.top.length, vm.bottom.length, (vm.result || '').length);
  const pad = (s) => String(s || '').padStart(width, '_'); // right-align
  const hadResult = !!vm.result;
  const fast = solveVerticalMathFast(pad(vm.top).split(''), pad(vm.bottom).split(''), hadResult ? pad(vm.result).split('') : new Array(width).fill('_'), hadResult, op, width);
  if (fast.solvable) return fast;

  // Fallback: brute-force search for puzzles with 2+ unknown digits in the same
  // column (under-determined for the column method above, e.g. "7_5 - 3_7 = 670").
  // Only meaningful when a result row was actually shown (nothing to verify a
  // guess against otherwise). If exactly one digit assignment reproduces the
  // shown equation, that's the verified answer. If NONE do, the extracted
  // digits/operator are simply impossible — `impossible: true` tells the caller
  // to drop the question rather than ever display a guessed/hallucinated
  // "solution". If MORE THAN ONE do, the puzzle is genuinely ambiguous and gets
  // the same treatment — we never guess between competing valid answers.
  if (!hadResult) return { solvable: false };
  const brute = bruteForceSolveVerticalMath(pad(vm.top).split(''), pad(vm.bottom).split(''), pad(vm.result).split(''), op, width);
  if (!brute) return { solvable: false, impossible: true };
  const topArr = pad(vm.top).split(''), bottomArr = pad(vm.bottom).split(''), resultArr = pad(vm.result).split('');
  const blanks = [];
  for (let i = 0; i < width; i++) {
    if (topArr[i] === '_') blanks.push({ row: 'top', index: i, digit: brute.t[i] });
    if (bottomArr[i] === '_') blanks.push({ row: 'bottom', index: i, digit: brute.b[i] });
    if (resultArr[i] === '_') blanks.push({ row: 'result', index: i, digit: brute.r[i] });
  }
  return {
    solvable: true,
    blanks,
    solvedTopStr: brute.t.join(''),
    solvedBottomStr: brute.b.join(''),
    solvedResultStr: brute.r.join(''),
    steps: [`${brute.t.join('')} ${op} ${brute.b.join('')} = ${brute.r.join('')} (verified — the only digit combination that satisfies this problem)`],
  };
}

// ── "Identify the mistake" / "spot the error" tasks ──────────────────────────
// These worksheets DELIBERATELY show wrong working (e.g. "203 - 57 = 373") and
// ask the student to find and correct the error. The extracted verticalMath is
// therefore SUPPOSED to be arithmetically false — it must never be routed
// through solveVerticalMath's drop-the-impossible-puzzle logic, or the whole
// question (and its task) gets silently deleted, leaving a bare task heading.
// See the guarded drop sites in both generate handlers.

function normalizeVennQuestions(quiz) {
  for (const task of (quiz.tasks || [])) {
    const qs = task.questions || [];
    const explicit = qs.find(q => q.type === 'venn');
    const blob = [task.title, task.sharedImageDescription, ...qs.map(q => q.question || '')].join(' ');
    const isVenn = !!explicit || /venn\s*diagram|overlapping circles/i.test(blob);
    if (!isVenn) continue;

    const src = explicit || qs[0] || {};

    // ── Labels for the two circles ──
    let leftLabel = src.leftLabel, rightLabel = src.rightLabel;
    if (!leftLabel || !rightLabel) {
      // Prefer quoted labels ("...labeled 'Almond' and 'Spinach'"); fall back to unquoted words.
      let m = blob.match(/['"]([A-Za-z][\w ]{0,18}?)['"]\s*(?:and|,|&)\s*['"]([A-Za-z][\w ]{0,18}?)['"]/)
           || (task.title || '').match(/between\s+(?:adding\s+)?([A-Za-z]+)\s+(?:or|and)\s+([A-Za-z]+)/i)
           || blob.match(/compare\s+(?:the\s+[\w ]+?\s+in\s+)?([A-Za-z]+)\s+and\s+([A-Za-z]+)/i);
      if (m) { leftLabel = leftLabel || m[1].trim(); rightLabel = rightLabel || m[2].trim(); }
    }
    leftLabel = leftLabel || 'Group A';
    rightLabel = rightLabel || 'Group B';

    // ── Answers for the three regions ──
    let answers = src.answers;
    const hasAns = answers && (answers.left?.length || answers.center?.length || answers.right?.length);
    if (!hasAns) {
      const sol = qs.map(q => q.solution || '').join('  ') + '  ' + blob;
      const lBase = leftLabel.replace(/s$/i, '');
      const rBase = rightLabel.replace(/s$/i, '');
      const grab = (re) => { const m = sol.match(re); return m ? splitVennItems(m[1]) : []; };
      const center = grab(/(?:common|both|shared|overlap(?:ping)?)[^:]*:\s*([^.\n]+)/i);
      const left = grab(new RegExp('(?:unique to (?:the\\s+)?' + lBase + 's?|' + lBase + 's?\\s*only)[^:]*:\\s*([^.\\n]+)', 'i'));
      const right = grab(new RegExp('(?:unique to (?:the\\s+)?' + rBase + 's?|' + rBase + 's?\\s*only)[^:]*:\\s*([^.\\n]+)', 'i'));
      answers = { left, center, right };
    }

    const vennQ = {
      id: src.id || '1',
      type: 'venn',
      question: src.question || `Complete the Venn diagram to compare ${leftLabel} and ${rightLabel}.`,
      leftLabel, rightLabel,
      answers: { left: answers.left || [], center: answers.center || [], right: answers.right || [] },
      hint: src.hint || 'Items shared by BOTH go in the overlapping middle; unique items go in their own circle.',
      solution: src.solution || `${leftLabel} only: ${(answers.left || []).join(', ')}. Both: ${(answers.center || []).join(', ')}. ${rightLabel} only: ${(answers.right || []).join(', ')}.`,
    };

    // Replace the task's questions with the single structured Venn, force single-column,
    // and drop the stray "blank Venn diagram" description note.
    task.questions = [vennQ];
    task.layout = { type: 'single-column', columns: 1 };
    task.sharedImage = false;
    delete task.sharedImageDescription;
  }
}

// ── Riddle/word-bank table helper ────────────────────────────────────────────
// The original worksheet is a No. | Riddle | Answer table (each row a one-line
// clue, answer picked from a word bank above). If the LLM split that into a
// stack of separate question cards, rebuild it as a real table (task.table) so
// the render matches the source layout: numbered rows, riddle text, and a
// single input box per row — instead of one big card per riddle.

function renderBarChart(chart) {
  const bars = chart.bars || [];
  if (!bars.length) return '';
  const yMax = chart.yMax || Math.max(...bars.map(b => b.value));
  const yStep = chart.yStep || Math.max(1, Math.round(yMax / 10));
  const W = 640, H = 360, padL = 48, padR = 20, padT = 30, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = plotW / bars.length;
  const barW = Math.min(64, bw * 0.6);
  const y = v => padT + plotH - (v / yMax) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:640px;height:auto;background:rgba(255,255,255,0.03);border-radius:10px;">`;
  // gridlines + y labels
  for (let v = 0; v <= yMax; v += yStep) {
    const yy = y(v);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="rgba(195,220,216,0.18)" stroke-width="1"></line>`;
    svg += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" fill="#A8B5B3" font-size="11" font-family="Arial">${v}</text>`;
  }
  // axes
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#93B0AC" stroke-width="1.5"></line>`;
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#93B0AC" stroke-width="1.5"></line>`;
  // bars
  const palette = ['#93B0AC', '#C5BD96', '#D4A898', '#7AADA8', '#EFD1D4', '#C3DCD8'];
  bars.forEach((b, i) => {
    const cx = padL + bw * i + bw / 2;
    const x = cx - barW / 2;
    const yy = y(b.value);
    const h = padT + plotH - yy;
    svg += `<rect x="${x}" y="${yy}" width="${barW}" height="${h}" rx="4" fill="${palette[i % palette.length]}"></rect>`;
    svg += `<text x="${cx}" y="${yy - 6}" text-anchor="middle" fill="#F0EEEC" font-size="12" font-weight="700" font-family="Arial">${b.value}</text>`;
    svg += `<text x="${cx}" y="${padT + plotH + 18}" text-anchor="middle" fill="#D8E8E6" font-size="11" font-family="Arial">${String(b.label).slice(0, 12)}</text>`;
  });
  if (chart.yLabel) svg += `<text x="14" y="${padT + plotH / 2}" transform="rotate(-90 14 ${padT + plotH / 2})" text-anchor="middle" fill="#A8B5B3" font-size="11" font-family="Arial">${chart.yLabel}</text>`;
  if (chart.xLabel) svg += `<text x="${padL + plotW / 2}" y="${H - 6}" text-anchor="middle" fill="#A8B5B3" font-size="11" font-family="Arial">${chart.xLabel}</text>`;
  svg += `</svg>`;

  return `<div style="text-align:center;margin:4px 0 18px;">
    ${chart.title ? `<div style="font-size:14px;font-weight:700;color:#C3DCD8;margin-bottom:8px;">${chart.title}</div>` : ''}
    ${svg}
  </div>`;
}

// When a task is rendered structurally (chart / table / venn), drop any cropped
// worksheet images for that task so we don't show the same visual twice.
function stripImagesForStructuredTasks(quiz) {
  for (const task of (quiz.tasks || [])) {
    const hasChart = task.chart && Array.isArray(task.chart.bars) && task.chart.bars.length;
    const hasTable = (task.table && Array.isArray(task.table.rows) && task.table.rows.length)
      || (Array.isArray(task.tables) && task.tables.some(t => Array.isArray(t.rows) && t.rows.length));
    const hasVenn = (task.questions || []).some(q => q.type === 'venn');
    const hasDiagramFill = task.diagramFillBlanks && task.diagramFillBlanks.length;
    if (!hasChart && !hasTable && !hasVenn) continue;
    if (hasDiagramFill) continue; // diagram-fill owns its own image (task.diagramFillImageUrl) — leave it alone
    task.sharedImage = false;
    delete task.sharedImageDescription;
    delete task.pageImageUrl;
    for (const q of (task.questions || [])) {
      q.hasImage = false;
      delete q.imageUrl;
      delete q.diagramDescription;
      q._sharedImage = false;
    }
  }
}

// The following 7 functions (solveVerticalMathFast through normalizeCharts)
// were called by renderQuizHTML but never actually copied over during the
// extraction from ai-mentor/server/routes/quiz.js — renderQuizHTML and
// solveVerticalMath threw a ReferenceError on every real call as a result
// (silently caught by assignments.js's normalise(), which falls back to the
// frozen stored HTML snapshot). Ported verbatim from the original file.

// Fast path: solves a column only when exactly one of its three digits is
// unknown, using the same carry/borrow procedure a student would follow —
// this also produces the human-readable step-by-step narrative.
function solveVerticalMathFast(top, bottom, result, hadResult, op, width) {
  const blanks = [];
  const steps = [];
  let carry = 0; // carry (addition) or borrow (subtraction) into the next (leftward) column
  for (let i = width - 1; i >= 0; i--) {
    const t = top[i], b = bottom[i], r = result[i];
    const tKnown = t !== '_' && t !== undefined, bKnown = b !== '_' && b !== undefined, rKnown = r !== '_' && r !== undefined && hadResult;
    const unknownCount = (tKnown ? 0 : 1) + (bKnown ? 0 : 1) + (hadResult ? (rKnown ? 0 : 1) : 0);
    const colLabel = width - i; // 1 = units, 2 = tens, ...
    if (op === '+') {
      if (tKnown && bKnown) {
        const sum = Number(t) + Number(b) + carry;
        const digit = sum % 10;
        const nextCarry = sum >= 10 ? 1 : 0;
        if (!hadResult) { result[i] = String(digit); }
        else if (!rKnown) { result[i] = String(digit); blanks.push({ row: 'result', index: i, digit: String(digit) }); }
        else if (Number(r) !== digit) return { solvable: false }; // extracted digits are internally inconsistent — bail rather than show a wrong "fix"
        steps.push(`Column ${colLabel}: ${t} + ${b}${carry ? ' + 1 (carried)' : ''} = ${sum} → write ${digit}${nextCarry ? ', carry 1' : ''}`);
        carry = nextCarry;
      } else if (unknownCount === 1 && hadResult && rKnown) {
        if (!tKnown) {
          let v = Number(r) - Number(b) - carry; let nextCarry = 0;
          if (v < 0) { v += 10; } // shouldn't happen for '+', but guards against bad extraction
          if (v < 0 || v > 9) return { solvable: false };
          top[i] = String(v); blanks.push({ row: 'top', index: i, digit: String(v) });
          steps.push(`Column ${colLabel}: ? + ${b}${carry ? ' + 1 (carried)' : ''} = ${r} → missing top digit is ${v}`);
          carry = nextCarry;
        } else {
          let v = Number(r) - Number(t) - carry; let nextCarry = 0;
          if (v < 0 || v > 9) return { solvable: false };
          bottom[i] = String(v); blanks.push({ row: 'bottom', index: i, digit: String(v) });
          steps.push(`Column ${colLabel}: ${t} + ? ${carry ? '+ 1 (carried) ' : ''}= ${r} → missing bottom digit is ${v}`);
          carry = nextCarry;
        }
      } else {
        return { solvable: false }; // under-determined column
      }
    } else {
      // subtraction: top - bottom = result, with borrow propagating leftward
      if (tKnown && bKnown) {
        let tv = Number(t) - carry, borrowOut = 0;
        if (tv < Number(b)) { tv += 10; borrowOut = 1; }
        const digit = tv - Number(b);
        if (!hadResult) { result[i] = String(digit); }
        else if (!rKnown) { result[i] = String(digit); blanks.push({ row: 'result', index: i, digit: String(digit) }); }
        else if (Number(r) !== digit) return { solvable: false };
        steps.push(`Column ${colLabel}: ${t}${carry ? ' (borrowed, so ' + tv + ')' : ''} − ${b} = ${digit}${borrowOut ? ', borrow 1 from next column' : ''}`);
        carry = borrowOut;
      } else if (unknownCount === 1 && hadResult && rKnown) {
        if (!bKnown) {
          let tv = Number(t) - carry;
          let v = tv - Number(r);
          let borrowOut = 0;
          if (v < 0) { v += 10; borrowOut = 1; }
          if (v < 0 || v > 9) return { solvable: false };
          bottom[i] = String(v); blanks.push({ row: 'bottom', index: i, digit: String(v) });
          steps.push(`Column ${colLabel}: ${t}${carry ? ' (borrowed)' : ''} − ? = ${r} → missing bottom digit is ${v}`);
          carry = borrowOut;
        } else {
          // top unknown, bottom & result known.
          // t - carry - b = r  (if no further borrow needed)  =>  t = r + b + carry
          // or, if that column itself needed a borrow: t = r + b + carry - 10
          let v = Number(r) + Number(b) + carry;
          let borrowOut = 0;
          if (v > 9) { v -= 10; borrowOut = 1; }
          if (v < 0 || v > 9) return { solvable: false };
          top[i] = String(v); blanks.push({ row: 'top', index: i, digit: String(v) });
          steps.push(`Column ${colLabel}: ? ${carry ? '(borrowed) ' : ''}− ${b} = ${r} → missing top digit is ${v}`);
          carry = borrowOut;
        }
      } else {
        return { solvable: false };
      }
    }
  }
  if (blanks.length === 0) return { solvable: false }; // nothing was actually missing — not this feature's concern
  // Steps were pushed units-first (loop runs right→left); that IS the natural
  // solving order a student follows, so no reordering needed here.
  return {
    solvable: true,
    blanks,
    solvedTopStr: top.join(''),
    solvedBottomStr: bottom.join(''),
    solvedResultStr: result.join(''),
    steps,
  };
}

// Brute-force fallback for columns with 2+ unknown digits (out of reach for the
// carry/borrow fast path). Tries every digit 0-9 for each blank position and
// keeps only assignments where top ± bottom EXACTLY equals the shown result.
// Returns the unique solution, or null if there are zero or multiple — either
// way the caller must not display an unverified guess. Capped at 6 blanks
// (10^6 combinations) which comfortably covers any real worksheet puzzle
// while keeping this instant.
function bruteForceSolveVerticalMath(top, bottom, result, op, width) {
  const blanks = [];
  for (let i = 0; i < width; i++) {
    if (top[i] === '_') blanks.push({ row: 'top', index: i });
    if (bottom[i] === '_') blanks.push({ row: 'bottom', index: i });
    if (result[i] === '_') blanks.push({ row: 'result', index: i });
  }
  if (blanks.length === 0 || blanks.length > 6) return null;
  let solution = null;
  const total = Math.pow(10, blanks.length);
  for (let n = 0; n < total; n++) {
    const t = top.slice(), b = bottom.slice(), r = result.slice();
    let rem = n;
    for (let k = 0; k < blanks.length; k++) {
      const d = String(rem % 10);
      rem = Math.floor(rem / 10);
      const bl = blanks[k];
      if (bl.row === 'top') t[bl.index] = d;
      else if (bl.row === 'bottom') b[bl.index] = d;
      else r[bl.index] = d;
    }
    if (width > 1 && t[0] === '0') continue; // no leading-zero numbers
    if (width > 1 && b[0] === '0') continue;
    const tv = Number(t.join('')), bv = Number(b.join('')), rv = Number(r.join(''));
    const computed = op === '+' ? tv + bv : tv - bv;
    if (computed !== rv) continue;
    if (solution) return null; // second valid assignment found — ambiguous, refuse to guess
    solution = { t, b, r };
  }
  return solution;
}

function normalizeMatchingTasks(quiz) {
  (quiz.tasks || []).forEach((task, ti) => {
    const qs = task.questions || [];
    if (qs.length < 2) return;
    const taskText = `${task.title || ''} ${task.description || ''} ${task.instructions || ''}`;
    const looksMatching = /\bmatch(ing)?\b/i.test(taskText) || /జతపరచ/.test(taskText)
      || qs.filter(q => /^match\b/i.test(q.question || '')).length >= 2;
    if (!looksMatching) return;

    // Word bank = every answer in the task (a matching column is one shared pool)
    const bank = [...new Set(qs.map(q => String(q.answer ?? '').trim()).filter(Boolean))];
    if (bank.length < 2) return;

    let matched = 0;
    qs.forEach((q, qi) => {
      if (q.type === 'venn' || q.type === 'activity') return;
      // Genuine MCQ with a flagged correct option — leave untouched
      if (q.type === 'mcq' && Array.isArray(q.options) && q.options.some(o => o && o.correct)) { matched++; return; }
      const ans = String(q.answer ?? '').trim();
      if (!ans || !bank.includes(ans)) return;
      matched++;
      // Deterministic seeded shuffle: stable across re-renders, but the correct
      // word's position varies per question (bank is in question order, so a
      // plain rotation would park every correct answer in slot A)
      const shuffled = bank.slice();
      let s = ((ti + 1) * 2654435761 + (qi + 1) * 40503) >>> 0;
      for (let i = shuffled.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      q.type = 'mcq';
      q.options = shuffled.map(label => ({ label, correct: label === ans }));
    });
    if (matched >= 2) {
      // Flags consumed by renderQuizHTML to draw the drag & drop matching UI
      task._matchTask = true;
      task._wordBank = bank;
    }
  });
}

function normalizeRiddleTables(quiz) {
  for (const task of (quiz.tasks || [])) {
    if (task.table && Array.isArray(task.table.rows) && task.table.rows.length) continue;
    if (Array.isArray(task.tables) && task.tables.length) continue;
    const qs = task.questions || [];
    if (qs.length < 3) continue;

    const blob = [task.title, task.passage, task.sharedImageDescription].join(' ').toLowerCase();
    const looksLikeRiddleSet = /riddle|word bank/i.test(blob);
    const iAmCount = qs.filter(q => /^i\s+am\b/i.test(String(q.question || '').trim())).length;
    const shortTextAnswers = qs.filter(q => q.type !== 'numeric' && String(q.answer || '').trim().split(/\s+/).length <= 4).length;
    if (!(looksLikeRiddleSet || iAmCount >= Math.ceil(qs.length * 0.6))) continue;
    if (shortTextAnswers < qs.length) continue; // every row must be a short pick-the-word answer

    task.table = {
      // Number sequentially (1, 2, 3...), NOT q.id - id is an internal
      // layout/image-matching identifier (the prompt assigns "a","b","c"
      // for that purpose, see buildQuizVisionPrompt), not the worksheet's
      // visible numbering. A riddle set detected here is inherently a
      // straight numbered list in the source, so its position IS its
      // correct displayed number - using q.id silently turned a source
      // "1, 2, 3..." list into "a, b, c..." for every worksheet like this.
      headers: ['No.', 'Riddle', 'Answer'],
      rows: qs.map((q, i) => [
        { text: String(i + 1) },
        { text: (q.question || '').replace(/\*\*(.+?)\*\*/g, '$1') },
        { input: true, answer: q.answer, _qtype: 'text' },
      ]),
    };
    task.questions = [];
    task._tableFromQuestions = true;
  }
}

// The source worksheet shows a row of given letters with ONE blank row beneath
// (add a vowel-sign/dheergham to each letter and write it). The LLM sometimes
// explodes this into a stack of near-identical "Add 'X' to 'Y' and write."
// questions (one per letter) instead of the single table it visually is. Detect
// that repeated phrasing regardless of exact wording and collapse it back into
// a table (or several, chunked to match the source's per-row grouping), the
// same way normalizeRiddleTables does for riddle sets.
function normalizeLetterGridTables(quiz) {
  const ADD_PATTERN = /^add\s+['"‘’“”]?(.+?)['"‘’“”]?\s+to\s+['"‘’“”]?(.+?)['"‘’“”]?\s+and\s+write\.?$/i;
  for (const task of (quiz.tasks || [])) {
    if (task.table && Array.isArray(task.table.rows) && task.table.rows.length) continue;
    if (Array.isArray(task.tables) && task.tables.length) continue;
    const qs = task.questions || [];
    if (qs.length < 5) continue;

    const parsed = qs.map(q => {
      const m = String(q.question || '').trim().match(ADD_PATTERN);
      return m ? { mark: m[1].trim(), letter: m[2].trim(), answer: q.answer } : null;
    });
    if (parsed.some(p => !p)) continue; // every question must match the pattern
    const marks = new Set(parsed.map(p => p.mark));
    if (marks.size > 1) continue; // should be the same symbol added throughout

    const mark = parsed[0].mark;
    const CHUNK = 10; // mirrors the ~10 letters-per-row grouping in the source worksheet
    const tables = [];
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const chunk = parsed.slice(i, i + CHUNK);
      tables.push({
        headers: ['Letter', ...chunk.map(c => c.letter)],
        rows: [[
          { text: mark },
          ...chunk.map(c => ({ input: true, answer: c.answer, _qtype: 'text' })),
        ]],
      });
    }
    task.tables = tables;
    task.questions = [];
    task._tableFromQuestions = true;
  }
}

// Rebuild task.table from questions the LLM split apart, e.g.
// "Complete the Tally marks for Chutney", "Complete the Frequency for Chutney", ...
function normalizeTables(quiz) {
  for (const task of (quiz.tasks || [])) {
    if (Array.isArray(task.tables) && task.tables.length) continue;
    if (task.table && Array.isArray(task.table.rows) && task.table.rows.length) continue;
    const qs = task.questions || [];
    if (qs.length < 2) continue;

    const parsed = [];
    for (const q of qs) {
      const m = String(q.question || '').match(/complete\s+the\s+(.+?)\s+for\s+(.+?)[:.\s]*$/i);
      if (m) parsed.push({ col: m[1].trim(), row: m[2].trim(), answer: q.answer, type: q.type });
    }
    // Need at least 2 columns × 2 rows worth of grid signal
    if (parsed.length < 3) continue;

    const cols = [];
    const rows = [];
    for (const p of parsed) {
      if (!cols.includes(p.col)) cols.push(p.col);
      if (!rows.includes(p.row)) rows.push(p.row);
    }
    if (cols.length < 1 || rows.length < 2) continue;

    const blob = [task.title, task.passage, task.sharedImageDescription].join(' ');
    const hdrMatch = blob.match(/(favourite[\w ]*|item|name|word|category)[^\n.:]{0,20}/i);
    const firstHeader = hdrMatch ? hdrMatch[0].trim() : 'Item';

    const find = (col, row) => parsed.find(p => p.col === col && p.row === row);
    task.table = {
      headers: [firstHeader, ...cols],
      rows: rows.map(r => [
        { text: r },
        ...cols.map(c => {
          const p = find(c, r);
          return { input: true, answer: p ? p.answer : '', _qtype: (p && p.type) || 'text' };
        }),
      ]),
    };
    task._tableFromQuestions = true;
  }
}

// Build task.chart from a text description when the LLM didn't emit structured bars.
function normalizeCharts(quiz) {
  for (const task of (quiz.tasks || [])) {
    if (task.chart && Array.isArray(task.chart.bars) && task.chart.bars.length) continue;
    const blob = [task.title, task.sharedImageDescription, ...(task.questions || []).map(q => q.question || '')].join('  ');
    if (!/bar\s*graph|column\s*chart|bar\s*chart/i.test(blob)) continue;
    // Never auto-synthesize a chart for a task the AI already classified as an
    // "activity" — that means the student draws/constructs the graph
    // themselves on paper (e.g. "organize the data... draw a bar graph in
    // your graph book"), so showing a pre-solved chart here defeats the
    // exercise. This regex fallback used to run blind, ignoring that
    // classification entirely — it would trigger on the mere PHRASE "bar
    // graph" even when the worksheet was asking the student to draw one,
    // not showing an existing one to read.
    if ((task.questions || []).some(q => q.type === 'activity')) continue;
    if (/\bdraw\b[^.]{0,40}\b(graph|chart)\b[^.]{0,25}\b(book|notebook|copy)\b/i.test(blob)) continue;

    // Parse "football has 16 votes, tennis has 8, ..." → bars
    const bars = [];
    const re = /([A-Za-z][A-Za-z ]{1,24}?)\s+(?:has|=|:|scored|got)\s+(\d+)/gi;
    let m;
    while ((m = re.exec(blob)) !== null) {
      const label = m[1].trim().replace(/^(and|the)\s+/i, '');
      const value = parseInt(m[2], 10);
      if (label && !isNaN(value) && label.length <= 24) bars.push({ label, value });
    }
    if (bars.length < 2) continue;

    const yMaxMatch = blob.match(/(?:from\s*0\s*to|0\s*(?:to|-|–)\s*)(\d+)/i);
    const maxVal = Math.max(...bars.map(b => b.value));
    const yMax = yMaxMatch ? parseInt(yMaxMatch[1], 10) : Math.ceil(maxVal / 2) * 2;
    const titleMatch = blob.match(/titled\s*['"]([^'"]+)['"]/i) || blob.match(/graph\s+(?:titled\s+)?['"]?([A-Z][\w ]{2,30})['"]?/);
    task.chart = {
      type: 'bar',
      title: titleMatch ? titleMatch[1].trim() : 'Bar Graph',
      yMax, yStep: yMax >= 20 ? 2 : Math.max(1, Math.round(yMax / 10)),
      bars,
    };
    task.sharedImage = false;
    delete task.sharedImageDescription;
  }
}

// Escape HTML, then convert **bold** markdown to <strong> tags.
// Uploaded document text (worksheet questions, passages, examples, etc.)
// is untrusted input that flows directly into this template - added
// 2026-09-14 after an architecture review flagged that fmt() previously
// interpolated raw text with zero escaping, so a document containing
// "<script>" or an "onerror=" attribute in its text would execute as real
// HTML/JS in the generated worksheet. Escaping happens BEFORE the bold
// conversion so a literal "**" in source text still becomes <strong>,
// while any HTML-meaningful characters in the surrounding text are inert.
// Only &/</> are escaped, not quotes - fmt()'s output is only ever used as
// element TEXT CONTENT in this file (never interpolated inside an HTML
// attribute value), so quotes carry no injection risk here and escaping
// them would visibly mangle ordinary apostrophes ("town's") into &#39; in
// the rendered worksheet for no safety benefit.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function fmt(text) {
  if (!text) return '';
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
// Solution text: escape first, then add markup (adding tags before fmt() showed them as literal text).
function fmtSolution(text, { steps = false, units = false, sentences = false } = {}) {
  let s = fmt(text);
  if (sentences) s = s.replace(/\. /g, '.<br>');
  if (steps) s = s.replace(/Step (\d)/g, '<br>Step $1');
  s = s.replace(/Answer:/g, '<br><strong>Answer:</strong>');
  // Whole units only, so "900 ml" is not split into "900 m" + "l".
  if (units) s = s.replace(/(\d+(?:\.\d+)?)\s*(m²|cm²|km|mm|cm|m|tiles)(?![A-Za-z²])/g, '<strong>$1 $2</strong>');
  return s;
}

// Worksheet languages. `re` detects the script; `translit` = Google Input Tools
// can turn phonetic English into it (served by GET /quiz/transliterate).
const WORKSHEET_LANGS = [
  { code: 'te', name: 'Telugu',    re: /[\u0C00-\u0C7F]/, label: 'తె', translit: true },
  { code: 'hi', name: 'Hindi',     re: /[\u0900-\u097F]/, label: 'हि', translit: true },
  { code: 'mr', name: 'Marathi',   re: null,               label: 'म',  translit: true },
  { code: 'sa', name: 'Sanskrit',  re: null,               label: 'सं', translit: true },
  { code: 'ne', name: 'Nepali',    re: null,               label: 'ने', translit: true },
  { code: 'ta', name: 'Tamil',     re: /[\u0B80-\u0BFF]/, label: 'த',  translit: true },
  { code: 'kn', name: 'Kannada',   re: /[\u0C80-\u0CFF]/, label: 'ಕ',  translit: true },
  { code: 'ml', name: 'Malayalam', re: /[\u0D00-\u0D7F]/, label: 'മ',  translit: true },
  { code: 'bn', name: 'Bengali',   re: /[\u0980-\u09FF]/, label: 'বা', translit: true },
  { code: 'gu', name: 'Gujarati',  re: /[\u0A80-\u0AFF]/, label: 'ગુ', translit: true },
  { code: 'pa', name: 'Punjabi',   re: /[\u0A00-\u0A7F]/, label: 'ਪੰ', translit: true },
  { code: 'or', name: 'Odia',      re: /[\u0B00-\u0B7F]/, label: 'ଓ',  translit: true },
  { code: 'ur', name: 'Urdu',      re: null,               label: 'اُ', translit: true },
  { code: 'ar', name: 'Arabic',    re: /[\u0600-\u06FF]/, label: 'ع',  translit: true },
  { code: 'as', name: 'Assamese',  re: null,               label: 'অ',  translit: true },
  { code: 'fa', name: 'Persian',   re: null,               label: 'فا', translit: true },
  { code: 'th', name: 'Thai',      re: /[฀-๿]/, label: 'ท',  translit: true },
  // Japanese before Mandarin: kana marks Japanese, Han alone means Chinese
  { code: 'ja', name: 'Japanese',  re: /[぀-ヿ]/, label: 'あ', translit: true },
  { code: 'zh', name: 'Mandarin',  re: /[一-鿿]/, label: '中', translit: true },
  { code: 'ko', name: 'Korean',    re: /[가-힯]/, label: '한', translit: false },
  { code: 'ru', name: 'Russian',   re: /[Ѐ-ӿ]/, label: 'Ру', translit: true },
  { code: 'el', name: 'Greek',     re: /[Ͱ-Ͽ]/, label: 'Ελ', translit: true },
  { code: 'fr', name: 'French',    re: null,               label: 'FR', translit: false },
  { code: 'es', name: 'Spanish',   re: null,               label: 'ES', translit: false },
  { code: 'de', name: 'German',    re: null,               label: 'DE', translit: false },
  { code: 'nl', name: 'Dutch',     re: null,               label: 'NL', translit: false },
  { code: 'it', name: 'Italian',   re: null,               label: 'IT', translit: false },
  { code: 'pt', name: 'Portuguese', re: null,              label: 'PT', translit: false },
];
// Google Input Tools method per code; Chinese is typed as pinyin
const TRANSLIT_ITC = (code) => (code === 'zh' ? 'zh-t-i0-pinyin' : `${code}-t-i0-und`);
const TRANSLIT_LANG_CODES = WORKSHEET_LANGS.filter(l => l.translit).map(l => l.code);

function findLang(v) {
  const k = String(v || '').trim().toLowerCase();
  if (!k) return null;
  return WORKSHEET_LANGS.find(l => l.code === k || l.name.toLowerCase() === k) || null;
}

// The teacher's chosen language (quiz.language) wins; otherwise detect it from
// the worksheet's own script, then from the subject name. Returns a code or 'en'.
function resolveQuizLanguage(quiz) {
  const chosen = findLang(quiz.language);
  if (chosen) return chosen.code;
  const text = (quiz.tasks || []).map(t => [
    t.title, t.passage, t.instructions,
    ...(t.questions || []).map(q => `${q.question || ''} ${typeof q.answer === 'string' ? q.answer : ''}`),
  ].filter(Boolean).join(' ')).join(' ');
  const byScript = WORKSHEET_LANGS.find(l => l.re && l.re.test(text));
  if (byScript) return byScript.code;
  const subject = String(quiz.subject || '');
  const bySubject = WORKSHEET_LANGS.find(l => new RegExp(`\\b${l.name}\\b`, 'i').test(subject));
  if (bySubject) return bySubject.code;
  if (/[àâæçéèêëïîôùûüÿœ]/i.test(text) || /fran[çc]ais/i.test(subject)) return 'fr';
  if (/[ñ¿¡]/i.test(text) || /espa[ñn]ol/i.test(subject)) return 'es';
  if (/deutsch/i.test(subject)) return 'de';
  return 'en';
}

function renderQuizHTML(quiz, branding = {}, { apiBase = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '' } = {}) {
  normalizeVennQuestions(quiz);
  normalizeCharts(quiz);
  normalizeRiddleTables(quiz);
  normalizeLetterGridTables(quiz);
  normalizeTables(quiz);
  normalizeMatchingTasks(quiz);
  stripImagesForStructuredTasks(quiz);
  // AI-written image descriptions go inside alt="..." — a stray quote broke the <img> tag.
  const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Helper: convert relative image URL to base64 data URI so HTML works standalone
  const serverRoot = path.resolve(__dirname, '..');
  function embedImage(relUrl) {
    if (!relUrl) return relUrl;
    if (relUrl.startsWith('data:')) return relUrl; // already base64
    // relUrl like "/data/images/quiz/abc.png" → server/data/images/quiz/abc.png
    const filePath = path.join(serverRoot, relUrl);
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return relUrl; // fallback to original URL if file not found
    }
  }

  // Auto-generate hints & fix "Not provided" answers for ALL questions (universal — all subjects/languages)
  for (const task of (quiz.tasks || [])) {
    for (const q of (task.questions || [])) {
      const qText = (q.question || '') + ' ' + (task.title || '');

      // Fix "Not provided" answers — LLM sometimes returns this instead of solving
      if (q.answer && /not provided|n\/a|unknown/i.test(String(q.answer))) {
        q.answer = '';
      }
      if (q.solution && /not provided|n\/a/i.test(q.solution)) {
        q.solution = '';
      }

      // Generate hint if missing or empty
      if (!q.hint || !q.hint.trim()) {
        if (q.type === 'fraction' || /fract|reduce|lowest|simplif/i.test(qText)) {
          q.hint = 'Find the GCF (Greatest Common Factor) of the numerator and denominator, then divide both by it.';
        } else if (q.type === 'comparison' || /compar|<|>|=/i.test(qText)) {
          q.hint = 'Convert fractions to the same denominator (find the LCM), then compare the numerators.';
        } else if (q.unit && /g$|gm$|kg$/i.test(q.unit)) {
          q.hint = '1 kg = 1000 g. Multiply when converting larger to smaller units, divide for smaller to larger.';
        } else if (q.unit && /ml$|l$/i.test(q.unit)) {
          q.hint = '1 L = 1000 mL. Multiply when converting larger to smaller units, divide for smaller to larger.';
        } else if (q.unit && /cm$|mm$|m$|km$/i.test(q.unit)) {
          q.hint = '1 km = 1000 m, 1 m = 100 cm, 1 cm = 10 mm. Use these conversion factors.';
        } else if (q.unit && /m²|cm²|sq/i.test(q.unit)) {
          q.hint = 'Area = length × width. Perimeter = sum of all sides.';
        } else if (/perimete/i.test(qText)) {
          q.hint = 'Perimeter = sum of all sides. Find any missing sides first.';
        } else if (/area/i.test(qText)) {
          q.hint = 'Area = length × width for rectangles. Break complex shapes into simpler parts.';
        } else if (/angle|protract|degree/i.test(qText)) {
          q.hint = 'Acute < 90°, Right = 90°, Obtuse > 90°, Straight = 180°.';
        } else if (/bar\s*graph|chart|graph|data/i.test(qText)) {
          q.hint = 'Read the values carefully from the graph. Check the scale on each axis.';
        } else if (/venn|diagram/i.test(qText)) {
          q.hint = 'Look at where the circles overlap for shared items, and outside for unique items.';
        } else if (q.solution && q.solution.trim().length > 5) {
          const firstStep = q.solution.split(/[.\n]/).find(s => s.trim().length > 5);
          if (firstStep) q.hint = 'Think about: ' + firstStep.trim().replace(/^Step\s*\d+[:\s]*/i, '');
        }
      }

      // Universal fallback — EVERY question gets a hint, no exceptions
      if (!q.hint || !q.hint.trim()) {
        q.hint = 'Read the question carefully and think step by step.';
      }

      // Ensure solution exists
      if (!q.solution || !q.solution.trim()) {
        if (q.answer !== undefined && q.answer !== '') {
          q.solution = 'The answer is: ' + q.answer;
        }
      }
    }
  }

  // NOTE: totalQ is finalized to qNum after the task loop below registers every
  // checkable question — registerQuestion() may run more/fewer times than
  // task.questions.length (e.g. two-column layouts can register a question
  // twice), so counting task.questions directly could make the score (sc)
  // exceed this total.

  const tierStyles = {
    'MUST DO':     { bg: 'rgba(147,176,172,0.08)', border: '#93B0AC', label: '#93B0AC', labelBg: 'rgba(147,176,172,0.15)' },
    'COULD DO':    { bg: 'rgba(197,189,150,0.08)', border: '#C5BD96', label: '#C5BD96', labelBg: 'rgba(197,189,150,0.15)' },
    'ENRICHMENT':  { bg: 'rgba(239,209,212,0.08)', border: '#EFD1D4', label: '#EFD1D4', labelBg: 'rgba(239,209,212,0.15)' },
    // Neutral fallback for any tier language that isn't one of the three
    // above ("Core"/"Extension", "Level 1/2/3", custom section names, or no
    // tiers at all). Previously any unrecognized tier silently inherited
    // MUST DO's green — implying an urgency/priority meaning the worksheet
    // never stated. Slate, not tied to any tier's meaning.
    'DEFAULT':     { bg: 'rgba(168,181,179,0.06)', border: '#8C9C99', label: '#8C9C99', labelBg: 'rgba(168,181,179,0.14)' },
  };

  // Aivorah concept card colors
  const conceptCardColors = ['#93B0AC', '#C5BD96', '#D4A898', '#C3DCD8', '#EFD1D4', '#7AADA8'];

  // Concept icon lookup
  const conceptIcons = {
    'area': '&#9998;', 'perimeter': '&#9997;', 'angle': '&#8736;',
    'data': '&#128202;', 'graph': '&#128200;', 'fraction': '&#189;',
    'measurement': '&#128207;', 'default': '&#128218;'
  };
  function getConceptIcon(term) {
    const t = (term || '').toLowerCase();
    for (const [key, icon] of Object.entries(conceptIcons)) {
      if (t.includes(key)) return icon;
    }
    return conceptIcons['default'];
  }

  // Smart label based on question context — returns null for long/open-ended questions
  function smartLabel(q, unit) {
    if (q.type === 'long') return null;
    const qLower = (q.question || '').toLowerCase();
    const uLower = (unit || '').toLowerCase();
    if (qLower.includes('side') || qLower.includes('side length')) return 'Side =';
    if (qLower.includes('perimeter') || uLower === 'cm' && qLower.includes('perimeter')) return 'Perimeter =';
    if (qLower.includes('area') || uLower.includes('²') || uLower.includes('m2')) return 'Area =';
    if (qLower.includes('distance') || qLower.includes('jog') || qLower.includes('walk') || qLower.includes('run')) return 'Distance =';
    if (uLower === 'tiles' || qLower.includes('tiles')) return 'Number of tiles =';
    if (qLower.includes('how many') || qLower.includes('number of')) return 'Answer =';
    if (uLower.includes('km') && uLower.includes('m')) return 'Distance =';
    // Open-ended / language questions — no label
    if (/\b(write|describe|explain|identify|correct|find the error|use.*word|sentence|passage|paragraph)\b/i.test(qLower)) return null;
    // Non-numeric answers (riddles, word-bank picks, vocabulary) aren't a math equation —
    // "=" reads oddly for a word answer, so use a plain colon label instead.
    const isNumericAnswer = /^-?\d+(\.\d+)?$/.test(String(q.answer || '').trim());
    if (q.type !== 'numeric' && !isNumericAnswer) return 'Answer:';
    return 'Answer =';
  }

  // Smart placeholder based on answer type/unit
  function smartPlaceholder(q, unit) {
    const uLower = (unit || '').toLowerCase();
    const ans = String(q.answer || '');
    if (uLower.includes('km') && uLower.includes('m') && !uLower.includes('²')) return 'e.g. 1 km 800 m';
    if (q.type === 'text' && ans.includes(',')) return 'e.g. ' + ans.split(',')[0].trim() + ', ...';
    if (uLower.includes('²')) return '? ' + unit;
    return '?';
  }

  // Bold key numbers/words in question text
  function fmtQuestion(text) {
    if (!text) return '';
    // Escaped first: question text comes from the uploaded document ("1/2 < 9/9").
    let s = escapeHtml(text);
    // "28/50" → stacked, as printed on the worksheet (not dates like 13/03/2026).
    s = s.replace(/(^|[^\d/])(\d{1,4})\/(\d{1,4})(?![\d/])/g, '$1<span class="frac"><span>$2</span><span>$3</span></span>');
    // Bold numbers with units: "65 m", "450 m", "200 m", "40 cm", etc.
    s = s.replace(/(\d+(?:\.\d+)?)\s*(m²|cm²|km|m|cm|mm|kg|g|mg|kL|L|mL|tiles|degrees|rounds)\b/g, '<strong>$1 $2</strong>');
    // Bold key action words
    s = s.replace(/\b(four times|five rounds|three times|twice|double[sd]?)\b/gi, '<strong>$1</strong>');
    // Apply markdown bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return s;
  }

  // Worksheet language → input lang/dir, IME and accent palette.
  const detectedLang = resolveQuizLanguage(quiz);
  const langInfo = findLang(detectedLang);
  const translitLang = langInfo && langInfo.translit ? langInfo : null;
  const isFrench = detectedLang === 'fr';
  // The writing system answers must use (Tamil typed on a Telugu sheet is wrong).
  const LANG_SCRIPT = { te: 'Telugu', hi: 'Devanagari', mr: 'Devanagari', sa: 'Devanagari', ne: 'Devanagari', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali', gu: 'Gujarati', pa: 'Gurmukhi', or: 'Oriya', ur: 'Arabic', ar: 'Arabic', zh: 'Han', ja: 'Kana', ko: 'Hangul', ru: 'Cyrillic', el: 'Greek' };
  const worksheetScript = LANG_SCRIPT[detectedLang] || 'Latin';
  // dir="auto" lets Arabic/Urdu answers type right-to-left; autocomplete/spellcheck
  // off so the browser doesn't "correct" non-English words.
  const inputLangAttr = detectedLang !== 'en'
    ? ` lang="${detectedLang}" dir="auto" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"`
    : '';
  const htmlLang = detectedLang;
  const isLanguageWorksheet = detectedLang !== 'en' ||
    /telugu|hindi|sanskrit|urdu|tamil|kannada|malayalam|bengali|marathi|gujarati|punjabi|odia|french|fran[çc]ais|spanish|espa[ñn]ol|german|deutsch|mandarin|chinese|japanese|korean|arabic|russian/i.test(quiz.subject || '');

  let tasksHTML = '';
  let qNum = 0;
  const answersMap = {};

  // ── Helper: register a question in answersMap, return its qId ──
  function registerQuestion(q) {
    qNum++;
    const qId = `q${qNum}`;
    if (q.type === 'venn') {
      // openEnded: the worksheet asks the student to pick their OWN data to sort
      // (e.g. "choose any two times tables and sort their multiples") — there is
      // no single correct answer for the AI to compute, so grading against a
      // fixed "answers" set is impossible. Auto-accept once filled in, same
      // pattern as open-ended text questions above (a.open).
      answersMap[qId] = { venn: true, open: !!q.openEnded, answers: q.answers || { left: [], center: [], right: [] } };
      return qId;
    }
    // Missing-digit vertical arithmetic with a deterministic solve available
    // (see solveVerticalMath) gets its OWN grading path — dedicated per-blank
    // digit validation + an independent arithmetic cross-check — instead of
    // the generic single-text-box comparison every other type uses below.
    if (q.verticalMath && q.verticalMath.solvable) {
      answersMap[qId] = {
        vertMath: true,
        vmOperator: q.verticalMath.operator || '-',
        vmBlanks: q.verticalMath.blanks,
        vmTop: q.verticalMath.solvedTopStr,
        vmBottom: q.verticalMath.solvedBottomStr,
        vmResult: q.verticalMath.solvedResultStr,
        vmSteps: q.verticalMath.steps,
      };
      return qId;
    }
    const ansRaw = q.answer;
    const isActivity = q.type === 'activity' || (q.type === 'text' && /\b(draw|sketch|create|construct|design|colour|color|paste|cut)\b/i.test(q.question));
    const isFraction = typeof ansRaw === 'string' && /^\d+\/\d+$/.test(ansRaw);
    const ansIsNumber = typeof ansRaw === 'number' || (typeof ansRaw === 'string' && !isNaN(parseFloat(ansRaw)) && isFinite(ansRaw));
    const isNum = !isFraction && ansIsNumber;
    const isMcq = q.type === 'mcq' && Array.isArray(q.options);
    const hasDefinedAnswer = ansRaw !== undefined && ansRaw !== null && String(ansRaw).trim() !== '';
    // Open-ended (reflection/opinion) questions have NO single correct answer at all —
    // mirrors smartLabel()'s null-label condition. These are auto-accepted once attempted.
    const isOpenEnded = !hasDefinedAnswer && (q.type === 'long' ||
      /\b(write|describe|explain|identify|correct|find the error|use.*word|sentence|passage|paragraph)\b/i.test(q.question || ''));
    // Theory/short-factual answers DO have a definite correct answer, but it's TEXT
    // ("football", "hockey and football") where a student's exact phrasing rarely
    // lines up with a strict string comparison — a correct "the football bar" would
    // fail exact-match against "football". These get the teacher-marking-scheme
    // treatment instead: keyword overlap (keywordMatch) + an AI semantic fallback,
    // so meaning is judged, not surface form.
    //
    // This applies to ANY pure-text answer, single word or many — the ONLY things
    // that stay on the strict exact/numeric path are answers that genuinely have one
    // right form: a number, a fraction, or a number-with-unit / tally ("12 cm", "3
    // apples"). We detect those by "contains a digit" and exclude them here, so a
    // relaxed keyword check can never wrongly accept "5 cm" for "12 cm".
    const hasDigit = /\d/.test(String(ansRaw));
    const isTheory = typeof ansRaw === 'string' && !isNum && !isFraction && !hasDigit && hasDefinedAnswer &&
      (() => {
        const tokens = ansRaw.trim().split(/\s+/);
        const alphaTokens = tokens.filter(t => /^\p{L}/u.test(t)); // any script, not just Latin
        return alphaTokens.length >= 1; // any pure-text answer, incl. a single word
      })();
    // "Identify the mistake / write the correct working / explain what went wrong"
    // questions are open-ended reflection tasks: the student writes free-form
    // multi-line working + reasoning (e.g. "203 - 057 ----- 146"), never a single
    // exact string. Exact/numeric matching wrongly rejects a correct working, and
    // even AI semantic grading is unreliable/harsh for a young child's phrasing.
    // Industry norm (Khan Academy, Google) is to ACCEPT any genuine attempt and
    // reveal the worked solution to learn from — so route these to the open-ended
    // path (auto-accept once attempted + show solution), never a hard red fail.
    const isExplanatory = /\b(identify the mistake|what went wrong|correct working|explain|justify|show your (thinking|working)|give (a )?reasons?|describe (how|why)|find the error)\b/i.test(q.question || '');

    if (isMcq) {
      const correctIdx = (q.options || []).findIndex(o => o.correct);
      const correctLetter = correctIdx >= 0 ? String.fromCharCode(65 + correctIdx) : '';
      answersMap[qId] = { answer: ansRaw, isNum: false, mcq: true, correctLetter };
    } else if (isActivity) {
      answersMap[qId] = { answer: ansRaw, isNum: false, activity: true };
    } else {
      answersMap[qId] = {
        answer: ansRaw, isNum: isNum && !isExplanatory, range: q.acceptRange || null,
        // No answer key at all → record it (a strict compare against "" could
        // never pass); unless it's a genuinely open prompt, the teacher reviews it.
        open: isOpenEnded || isExplanatory || !hasDefinedAnswer, theory: isTheory && !isExplanatory,
        alts: Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers.map(String) : [],
        review: !hasDefinedAnswer && (!!q.visualUnderstandingRequired || !isOpenEnded),
      };
    }
    return qId;
  }

  // ── Helper: render a number pyramid as clean CSS boxes (redrawn, not the scanned image) ──
  function renderPyramid(pyramid) {
    const rows = pyramid.rows || [];
    const solved = pyramid.solved || rows;
    const BOX = 64, GAP = 4;
    let inner = '';
    const nRows = rows.length;
    rows.forEach((row, r) => {
      const rowW = row.length * BOX + (row.length - 1) * GAP;
      const totalW = nRows * BOX + (nRows - 1) * GAP;
      const rowLeft = (totalW - rowW) / 2;
      const top = r * BOX;
      row.forEach((cell, c) => {
        const left = rowLeft + c * (BOX + GAP);
        const given = cell !== null && cell !== undefined && String(cell).trim() !== '';
        const trueVal = (solved[r] && solved[r][c] !== undefined) ? solved[r][c] : cell;
        if (given) {
          inner += `<div style="position:absolute;left:${left}px;top:${top}px;width:${BOX}px;height:${BOX}px;border:1.5px solid rgba(195,220,216,0.4);border-radius:6px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#F0EEEC;box-sizing:border-box;">${fmt(String(cell))}</div>`;
        } else {
          const qId = registerQuestion({ type: 'numeric', answer: trueVal });
          inner += `<input type="text" id="${qId}-input" class="q-input"${inputLangAttr} placeholder="?"
            style="position:absolute;left:${left}px;top:${top}px;width:${BOX}px;height:${BOX}px;
            border:1.5px dashed rgba(195,220,216,0.5);border-radius:6px;background:rgba(255,255,255,0.06);
            color:#F0EEEC;font-size:14px;font-weight:700;text-align:center;box-sizing:border-box;font-family:inherit;">`;
          inner += `<button class="mini-check" title="Check this box" onclick="checkOneGroup('${qId}')"
            style="position:absolute;left:${left + BOX - 20}px;top:${top + BOX - 20}px;width:18px;height:18px;z-index:2;
            border-radius:50%;border:none;background:#4a9d6e;color:#0F0F0F;font-size:11px;font-weight:900;
            line-height:18px;padding:0;cursor:pointer;">&#10003;</button>`;
        }
      });
    });
    const totalW = nRows * BOX + (nRows - 1) * GAP;
    const totalH = nRows * BOX;
    return `<div style="display:inline-block;text-align:left;margin:6px 22px 18px 0;vertical-align:top;">
      ${pyramid.label ? `<div style="font-size:14px;font-weight:700;color:#C3DCD8;margin-bottom:6px;">${fmt(pyramid.label)}</div>` : ''}
      <div style="position:relative;width:${totalW}px;height:${totalH}px;">${inner}</div>
    </div>`;
  }

  // ── Helper: wrap a diagram render (pyramid/diagramFill/etc.) in the same bordered
  // dark "q-card" look used by the Venn diagram, so every diagram task feels consistent. ──
  function renderDiagramCard({ label, instructions, innerHtml }) {
    return `<div class="q-card">
      ${label ? `<p class="q-text"><strong>${fmt(label)}</strong></p>` : ''}
      ${instructions ? `<p style="font-size:12px;color:#A8B5B3;margin:2px 0 12px;">${fmt(instructions)}</p>` : ''}
      ${innerHtml}
    </div>`;
  }

  // ── Helper: render a fill-in table (registers each blank cell for scoring) ──
  // Render the traditional school tally convention: groups of 4 upright strokes with a
  // diagonal 5th stroke crossing them, then loose strokes for the remainder. Typing a
  // number into a "Tally marks" box (what this used to do) means nothing to a student —
  // tally marks are a drawn notation, not text — so instead of asking them to type it,
  // we DRAW the real thing here as a reference, and let the "Frequency" column (a genuine
  // typed number) be the actual thing being tested.
  function renderTallyMarks(n) {
    // Extraction sometimes returns the tally column's answer as literal pipe
    // characters (e.g. "|||" or "| | | |") instead of a plain count — parseInt
    // on that yields NaN and nothing ever rendered. Count the pipes as a
    // fallback rather than assuming the value is always a clean number.
    let count = parseInt(n, 10);
    if (isNaN(count) && typeof n === 'string') {
      const pipes = (n.match(/\|/g) || []).length;
      if (pipes > 0) count = pipes;
    }
    n = count;
    if (isNaN(n) || n < 0) return '';
    const groups = Math.floor(n / 5), rem = n % 5;
    const groupW = 34, totalW = Math.max(groups * groupW + rem * 7 + 10, 30);
    let svg = `<svg viewBox="0 0 ${totalW} 36" style="width:auto;height:32px;max-width:100%;">`;
    let x = 4;
    for (let g = 0; g < groups; g++) {
      for (let i = 0; i < 4; i++) svg += `<line x1="${x + i * 7}" y1="4" x2="${x + i * 7}" y2="30" stroke="#F0EEEC" stroke-width="2.2" stroke-linecap="round"></line>`;
      svg += `<line x1="${x - 2}" y1="30" x2="${x + 3 * 7 + 2}" y2="4" stroke="#C5BD96" stroke-width="2.4" stroke-linecap="round"></line>`;
      x += groupW;
    }
    for (let i = 0; i < rem; i++) svg += `<line x1="${x + i * 7}" y1="4" x2="${x + i * 7}" y2="30" stroke="#F0EEEC" stroke-width="2.2" stroke-linecap="round"></line>`;
    svg += `</svg>`;
    return svg;
  }

  function renderTaskTable(table) {
    let h = '<div class="ws-table-wrap" style="overflow-x:auto;margin:8px 0 14px;">';
    if (table.title) h += `<div style="font-weight:700;color:#C3DCD8;margin-bottom:8px;">${fmt(String(table.title))}</div>`;
    const tallyColIdx = Array.isArray(table.headers) ? table.headers.findIndex(x => /tally/i.test(String(x || ''))) : -1;
    // The Frequency column's answer is a plain verified number; the Tally column's
    // own extracted answer is a hand-drawn-pipe STRING that can disagree with it
    // (e.g. tally="| | | |" but frequency="6") — draw the tally marks from the
    // frequency count instead of trusting the separately-extracted tally string.
    const freqColIdx = Array.isArray(table.headers) ? table.headers.findIndex(x => /frequency/i.test(String(x || ''))) : -1;
    if (tallyColIdx >= 0) {
      h += `<div style="margin:0 0 10px;padding:10px 14px;background:rgba(197,189,150,0.10);border-left:3px solid #C5BD96;border-radius:6px;font-size:12.5px;color:#D8E8E6;line-height:1.6;">
        In your notebook you draw the tally marks yourself: one line for each item, and the 5th line crosses the first four. Here the computer has already drawn them for you in the Tally marks column — you just need to COUNT the lines (every crossed bundle = 5, plus any loose lines) and write that total number in the Frequency box.
      </div>`;
    }
    h += '<table style="width:100%;border-collapse:collapse;">';
    if (Array.isArray(table.headers) && table.headers.length) {
      h += '<tr>' + table.headers.map(x =>
        `<th style="border:1px solid rgba(195,220,216,0.28);padding:10px 12px;background:rgba(147,176,172,0.14);color:#D8E8E6;font-size:13px;font-weight:700;text-align:center;">${fmt(String(x))}</th>`
      ).join('') + '</tr>';
    }
    for (const row of (table.rows || [])) {
      h += '<tr>';
      (row || []).forEach((cell, ci) => {
        if (ci === tallyColIdx) {
          // Display-only: draw the real tally marks from the verified Frequency
          // count for this row when available (falls back to the tally cell's own
          // answer only if there's no Frequency column at all). Not a checkable
          // question — the Frequency column is where the student's understanding is tested,
          // so this cell must NOT be registered (an unregistered cell can't ever block
          // "answer every question" from reaching 100%).
          const freqAnswer = freqColIdx >= 0 ? (row[freqColIdx] && row[freqColIdx].answer) : undefined;
          h += `<td style="border:1px solid rgba(195,220,216,0.18);padding:8px 12px;text-align:center;">${renderTallyMarks(freqAnswer ?? (cell && cell.answer))}</td>`;
          return;
        }
        if (cell && cell.input) {
          const isNumAns = /^\d+(\.\d+)?$/.test(String(cell.answer || '').trim());
          const qId = registerQuestion({ type: cell._qtype || (isNumAns ? 'numeric' : 'text'), answer: cell.answer });
          const hintText = cell.hint || '';
          h += `<td style="border:1px solid rgba(195,220,216,0.18);padding:8px;text-align:center;">
            <div style="display:flex;flex-direction:column;gap:6px;align-items:center;">
              <div style="display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;">
                <input type="text" id="${qId}-input" class="q-input"${inputLangAttr} style="width:100px;padding:6px 8px;font-size:14px;" placeholder="?">
                <button class="btn-check" style="padding:6px 12px;font-size:12px;" onclick="checkAnswer('${qId}')">Check</button>
                ${hintText ? `<button class="btn-hint" style="padding:6px 10px;font-size:12px;" onclick="toggleHint('${qId}')">Hint</button>` : ''}
              </div>
              ${hintText ? `<div id="${qId}-hint" class="hint-box" style="display:none;width:100%;box-sizing:border-box;margin-top:0;">${fmt(hintText)}</div>` : ''}
              <div id="${qId}-result" class="result-box"></div>
              <div id="${qId}-solution" class="solution-box" style="display:none;width:100%;box-sizing:border-box;margin-top:0;font-size:12px;padding:10px 12px;"><strong>&#9989; Solution</strong><br>${fmt(String(cell.answer ?? ''))}</div>
              <button id="${qId}-show" class="btn-show" style="display:none;font-size:11px;padding:4px 10px;" onclick="toggleSolution('${qId}')">Show Answer</button>
            </div>
          </td>`;
        } else {
          h += `<td style="border:1px solid rgba(195,220,216,0.18);padding:8px 12px;text-align:center;color:#F0EEEC;font-size:13px;">${fmt(String((cell && cell.text) || ''))}</td>`;
        }
      });
      h += '</tr>';
    }
    h += '</table>';
    h += '</div>';
    return h;
  }

  // ── Helper: render a match-the-following task as drag & drop (word chips → picture slots) ──
  function renderMatchingTask(task) {
    const questions = task.questions || [];
    const matchQs = questions.filter(q => q.type === 'mcq' && Array.isArray(q.options) && q.options.length >= 2);
    const rest = questions.filter(q => !matchQs.includes(q));
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    const qIds = matchQs.map(q => registerQuestion(q));
    const bankId = `${qIds[0]}-bank`;

    // Bank chips shuffled deterministically so their order never mirrors the picture order
    const bankWords = (task._wordBank && task._wordBank.length)
      ? task._wordBank.slice()
      : [...new Set(matchQs.map(q => String(q.answer ?? '').trim()).filter(Boolean))];
    let s = (bankWords.length * 2246822519 + qIds.length * 40503) >>> 0;
    for (let i = bankWords.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      [bankWords[i], bankWords[j]] = [bankWords[j], bankWords[i]];
    }

    let h = `<p style="font-size:13px;color:#A8B5B3;margin:0 0 10px;">Drag each word onto its matching picture &mdash; or tap a word, then tap a picture&rsquo;s box.</p>`;
    h += `<div class="match-bank" id="${bankId}">` + bankWords.map(w =>
      `<span class="match-chip" draggable="true" data-word="${esc(w)}" data-bank="${bankId}" ondragstart="mDragStart(event)" onclick="mChipClick(this)">${fmt(w)}</span>`).join('') + `</div>`;

    // If EVERY card would show the exact same image, the diagram extractor failed
    // to split the worksheet's picture column into individual crops and instead
    // gave every question the one uncropped strip (all N icons stacked). Rendering
    // that identical tall strip inside all N cards is visually broken and useless
    // for matching. Show it ONCE as a reference above the cards instead, and leave
    // the cards clean (they fall back to the question text as the match label).
    const cardImgs = matchQs.map(q => q.imageUrl).filter(Boolean);
    const allSameImage = cardImgs.length === matchQs.length && cardImgs.length >= 2 && new Set(cardImgs).size === 1;
    if (allSameImage) {
      h += `<div class="match-shared-ref" style="text-align:center;margin:0 0 14px;"><img class="wk-img" onerror="wkImgError(this)" src="${embedImage(cardImgs[0])}" alt="Pictures to match" style="max-height:360px;"><div style="font-size:12px;color:#A8B5B3;margin-top:4px;">Match each word to the correct picture above.</div></div>`;
    }

    h += `<div class="match-grid">`;
    matchQs.forEach((q, i) => {
      const qId = qIds[i];
      h += `<div class="match-card" id="${qId}-card">`;
      if (q.id) h += `<div class="match-card-label">${esc(q.id)})</div>`;
      if (q.imageUrl && !allSameImage) {
        h += `<div class="match-img"><img src="${embedImage(q.imageUrl)}" alt="${esc(q.diagramDescription || 'Picture to match')}" onerror="wkImgError(this)"></div>`;
      } else {
        // No cropped picture (or the only image is the shared strip shown above) —
        // fall back to the question text as the thing to match.
        h += `<div class="match-img match-img-text">${fmt(q.question || '')}</div>`;
      }
      h += `<div class="match-slot" id="${qId}-slot" ondragover="event.preventDefault()" ondrop="mDrop(event,'${qId}-slot')" onclick="mSlotClick(this)"><span class="match-slot-ph">Drop word here</span></div>`;
      h += `<div style="display:flex;gap:6px;align-items:center;justify-content:center;margin-top:6px;flex-wrap:wrap;">
        <button class="btn-check" style="padding:6px 12px;font-size:12px;" onclick="checkOneMatch('${qId}')">Check</button>
        ${q.hint ? `<button class="btn-hint" style="padding:6px 10px;font-size:12px;" onclick="toggleHint('${qId}')">Hint</button>` : ''}
      </div>`;
      if (q.hint) h += `<div id="${qId}-hint" class="hint-box" style="display:none;font-size:12px;">${fmt(q.hint)}</div>`;
      h += `<div id="${qId}-result" class="lang-result"></div>`;
      h += `<div id="${qId}-solution" class="solution-box" style="display:none;font-size:12px;"><strong>&#9989;</strong> ${fmt(String(q.answer ?? ''))}</div>`;
      h += `<button id="${qId}-show" class="btn-show" style="display:none;font-size:11px;" onclick="toggleSolution('${qId}')">Show Answer</button>`;
      h += `</div>`;
    });
    h += `</div>`;

    // Any non-matching questions in the same task render normally below
    for (const q of rest) {
      const qId = registerQuestion(q);
      h += renderQuestionCell(q, qId, false);
    }
    return h;
  }

  // ── Helper: render a single question cell (for table or card layout) ──
  function renderQuestionCell(q, qId, isTableCell = false) {
    // ── VENN DIAGRAM: interactive two-circle diagram with three fillable regions ──
    if (q.type === 'venn') {
      const leftLabel = q.leftLabel || 'Group A';
      const rightLabel = q.rightLabel || 'Group B';
      const baseTaStyle = 'position:absolute;box-sizing:border-box;resize:none;border:1.5px dashed rgba(195,220,216,0.5);border-radius:8px;background:rgba(255,255,255,0.06);color:#F0EEEC;font-size:13px;font-family:inherit;padding:6px 8px;text-align:center;';
      const ta = (rid, ph, pos) =>
        `<textarea id="${qId}-${rid}" class="venn-input" placeholder="${ph}" style="${baseTaStyle}${pos}"></textarea>`;
      const solutionHtml = fmtSolution(q.solution || '', { sentences: true });
      return `<div class="q-card" id="${qId}-card">
        <p class="q-text"><strong>${q.id ? q.id + ')' : 'Q' + qNum + '.'}</strong> ${fmtQuestion(q.question)}</p>
        <p style="font-size:12px;color:#A8B5B3;margin:2px 0 0;">Type items separated by commas — shared items go in the middle.</p>
        <div class="venn-wrap" style="position:relative;width:100%;max-width:580px;height:340px;margin:12px auto 8px;">
          <svg viewBox="0 0 580 340" style="position:absolute;inset:0;width:100%;height:100%;">
            <ellipse cx="210" cy="185" rx="165" ry="140" fill="rgba(147,176,172,0.12)" stroke="#93B0AC" stroke-width="2.5"></ellipse>
            <ellipse cx="370" cy="185" rx="165" ry="140" fill="rgba(197,189,150,0.12)" stroke="#C5BD96" stroke-width="2.5"></ellipse>
            <text x="150" y="34" text-anchor="middle" fill="#93B0AC" font-size="17" font-weight="700" font-family="Arial">${leftLabel}</text>
            <text x="430" y="34" text-anchor="middle" fill="#C5BD96" font-size="17" font-weight="700" font-family="Arial">${rightLabel}</text>
          </svg>
          ${ta('left', leftLabel + ' only', 'left:2%;top:34%;width:26%;height:120px;')}
          ${ta('center', 'Both', 'left:38%;top:40%;width:24%;height:110px;')}
          ${ta('right', rightLabel + ' only', 'right:2%;top:34%;width:26%;height:120px;')}
        </div>
        <div class="q-actions" style="display:flex;gap:10px;margin-top:10px;">
          <button class="btn-check" onclick="checkVenn('${qId}')">Check</button>
          <button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>
        </div>
        <div id="${qId}-hint" class="hint-box" style="display:none">${fmt(q.hint || '')}</div>
        <div id="${qId}-result" class="result-box"></div>
        <div id="${qId}-solution" class="solution-box" style="display:none"><strong>&#9989; Solution</strong><br>${solutionHtml}</div>
        <button id="${qId}-show" class="btn-show" style="display:none" onclick="toggleSolution('${qId}')">Show Answer</button>
      </div>`;
    }
    const qLabel = q.id && /^[a-z0-9]/i.test(q.id) && q.id.length <= 3 ? `${q.id})` : `Q${qNum}.`;
    const skipUnits = ['comparison', 'symbol', 'n/a', 'none', 'fraction', 'text', 'yes/no', 'explanation', 'activity'];
    const displayUnit = q.unit && !skipUnits.includes((q.unit || '').toLowerCase()) ? q.unit : '';
    const isActivity = q.type === 'activity' || (q.type === 'text' && /\b(draw|sketch|create|construct|design|colour|color|paste|cut)\b/i.test(q.question));
    const isMcq = q.type === 'mcq' && Array.isArray(q.options);

    // Extract the "blank" part from the question: "4 kg = ___ gm" → show "4 kg =" with input and "gm"
    const questionText = (q.question || '').replace(/___+/g, '').replace(/=\s*$/, '=').trim();

    let html = '';

    if (isTableCell) {
      // Worksheet-style table cell: compact, inline input
      html += `<div class="ws-cell" id="${qId}-card" style="padding:10px 14px;border-bottom:1px solid rgba(195,220,216,0.15);display:flex;flex-direction:column;align-items:flex-start;gap:8px;">`;
      html += `<span style="font-size:14px;color:#F0EEEC;"><strong style="color:#C3DCD8">${qLabel}</strong> ${fmtQuestion(questionText)}</span>`;

      if (q.imageUrl && !q._sharedImage) {
        html += `<div class="q-image" style="margin:4px 0 8px;align-self:center;max-width:100%;"><img class="wk-img" onerror="wkImgError(this)" src="${embedImage(q.imageUrl)}" alt="${escAttr(q.diagramDescription || 'Diagram')}" style="max-height:240px;"></div>`;
      }

      html += `<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">`;
      if (!isActivity && !isMcq) {
        html += `<input type="text" id="${qId}-input" class="q-input"${inputLangAttr} style="width:90px;padding:6px 8px;font-size:14px;" placeholder="?">`;
        if (displayUnit) html += `<span style="font-size:13px;color:#A8B5B3;">${displayUnit}</span>`;
        html += `<button class="btn-check" style="padding:6px 14px;font-size:12px;" onclick="checkAnswer('${qId}')">&#10003;</button>`;
        if (q.hint) html += `<button class="btn-hint" style="padding:6px 14px;font-size:12px;" onclick="toggleHint('${qId}')">Hint</button>`;
      } else if (isMcq) {
        html += `<div style="display:flex;gap:6px;flex-wrap:wrap;">`;
        html += q.options.map((opt, i) => {
          const letter = String.fromCharCode(65 + i);
          const label = typeof opt === 'string' ? opt : (opt.label || opt);
          return `<label style="font-size:13px;color:#F0EEEC;cursor:pointer;padding:4px 8px;border:1px solid rgba(195,220,216,0.2);border-radius:4px;"><input type="radio" name="${qId}" value="${letter}" style="margin-right:4px;"> ${label}</label>`;
        }).join('');
        html += `</div><button class="btn-check" style="padding:6px 14px;font-size:12px;" onclick="checkMCQ('${qId}')">&#10003;</button>`;
      } else {
        html += `<button class="btn-show" style="display:inline-block;padding:6px 14px;font-size:12px;" onclick="toggleSolution('${qId}'); if(!done.has('${qId}')){sc++;done.add('${qId}');} attempted.add('${qId}'); up();">Show</button>`;
      }
      html += `</div></div>`;
      // Feedback row (hidden by default, spans full width)
      const solutionHtml = fmtSolution(q.solution || '', { steps: true });
      html += `<div id="${qId}-hint" class="hint-box" style="display:none;margin:0 14px;font-size:13px;">${fmt(q.hint || '')}</div>`;
      html += `<div id="${qId}-result" class="result-box" style="margin:0 14px;"></div>`;
      html += `<div id="${qId}-solution" class="solution-box" style="display:none;margin:0 14px;font-size:13px;"><strong>&#9989;</strong> ${solutionHtml}</div>`;
      html += `<button id="${qId}-show" class="btn-show" style="display:none;margin:4px 14px;font-size:11px;" onclick="toggleSolution('${qId}')">Show Answer</button>`;
    } else if (isLanguageWorksheet) {
      // ── Language worksheet layout: clean, document-like ──
      // Mimics original worksheet: sentence + dotted-line answer fields, no "Answer ="
      html += `<div class="lang-q-row" id="${qId}-card">`;
      html += `<div class="lang-q-left">`;
      html += `<span class="lang-q-num">(${q.id || qNum})</span>`;
      html += `<span class="lang-q-text">${fmtQuestion(q.question)}</span>`;
      html += `</div>`;

      // This branch never rendered q.imageUrl at all — a picture-matching language
      // task (e.g. "match the picture to the Telugu word") would silently drop its
      // image even though it was correctly attached to the question data. The
      // math/science branch below already does this; language worksheets need it too.
      if (q.imageUrl && !q._sharedImage) {
        html += `<div class="q-image q-image-indent" style="margin:6px 0 10px 38px;"><img class="wk-img" onerror="wkImgError(this)" src="${embedImage(q.imageUrl)}" alt="${escAttr(q.diagramDescription || 'Worksheet picture')}" style="max-height:280px;margin:0;"></div>`;
      }

      if (q.example) {
        html += `<div class="lang-example">${fmt(q.example)}</div>`;
      }

      if (isMcq) {
        html += `<div class="lang-mcq-opts">`;
        html += q.options.map((opt, i) => {
          const letter = String.fromCharCode(65 + i);
          const label = typeof opt === 'string' ? opt : (opt.label || opt);
          return `<label class="lang-mcq-opt"><input type="radio" name="${qId}" value="${letter}"> ${fmt(label)}</label>`;
        }).join('');
        html += `<button class="lang-btn-check" onclick="checkMCQ('${qId}')">&#10003;</button>`;
        html += `</div>`;
      } else {
        // Language worksheets: ALWAYS show input field (even for activities/riddles)
        html += `<div class="lang-q-answer">`;
        html += `<input type="text" id="${qId}-input" class="lang-input"${inputLangAttr} placeholder="">`;
        html += `<div class="lang-q-actions">`;
        html += `<button class="lang-btn-check" onclick="checkAnswer('${qId}')">&#10003;</button>`;
        if (q.hint) html += `<button class="lang-btn-hint" onclick="toggleHint('${qId}')">?</button>`;
        html += `</div></div>`;
      }

      const solutionHtml = fmtSolution(q.solution || '');
      html += `
        <div id="${qId}-hint" class="hint-box" style="display:none;margin:4px 0 4px 36px;font-size:13px;">${fmt(q.hint || '')}</div>
        <div id="${qId}-result" class="lang-result"></div>
        <div id="${qId}-solution" class="solution-box" style="display:none;margin:4px 0 4px 36px;font-size:13px;"><strong>&#9989;</strong> ${solutionHtml}</div>
        <button id="${qId}-show" class="btn-show" style="display:none;margin:4px 36px;font-size:11px;" onclick="toggleSolution('${qId}')">Show Answer</button>
      </div>`;
    } else {
      // Card layout (existing style — math/science)
      html += `<div class="q-card" id="${qId}-card">
        <p class="q-text"><strong>${qLabel}</strong> ${fmtQuestion(q.question)}</p>`;

      // Show example if present
      if (q.example) {
        html += `<div style="margin:8px 0 12px;padding:10px 14px;background:rgba(195,220,216,0.07);border-left:3px solid rgba(195,220,216,0.4);border-radius:0 8px 8px 0;font-size:13px;color:#A8B5B3;font-style:italic;">${fmt(q.example)}</div>`;
      }

      // Vertical column arithmetic (e.g. "96_ - _83 ----- 162"): render as the
      // student would actually see it on the worksheet — a right-aligned digit
      // stack with the operator and a rule line — instead of flat run-on text
      // like "Calculate the missing digits: 9 6 _ - _ 8 3 ----- 1 6 2", which
      // students couldn't parse.
      // When solveVerticalMath() found a deterministic answer, blank cells
      // become individual single-digit <input> boxes (dedicated grading path,
      // see checkVerticalMath below) instead of just a static dash.
      const isVertMathSolvable = q.verticalMath && q.verticalMath.solvable;
      if (q.verticalMath && q.verticalMath.top && q.verticalMath.bottom) {
        const vm = q.verticalMath;
        const digitCell = (d, row, idx) => {
          const blank = d === '_' || d === '' || d == null;
          if (blank && isVertMathSolvable) {
            return `<input type="text" maxlength="1" inputmode="numeric" id="${qId}-vmb-${row}-${idx}" data-vm-row="${row}" data-vm-idx="${idx}" style="display:inline-block;width:1.1em;height:1.2em;text-align:center;font:inherit;color:inherit;background:rgba(197,189,150,0.12);border:none;border-bottom:2px solid #C5BD96;padding:0;">`;
          }
          return `<span style="display:inline-block;min-width:1.3em;text-align:center;${blank ? 'border-bottom:2px solid #C5BD96;color:#C5BD96;' : ''}">${blank ? '&nbsp;' : fmt(String(d))}</span>`;
        };
        const digitsRow = (s, row) => String(s).split('').map((d, idx) => digitCell(d, row, idx)).join('');
        const opSpacer = `<span style="display:inline-block;min-width:1.3em;text-align:center;">&nbsp;</span>`;
        const opCell = `<span style="display:inline-block;min-width:1.3em;text-align:center;color:#93B0AC;">${fmt(vm.operator || '-')}</span>`;
        html += `<div id="${qId}-vm-display" style="margin:4px 0 16px;font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#F0EEEC;display:inline-block;text-align:right;line-height:1.5;">
          <div>${opSpacer}${digitsRow(vm.top, 'top')}</div>
          <div>${opCell}${digitsRow(vm.bottom, 'bottom')}</div>
          <div style="border-top:2px solid #93B0AC;margin:2px 0;"></div>
          <div>${vm.result ? `${opSpacer}${digitsRow(vm.result, 'result')}` : ''}</div>
        </div>
        <div id="${qId}-vm-corrected" style="display:none;margin:4px 0 16px;font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#F0EEEC;text-align:right;line-height:1.5;"></div>`;
      }

      if (q.imageUrl && !q._sharedImage) {
        html += `<div class="q-image" style="margin:0 0 14px;"><img class="wk-img" onerror="wkImgError(this)" src="${embedImage(q.imageUrl)}" alt="${escAttr(q.diagramDescription || 'Worksheet diagram')}"></div>`;
      }

      if (isActivity) {
        html += `
        <div class="activity-box" style="margin:12px 0;padding:18px 20px;background:linear-gradient(135deg,rgba(147,176,172,0.08),rgba(197,189,150,0.08));border-radius:12px;border:1px solid rgba(147,176,172,0.25)">
          <p style="font-size:13px;color:#A8B5B3;margin:0 0 12px;line-height:1.5">This is a hands-on activity. Try it on paper!</p>
        </div>
        <div class="q-actions" style="display:flex;gap:10px;margin-top:10px">
          <button class="btn-show" style="display:inline-block" onclick="toggleSolution('${qId}'); if(!done.has('${qId}')){sc++;done.add('${qId}');} attempted.add('${qId}'); up();">Show Answer</button>
          ${q.hint ? `<button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>` : ''}
        </div>`;
      } else if (isVertMathSolvable) {
        // Dedicated validator (checkVerticalMath below) — reads the per-blank
        // digit inputs rendered above, not a single generic text box.
        html += `
        <div class="q-actions" style="display:flex;gap:10px;margin-top:10px">
          <button class="btn-check" onclick="checkVerticalMath('${qId}')">Check</button>
          ${q.hint ? `<button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>` : ''}
        </div>`;
      } else if (isMcq) {
        html += q.options.map((opt, i) => {
          const letter = String.fromCharCode(65 + i);
          const label = typeof opt === 'string' ? opt : (opt.label || opt);
          return `<label class="mcq-opt"><input type="radio" name="${qId}" value="${letter}"> ${fmt(label)}</label>`;
        }).join('');
        html += `
        <div class="q-actions" style="display:flex;gap:10px;margin-top:10px">
          <button class="btn-check" onclick="checkMCQ('${qId}')">Check</button>
          ${q.hint ? `<button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>` : ''}
        </div>`;
      } else {
        const labelText = smartLabel(q, displayUnit);
        const placeholder = smartPlaceholder(q, displayUnit);
        const isLong = q.type === 'long' || labelText === null;
        if (isLong) {
          html += `
        <div class="q-input-row" style="flex-direction:column;align-items:stretch;gap:10px;">
          <textarea id="${qId}-input" class="q-input"${inputLangAttr} rows="3" placeholder="Write your answer here..." style="width:100%;min-height:80px;resize:vertical;font-size:14px;padding:10px;border-radius:8px;border:1.5px solid rgba(195,220,216,0.3);background:rgba(255,255,255,0.05);color:#F0EEEC;font-family:inherit;"></textarea>
          <div style="display:flex;gap:10px;">
            <button class="btn-check" onclick="checkAnswer('${qId}')">Check</button>
            ${q.hint ? `<button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>` : ''}
          </div>
        </div>`;
        } else {
          html += `
        <div class="q-input-row">
          <span class="q-label">${labelText}</span>
          <input type="text" id="${qId}-input" class="q-input"${inputLangAttr} placeholder="${placeholder}">
          ${displayUnit ? `<span class="q-unit">${displayUnit}</span>` : ''}
          <button class="btn-check" onclick="checkAnswer('${qId}')">Check</button>
          ${q.hint ? `<button class="btn-hint" onclick="toggleHint('${qId}')">Hint</button>` : ''}
        </div>`;
        }
      }

      const solutionHtml = fmtSolution(q.solution || '', { steps: true, units: true });
      html += `
        <div id="${qId}-hint" class="hint-box" style="display:none">${fmt(q.hint || '')}</div>
        <div id="${qId}-result" class="result-box"></div>
        <div id="${qId}-solution" class="solution-box" style="display:none">
          <strong>&#9989; Solution</strong><br>${solutionHtml}
          ${q.acceptRange ? `<br><span style="font-size:12px;color:#666">(any answer ${q.acceptRange[0]}–${q.acceptRange[1]} is accepted)</span>` : ''}
        </div>
        <button id="${qId}-show" class="btn-show" style="display:none" onclick="toggleSolution('${qId}')">Show Answer</button>
      </div>`;
    }

    return html;
  }

  for (const task of (quiz.tasks || [])) {
    // Case-insensitive match: the prompt now preserves the worksheet's own
    // casing verbatim ("Must Do", not forced to "MUST DO"), so the lookup
    // must normalize before matching — otherwise the three common tiers
    // would ALSO wrongly fall through to the neutral style, breaking the
    // exact worksheets this styling was originally built for. The BADGE
    // TEXT still uses task.tier's original casing below, unchanged.
    const s = tierStyles[(task.tier || '').toUpperCase()] || tierStyles['DEFAULT'];
    // escapeHtml BEFORE the "Task N:" -> "Task N &middot;" replacement, since
    // that replacement itself injects a real HTML entity that must not be
    // re-escaped - found via a test asserting task.title (untrusted document
    // content) can't inject a <script> tag, which this line bypassed by not
    // going through fmt() at all.
    const taskTitle = escapeHtml(task.title || '').replace(/^(Task\s*\d+)\s*[:\.]\s*/i, '$1 &middot; ').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const layout = task.layout || { type: 'single-column', columns: 1 };
    const questions = task.questions || [];

    tasksHTML += `
    <div class="task-block" style="border-left:5px solid ${s.border}; background:${s.bg}; border-radius:12px; padding:20px 24px; margin:28px 0;">
      ${task.tier ? `<span class="tier-badge" style="display:inline-block;background:${s.labelBg};color:${s.label};font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;padding:4px 12px;border-radius:4px;margin-bottom:6px;">${task.tier}</span>` : ''}
      <h2 style="font-size:18px;color:${s.label};margin:6px 0 18px;font-weight:700;">${taskTitle}</h2>
      ${task.passage ? `<div style="margin:0 0 20px;padding:16px 20px;background:rgba(255,255,255,0.04);border:1px solid rgba(195,220,216,0.2);border-radius:10px;font-size:14px;color:#D8E8E6;line-height:1.8;">${fmt(task.passage)}</div>` : ''}
      ${task.example ? `<div class="task-example" style="margin:0 0 20px;padding:10px 14px;background:rgba(195,220,216,0.07);border-left:3px solid rgba(195,220,216,0.4);border-radius:0 8px 8px 0;font-size:13px;color:#A8B5B3;"><strong style="color:#C3DCD8;">Example:</strong> ${fmtQuestion(task.example)}</div>` : ''}`;

    // ── MATCH-THE-FOLLOWING: drag & drop words onto pictures (replaces per-question rendering) ──
    if (task._matchTask) {
      tasksHTML += renderMatchingTask(task);
      tasksHTML += `</div>`;
      continue;
    }

    // ── BAR GRAPH / CHART: render structured chart as inline SVG (all questions refer to it) ──
    if (task.chart && Array.isArray(task.chart.bars) && task.chart.bars.length) {
      tasksHTML += renderBarChart(task.chart);
    }

    // ── NUMBER PYRAMIDS: redrawn as clean CSS boxes (not the scanned image), wrapped in
    //    the same bordered q-card look as the Venn diagram for visual consistency. ──
    if (Array.isArray(task.pyramids) && task.pyramids.length) {
      const pyramidsHtml = task.pyramids.map(p => renderPyramid(p)).join('');
      tasksHTML += renderDiagramCard({
        instructions: 'Fill in each blank, then tap its check mark — every pair of adjacent blocks sums to the block above it.',
        innerHtml: `<div>${pyramidsHtml}</div>`
      });
    }

    // ── DIAGRAM-FILL OVERLAY: worksheet image + input fields placed directly on each
    //    detected blank (pyramid blocks, clock cells, number-line ticks, labeled figures —
    //    ANY diagram, without a bespoke renderer per shape). The image never changes; only
    //    the inputs are positioned by percentage, so it's responsive. ──
    if (task.diagramFillBlanks && task.diagramFillBlanks.length && task.diagramFillImageUrl) {
      const dfIds = task.diagramFillBlanks.map(b => registerQuestion({ type: /^-?\d+(\.\d+)?$/.test(String(b.answer).trim()) ? 'numeric' : 'text', answer: b.answer }));
      const inputsHtml = task.diagramFillBlanks.map((b, i) => {
        const left = (b.x * 100).toFixed(2), top = (b.y * 100).toFixed(2);
        const w = (b.w * 100).toFixed(2), h = (b.h * 100).toFixed(2);
        return `<input type="text" id="${dfIds[i]}-input" class="q-input df-input"${inputLangAttr}
          style="position:absolute;left:${left}%;top:${top}%;width:${w}%;height:${h}%;box-sizing:border-box;
          padding:2px 4px;font-size:13px;text-align:center;border:1.5px dashed rgba(195,220,216,0.5);
          border-radius:6px;background:rgba(28,28,28,0.82);color:#F0EEEC;font-weight:700;font-family:inherit;">`
          + `<button class="mini-check" title="Check this box" onclick="checkOneGroup('${dfIds[i]}')"
          style="position:absolute;left:calc(${left}% + ${w}% - 16px);top:calc(${top}% + ${h}% - 16px);width:16px;height:16px;z-index:2;
          border-radius:50%;border:none;background:#4a9d6e;color:#0F0F0F;font-size:10px;font-weight:900;
          line-height:16px;padding:0;cursor:pointer;">&#10003;</button>`;
      }).join('');
      tasksHTML += renderDiagramCard({
        instructions: 'Write your answers directly on the diagram below, then tap each check mark.',
        innerHtml: `<div class="diagram-fill-wrap" style="position:relative;display:inline-block;max-width:100%;background:#fff;border-radius:8px;border:1px solid rgba(195,220,216,0.2);padding:10px;">
          <img src="${embedImage(task.diagramFillImageUrl)}" alt="${escAttr(task.sharedImageDescription || 'Worksheet diagram')}" style="display:block;max-width:100%;height:auto;border-radius:4px;" onerror="wkImgError(this)">
          ${inputsHtml}
        </div>`
      });
    } else
    // ── SHARED IMAGE: show one diagram for the entire task (all questions reference it) ──
    if (task.sharedImage) {
      // Only ever show a real cropped diagram (questions[0].imageUrl) — never task.pageImageUrl,
      // which is the entire scanned worksheet page (other tasks, header info, etc.). Showing the
      // whole page instead of the specific diagram is confusing and wrong for every worksheet,
      // not just this one — if no crop was extracted, fall through to the text-description path.
      const sharedUrl = questions[0] && questions[0].imageUrl;
      if (sharedUrl) {
        // Shown once for the task — don't repeat it on every question that carries the same URL.
        questions.forEach(q => { if (q.imageUrl === sharedUrl) q._sharedImage = true; });
        tasksHTML += `<div style="margin:0 0 16px;"><img class="wk-img" onerror="wkImgError(this)" src="${embedImage(sharedUrl)}" alt="${escAttr(task.sharedImageDescription || 'Worksheet diagram')}" style="max-height:360px;"></div>`;
      } else if (task.sharedImageDescription) {
        // Fallback: render branching/tree diagrams as HTML when image extraction missed them
        const desc = task.sharedImageDescription || '';
        let trees = [];

        // If description mentions "branch", try to build tree from QUESTION DATA
        // (more reliable than parsing LLM descriptions which vary each time)
        if (/branch/i.test(desc) && questions.length >= 2) {
          // Strategy 1: Group by question ID (e.g., id="మీద" → root from question text first word)
          // In Telugu worksheets: question="చెట్టు మీద __", id="మీద" → root="చెట్టు", branch="మీద"
          const rootMapFromQ = {};
          for (const q of questions) {
            const qText = String(q.question || '').trim();
            const qId = String(q.id || '').trim();
            // Try extracting root as first word of question text
            const firstWord = qText.split(/\s+/)[0];
            const secondWord = qText.split(/\s+/)[1] || '';
            if (firstWord && secondWord && qId) {
              if (!rootMapFromQ[firstWord]) rootMapFromQ[firstWord] = [];
              // Use id as branch label (cleaner), avoid duplicates
              if (!rootMapFromQ[firstWord].includes(qId)) {
                rootMapFromQ[firstWord].push(qId);
              }
            }
          }
          const rootsFromQ = Object.keys(rootMapFromQ).filter(r => rootMapFromQ[r].length >= 1);
          if (rootsFromQ.length >= 2 || (rootsFromQ.length === 1 && rootMapFromQ[rootsFromQ[0]].length >= 2)) {
            trees = rootsFromQ.map(r => ({ root: r, branches: rootMapFromQ[r] }));
          }

          // Strategy 2: Group by answer — each unique answer is a tree root
          if (trees.length === 0) {
            const rootMap = {};
            for (const q of questions) {
              const ans = String(q.answer || '').trim();
              const qText = String(q.question || q.id || '').trim();
              if (ans && qText && ans !== qText) {
                if (!rootMap[ans]) rootMap[ans] = [];
                rootMap[ans].push(qText);
              }
            }
            const roots = Object.keys(rootMap).filter(r => rootMap[r].length >= 1);
            if (roots.length >= 2 || (roots.length === 1 && rootMap[roots[0]].length >= 2)) {
              trees = roots.map(r => ({ root: r, branches: rootMap[r] }));
            }
          }
        }

        // Fallback: try regex patterns on the description text
        if (trees.length === 0) {
          let bm;
          // Pattern A: "'చెట్టు' branching to 'మీద' and 'కింద'"
          const patA = /[''']([^''']+)[''']\s*branch(?:ing|es)?\s*to\s*[''']([^''']+)['''](?:\s*(?:and|,)\s*[''']([^''']+)['''])?/gi;
          while ((bm = patA.exec(desc)) !== null) {
            trees.push({ root: bm[1], branches: [bm[2], bm[3]].filter(Boolean) });
          }
          // Pattern B: "'మీద' and 'కింద' branch from 'చెట్టు'"
          if (trees.length === 0) {
            const patB = /[''']([^''']+)['''](?:\s*(?:and|,)\s*[''']([^''']+)['''])?\s*branch(?:es)?\s*from\s*[''']([^''']+)[''']/gi;
            while ((bm = patB.exec(desc)) !== null) {
              trees.push({ root: bm[3], branches: [bm[1], bm[2]].filter(Boolean) });
            }
          }
          // Pattern C: "'చెట్టు' with branches labeled 'మీద' and 'కింద'"
          if (trees.length === 0) {
            const patC = /[''']([^''']+)[''']\s*(?:\([^)]*\)\s*)?with\s*branches?\s*(?:labeled\s*)?[''']([^''']+)['''](?:\s*(?:\([^)]*\)\s*)?(?:and|,)\s*[''']([^''']+)['''])?/gi;
            while ((bm = patC.exec(desc)) !== null) {
              trees.push({ root: bm[1], branches: [bm[2], bm[3]].filter(Boolean) });
            }
          }
        }
        if (trees.length > 0) {
          tasksHTML += `<div class="branch-diagram" style="display:flex;gap:40px;justify-content:center;margin:16px 0 20px;flex-wrap:wrap;">`;
          for (const tree of trees) {
            tasksHTML += `<div class="branch-tree" style="display:flex;align-items:center;gap:12px;">`;
            tasksHTML += `<span style="font-size:17px;font-weight:700;color:#C3DCD8;">${tree.root}</span>`;
            tasksHTML += `<div style="display:flex;flex-direction:column;gap:0;position:relative;">`;
            // Draw bracket/brace
            tasksHTML += `<div style="position:absolute;left:-8px;top:4px;bottom:4px;width:8px;border-left:2px solid #93B0AC;border-top:2px solid #93B0AC;border-bottom:2px solid #93B0AC;border-radius:4px 0 0 4px;"></div>`;
            for (const b of tree.branches) {
              const branchQId = `branch_${qNum}_${b.replace(/\s/g,'')}`;
              tasksHTML += `<div style="padding:6px 0 6px 12px;font-size:15px;color:#F0EEEC;display:flex;align-items:center;gap:8px;">${b} <input type="text" class="lang-input"${inputLangAttr} style="flex:1;max-width:200px;" placeholder=""></div>`;
            }
            tasksHTML += `</div></div>`;
          }
          tasksHTML += `</div>`;
        } else {
          // Generic fallback: show description as a styled note
          tasksHTML += `<div style="margin:0 0 16px;padding:12px 16px;background:rgba(195,220,216,0.06);border:1px dashed rgba(195,220,216,0.25);border-radius:8px;font-size:13px;color:#A8B5B3;text-align:center;font-style:italic;">📐 ${fmt(desc)}</div>`;
        }
      }
    }

    // ── Missing-crop fallback: never dump the raw scanned worksheet page here — it contains
    // every other task, headers, and unrelated content on that page, not just this diagram.
    // (This was the exact bug: a question flagged hasImage with no extracted crop was falling
    // back to task.pageImageUrl, the full page.) Show a plain note instead, for every worksheet.
    const anyQuestionNeedsImage = questions.some(q => q.hasImage && !q.imageUrl);
    if (anyQuestionNeedsImage && task.pageImageUrl) {
      tasksHTML += `<div style="margin:0 0 16px;padding:10px 14px;background:rgba(195,220,216,0.06);border:1px dashed rgba(195,220,216,0.25);border-radius:8px;font-size:12px;color:#A8B5B3;">Diagram for this task could not be auto-cropped from the worksheet.</div>`;
    }

    // ── TABLES (one or more per task: data grids + fill-in tally/frequency) ──
    const taskTables = (Array.isArray(task.tables) && task.tables.length)
      ? task.tables
      : (task.table && Array.isArray(task.table.rows) && task.table.rows.length ? [task.table] : []);
    const hasInputTable = taskTables.some(t => (t.rows || []).some(r => (r || []).some(c => c && c.input)));

    if (taskTables.length) {
      for (const tbl of taskTables) {
        if (tbl && Array.isArray(tbl.rows) && tbl.rows.length) tasksHTML += renderTaskTable(tbl);
      }
    }

    // If an interactive (input) table represents the questions, skip re-rendering them.
    if (hasInputTable) {
      // questions are covered by the fill-in table above
    } else
    // ── TWO-COLUMN TABLE LAYOUT (matches worksheet) ──
    if (layout.type === 'two-column' && layout.columnGroups && layout.columnGroups.length >= 2) {
      const colGroups = layout.columnGroups;
      const questionsById = {};
      for (const q of questions) { questionsById[q.id] = q; }

      const leftIds = colGroups[0].questionIds || [];
      const rightIds = colGroups[1].questionIds || [];
      const leftQuestions = leftIds.map(id => questionsById[id]).filter(Boolean);
      const rightQuestions = rightIds.map(id => questionsById[id]).filter(Boolean);
      const maxRows = Math.max(leftQuestions.length, rightQuestions.length);

      // Register all questions
      const leftQIds = leftQuestions.map(q => registerQuestion(q));
      const rightQIds = rightQuestions.map(q => registerQuestion(q));

      tasksHTML += `<table class="ws-table" style="width:100%;border-collapse:collapse;border:1px solid rgba(195,220,216,0.2);border-radius:8px;overflow:hidden;">`;

      // Question rows
      for (let r = 0; r < maxRows; r++) {
        tasksHTML += `<tr>`;
        // Left cell
        tasksHTML += `<td style="width:50%;vertical-align:top;border:1px solid rgba(195,220,216,0.15);">`;
        if (r < leftQuestions.length) {
          tasksHTML += renderQuestionCell(leftQuestions[r], leftQIds[r], true);
        }
        tasksHTML += `</td>`;
        // Right cell
        tasksHTML += `<td style="width:50%;vertical-align:top;border:1px solid rgba(195,220,216,0.15);">`;
        if (r < rightQuestions.length) {
          tasksHTML += renderQuestionCell(rightQuestions[r], rightQIds[r], true);
        }
        tasksHTML += `</td>`;
        tasksHTML += `</tr>`;
      }

      tasksHTML += `</table>`;

    } else {
      // ── SINGLE-COLUMN / CARD LAYOUT (default) ──
      for (const q of questions) {
        const qId = registerQuestion(q);
        tasksHTML += renderQuestionCell(q, qId, false);
      }
    }

    tasksHTML += `</div>`;
  }

  // Concept cards — Aivorah themed
  let conceptsHTML = '';
  if (quiz.concepts?.length) {
    conceptsHTML = `<div class="concepts-row">` +
      quiz.concepts.map((c, i) => {
        const cc = conceptCardColors[i % conceptCardColors.length];
        return `
        <div class="concept-card" style="background:${cc}18;border:1px solid ${cc}40">
          <div class="concept-icon" style="color:${cc}">${getConceptIcon(c.term)}</div>
          <h3 style="color:${cc}">${c.term}</h3>
          <p>${c.definition}</p>
          ${c.unit && c.unit !== 'N/A' ? `<p class="concept-unit">Measured in<br><strong style="color:#C3DCD8">${c.unit}</strong></p>` : ''}
        </div>`;
      }).join('') +
      `</div>`;
  }

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${quiz.title || 'Quiz'} - Aivorah</title>
  <script>
    // A picture that can't load (expired/legacy URL) shows a note, not a broken-image icon.
    function wkImgError(img) {
      var note = document.createElement('div');
      note.className = 'wk-img-missing';
      note.textContent = 'Picture unavailable' + (img.alt ? ': ' + img.alt : '');
      img.replaceWith(note);
    }
  </script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, 'Noto Sans Telugu', 'Noto Sans Devanagari', 'Noto Sans Tamil', 'Noto Sans Kannada', 'Noto Sans Malayalam', 'Noto Sans Bengali', 'Noto Sans Gujarati', 'Noto Sans Gurmukhi', 'Noto Sans Oriya', 'Noto Naskh Arabic', 'Noto Sans CJK SC', Helvetica, Arial, sans-serif; background: #0F0F0F; color: #F0EEEC; line-height: 1.6; }

    /* ── Header — Aivorah Enchanted Forest ── */
    /* Matches the page's own background (#0F0F0F) instead of a lighter gradient box —
       when there's no school/curriculum logo to show, the header used to read as a
       separate, visually disconnected dark rectangle sitting on top of the page rather
       than blending into it. */
    .header { background: #0F0F0F; color: #F0EEEC; padding: 14px 110px 14px 40px; position: relative; border-bottom: 1px solid rgba(195,220,216,0.12); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; min-height: 60px; }
    /* flex-grow MUST stay 0 here — giving header-text grow:1 (equal to
       header-logos) let it fight header-logos for free space, which pushed the
       logos off the true center between title and score (the regression seen
       with a short title like "Mathematics Activity Sheet" leaving the logos
       sitting right-of-center instead of centered in the remaining gap). Only
       flex-shrink + a basis are needed for wrapping on narrow/split screens. */
    .header-text { text-align: left; flex: 0 1 260px; min-width: 0; }
    .header-text h1 { overflow-wrap: anywhere; }
    .header-sub { font-size: 13px; color: #5A6B69; margin-bottom: 2px; }
    .header h1 { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; color: #C3DCD8; margin: 0; }
    .header-meta { font-size: 13px; color: #5A6B69; margin-top: 2px; }
    /* Centered in the space BETWEEN the title text and the score badge, not the
       header box's raw 50% mark — the box has asymmetric padding (extra room on
       the right for the score circle), so centering on the box itself always
       skewed the logos off the true visual center. */
    .header-logos { flex: 1 1 auto; display: flex; gap: 16px; align-items: center;
                     justify-content: center; min-width: 0; }
    .header-logos img { height: 55px; width: auto; max-width: 100%; object-fit: contain; display: block; }

    /* Compact / split-screen: the fixed-height logos used to collide with a long
       title (they don't shrink), so the row overlapped. Below these widths the
       header wraps the logos onto their own centered line and scales them down so
       nothing overlaps the title or the score badge. */
    @media (max-width: 820px) {
      .header { padding: 14px 96px 14px 20px; }
      .header-logos { flex-basis: 100%; order: 3; justify-content: center; margin-top: 6px; }
      .header-logos img { height: 42px; }
    }
    @media (max-width: 520px) {
      .header-logos img { height: 34px; }
      .header h1 { font-size: 20px; }
    }

    /* ── Score Badge — anchored to the header itself, not the viewport ── */
    .score { position: absolute; top: 50%; right: 24px; transform: translateY(-50%); width: 76px; height: 76px; border-radius: 50%;
             background: linear-gradient(135deg, #93B0AC, #7AADA8); color: #0F0F0F;
             display: flex; flex-direction: column; align-items: center; justify-content: center;
             box-shadow: 0 4px 20px rgba(147,176,172,0.3); z-index: 100; }
    .score-num { font-size: 22px; font-weight: 800; line-height: 1; }
    .score-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-top: 2px; }

    /* ── Progress ── */
    .progress-wrap { padding: 20px 0 4px; }
    .progress-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #5A6B69; margin-bottom: 8px; }
    .progress-bar { background: #252525; border-radius: 6px; height: 12px; overflow: hidden; border: 1px solid rgba(195,220,216,0.08); }
    .progress-fill { background: linear-gradient(90deg, #93B0AC, #C3DCD8); height: 100%; border-radius: 6px; transition: width 0.6s ease; }
    .progress-pct { text-align: right; font-size: 12px; color: #93B0AC; font-weight: 600; margin-top: 4px; }

    /* ── Container ── */
    .container { max-width: 960px; margin: 0 auto; padding: 0 24px 60px; }

    /* ── Concepts ── */
    .concepts-row { display: flex; gap: 16px; margin: 24px 0; flex-wrap: wrap; }
    .concept-card { flex: 1; min-width: 220px; padding: 20px; border-radius: 12px; color: #F0EEEC; }
    .concept-card h3 { font-size: 18px; font-weight: 800; margin-bottom: 6px; }
    .concept-card p { font-size: 13px; color: #A8B5B3; line-height: 1.5; }
    .concept-unit { margin-top: 8px; font-size: 12px; color: #5A6B69; }
    .concept-icon { font-size: 20px; margin-bottom: 6px; }

    /* ── Question cards ── */
    .q-card { background: #1C1C1C; padding: 20px 24px; border-radius: 10px; margin: 14px 0;
              box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 1px solid rgba(195,220,216,0.12); }
    .q-text { font-size: 15px; color: #F0EEEC; margin-bottom: 14px; line-height: 1.6; }
    .q-text strong { color: #C3DCD8; }
    .frac { display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; line-height: 1.15; margin: 0 2px; }
    .frac > span:first-child { border-bottom: 1.5px solid currentColor; padding: 0 3px; }

    /* ── Input row ── */
    .q-input-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
    .q-label { font-weight: 700; font-size: 14px; color: #A8B5B3; }
    .q-input { width: 130px; padding: 10px 12px; border: 2px solid rgba(195,220,216,0.25); border-radius: 8px;
               font-size: 16px; text-align: center; transition: border-color 0.2s; background: #252525; color: #F0EEEC; }
    .q-input:focus { border-color: #93B0AC; outline: none; box-shadow: 0 0 0 3px rgba(147,176,172,0.2); }
    .q-unit { font-size: 14px; color: #A8B5B3; font-weight: 500; }

    /* ── MCQ ── */
    .mcq-opt { display: block; margin: 8px 0; padding: 10px 14px; border-radius: 8px;
               border: 1.5px solid rgba(195,220,216,0.15); cursor: pointer; font-size: 14px; color: #F0EEEC; transition: all 0.2s; }
    .mcq-opt:hover { background: rgba(147,176,172,0.1); border-color: #93B0AC; }
    .mcq-opt input { margin-right: 8px; }

    /* ── Buttons ── */
    .btn-check { background: #93B0AC; color: #0F0F0F; border: none; padding: 10px 24px; border-radius: 8px;
                 font-weight: 700; font-size: 14px; cursor: pointer; transition: all 0.2s; }
    .btn-check:hover { background: #7AADA8; transform: translateY(-1px); }
    .mini-check:hover { transform: scale(1.15); }
    .btn-hint { background: #C5BD96; color: #0F0F0F; border: none; padding: 10px 20px; border-radius: 8px;
                font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s; }
    .btn-hint:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn-show { background: #93B0AC; color: #0F0F0F; border: none; padding: 8px 18px; border-radius: 6px;
                font-weight: 600; font-size: 13px; cursor: pointer; margin-top: 10px; }
    .btn-show:hover { background: #7AADA8; }

    /* ── Feedback boxes ── */
    .hint-box { margin-top: 12px; padding: 14px 16px; background: rgba(197,189,150,0.1); border-radius: 8px;
                border-left: 4px solid #C5BD96; color: #C5BD96; font-size: 14px; line-height: 1.5; }
    .result-box { margin-top: 8px; font-size: 14px; min-height: 6px; }
    .solution-box { margin-top: 12px; padding: 16px 18px; background: rgba(74,157,110,0.14); border-radius: 8px;
                    border-left: 4px solid #4a9d6e; color: #4a9d6e; font-size: 14px; line-height: 1.7; }

    /* ── Activity boxes ── */
    .activity-box { background: linear-gradient(135deg, rgba(147,176,172,0.08), rgba(197,189,150,0.08)) !important;
                    border-color: rgba(147,176,172,0.25) !important; }

    /* ── Language worksheet layout (Telugu, Hindi, etc.) ── */
    .lang-q-row { padding: 16px 20px 12px; margin: 6px 0; border-bottom: 1px solid rgba(195,220,216,0.08); }
    .lang-q-left { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
    .lang-q-num { font-size: 15px; color: #93B0AC; font-weight: 700; flex-shrink: 0; min-width: 28px; }
    .lang-q-text { font-size: 16px; color: #F0EEEC; line-height: 1.8; }
    .lang-q-text strong { color: #C3DCD8; }
    .lang-example { margin: 4px 0 10px 38px; padding: 8px 14px; background: rgba(195,220,216,0.05);
                    border-left: 3px solid rgba(195,220,216,0.3); border-radius: 0 6px 6px 0;
                    font-size: 14px; color: #A8B5B3; font-style: italic; }
    .lang-q-answer { display: flex; align-items: center; gap: 12px; margin-left: 38px; flex-wrap: wrap; }
    .lang-input { flex: 1; max-width: 280px; padding: 8px 4px; font-size: 16px; color: #F0EEEC;
                  background: transparent; border: none; border-bottom: 2px dotted rgba(195,220,216,0.35);
                  outline: none; font-family: inherit; transition: border-color 0.2s; }
    .lang-input:focus { border-bottom-color: #93B0AC; border-bottom-style: solid; }
    .lang-input::placeholder { color: transparent; }
    .lang-q-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .lang-btn-check { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid rgba(147,176,172,0.4);
                      background: transparent; color: #93B0AC; font-size: 14px; cursor: pointer;
                      display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .lang-btn-check:hover { background: rgba(147,176,172,0.15); border-color: #93B0AC; }
    /* Match-the-following drag & drop */
    .match-bank { display:flex; flex-wrap:wrap; gap:10px; padding:14px; margin:4px 0 18px; background:rgba(147,176,172,0.07);
      border:1.5px dashed rgba(147,176,172,0.35); border-radius:10px; min-height:52px; }
    .match-chip { display:inline-block; padding:8px 18px; background:#2A2F2E; color:#F0EEEC; border:1.5px solid rgba(147,176,172,0.5);
      border-radius:24px; font-size:15px; font-weight:600; cursor:grab; user-select:none; transition:transform .12s, box-shadow .12s, border-color .12s; }
    .match-chip:hover { transform:translateY(-1px); box-shadow:0 2px 8px rgba(0,0,0,0.35); border-color:#93B0AC; }
    .match-chip.sel { outline:2px solid #C5BD96; background:rgba(197,189,150,0.15); }
    .match-grid { display:flex; flex-wrap:wrap; gap:16px; }
    .match-card { flex:1 1 170px; max-width:220px; background:rgba(255,255,255,0.03); border:1px solid rgba(195,220,216,0.18);
      border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; align-items:center; }
    .match-card-label { align-self:flex-start; font-size:12px; font-weight:700; color:#93B0AC; }
    .match-img { background:#fff; border-radius:8px; padding:6px; width:100%; text-align:center; }
    .match-img img { max-width:100%; height:auto; max-height:130px; object-fit:contain; border-radius:4px; }
    /* Worksheet pictures: natural size up to the card width, never stretched or cropped. */
    .wk-img { display:block; box-sizing:border-box; width:auto; height:auto; max-width:100%; max-height:420px;
      object-fit:contain; margin:0 auto; background:#fff; padding:8px; border-radius:8px; border:1px solid rgba(195,220,216,0.2); }
    .wk-img-missing { font-size:12px; color:#A8B5B3; padding:8px 12px; border:1px dashed rgba(195,220,216,0.25); border-radius:8px; }
    @media (max-width: 520px) { .q-image-indent { margin-left:0 !important; } }
    .match-img-text { background:rgba(255,255,255,0.05); color:#F0EEEC; font-size:13px; padding:12px; }
    .match-slot { width:100%; min-height:46px; border:1.5px dashed rgba(195,220,216,0.45); border-radius:10px; display:flex;
      align-items:center; justify-content:center; padding:4px; cursor:pointer; transition:border-color .15s, background .15s; }
    .match-slot-ph { font-size:12px; color:#7c8a88; pointer-events:none; }
    .match-slot.filled .match-slot-ph { display:none; }
    .match-slot.m-ok { border-style:solid; border-color:#4a9d6e; background:rgba(74,157,110,0.18); }
    .match-slot.m-bad { border-style:solid; border-color:#c9605f; background:rgba(201,96,95,0.14); }
    .lang-btn-hint { width: 30px; height: 30px; border-radius: 50%; border: 1.5px solid rgba(197,189,150,0.4);
                     background: transparent; color: #C5BD96; font-size: 14px; font-weight: 700; cursor: pointer;
                     display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .lang-btn-hint:hover { background: rgba(197,189,150,0.1); border-color: #C5BD96; }
    .lang-result { margin: 4px 0 0 38px; font-size: 14px; min-height: 4px; }
    .lang-mcq-opts { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 4px 38px; align-items: center; }
    .lang-mcq-opt { font-size: 14px; color: #F0EEEC; cursor: pointer; padding: 6px 12px;
                    border: 1px solid rgba(195,220,216,0.2); border-radius: 6px; transition: all 0.2s; }
    .lang-mcq-opt:hover { background: rgba(147,176,172,0.1); border-color: #93B0AC; }
    .lang-mcq-opt input { margin-right: 6px; }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      .header { padding: 12px 76px 12px 16px; }
      .header h1 { font-size: 20px; }
      .header-logos img { height: 40px; }
      .container { padding: 0 14px 40px; }
      .q-card { padding: 16px; }
      .lang-q-row { padding: 12px 14px 10px; }
      .lang-q-answer { margin-left: 28px; }
      .lang-result { margin-left: 28px; }
      .lang-example { margin-left: 28px; }
      .score { width: 60px; height: 60px; right: 12px; }
      .score-num { font-size: 18px; }
      .concepts-row { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-text">
      <div class="header-sub">${quiz.school || 'Aivorah'} &middot; ${quiz.grade || ''}</div>
      <h1>${fmt(quiz.title || 'Interactive Quiz')}</h1>
      <div class="header-meta">Subject: ${quiz.subject || 'Mathematics'} &nbsp;|&nbsp; Powered by Aivorah</div>
    </div>
    ${(branding.schoolLogoUrl || branding.curriculumLogoUrl) ? `<div class="header-logos">
      ${branding.schoolLogoUrl ? `<img src="${branding.schoolLogoUrl}" alt="School logo">` : ''}
      ${branding.curriculumLogoUrl ? `<img src="${branding.curriculumLogoUrl}" alt="Curriculum logo">` : ''}
    </div>` : ''}
    <div class="score" id="score-badge">
      <span class="score-num" id="score-num">0/${qNum}</span>
      <span class="score-label">Score</span>
    </div>
  </div>

  <div class="container">
    <div class="progress-wrap">
      <div class="progress-title">Quiz Progress</div>
      <div class="progress-bar"><div class="progress-fill" id="pf" style="width:0%"></div></div>
      <div class="progress-pct" id="pp">0% complete</div>
    </div>

    ${(quiz.purpose || quiz.learningOutcomes?.length) ? `<div style="background:rgba(197,165,106,0.08);border:1px solid rgba(197,165,106,0.25);border-radius:10px;padding:16px 20px;margin:16px 0;">
      <h3 style="font-size:14px;color:#C5A56A;margin-bottom:8px;font-weight:700;">&#127919; Learning Outcome</h3>
      ${quiz.purpose ? `<p style="font-size:14px;color:#D8C79A;line-height:1.5;margin:0 0 8px;"><strong>Purpose:</strong> ${fmt(quiz.purpose)}</p>` : ''}
      ${quiz.learningOutcomes?.length ? `<ul style="margin:0;padding-left:20px;">${quiz.learningOutcomes.map(o => `<li style="font-size:14px;color:#D8C79A;margin:4px 0;">${fmt(o)}</li>`).join('')}</ul>` : ''}
    </div>` : ''}
    ${conceptsHTML}
    ${quiz.notes ? `<div style="background:rgba(147,176,172,0.08);border:1px solid rgba(147,176,172,0.2);border-radius:10px;padding:16px 20px;margin:16px 0;">
      <h3 style="font-size:14px;color:#93B0AC;margin-bottom:6px;font-weight:700;">&#128221; Note</h3>
      <p style="font-size:14px;color:#A8B5B3;line-height:1.5;">${fmt(quiz.notes)}</p>
    </div>` : ''}
    ${quiz.successCriteria?.length ? `<div style="background:rgba(147,176,172,0.08);border:1px solid rgba(147,176,172,0.2);border-radius:10px;padding:16px 20px;margin:16px 0;">
      <h3 style="font-size:14px;color:#93B0AC;margin-bottom:8px;font-weight:700;">&#127919; Success Criteria</h3>
      <ul style="margin:0;padding-left:20px;">${quiz.successCriteria.map(c => `<li style="font-size:14px;color:#A8B5B3;margin:4px 0;">${fmt(c)}</li>`).join('')}</ul>
    </div>` : ''}
    ${quiz.wordBank?.length ? `<div style="background:rgba(197,165,106,0.08);border:1px solid rgba(197,165,106,0.25);border-radius:10px;padding:16px 20px;margin:16px 0;">
      <h3 style="font-size:14px;color:#D8C79A;margin-bottom:10px;font-weight:700;">&#128218; Word Bank</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">${quiz.wordBank.map(w => `<span style="background:rgba(197,165,106,0.15);border:1px solid rgba(197,165,106,0.35);border-radius:20px;padding:5px 14px;font-size:13px;color:#D8C79A;font-weight:600;">${fmt(w)}</span>`).join('')}</div>
    </div>` : ''}
    ${tasksHTML}
    ${quiz.checklist?.length ? `<div style="background:rgba(147,176,172,0.08);border:1px solid rgba(147,176,172,0.2);border-radius:10px;padding:16px 20px;margin:16px 0;">
      <h3 style="font-size:14px;color:#93B0AC;margin-bottom:10px;font-weight:700;">&#9989; Learners' Checklist</h3>
      ${quiz.checklist.map((c, i) => `<label style="display:flex;align-items:flex-start;gap:10px;font-size:14px;color:#A8B5B3;margin:8px 0;cursor:pointer;"><input type="checkbox" id="checklist-${i}" style="margin-top:3px;width:16px;height:16px;flex-shrink:0;"><span>${fmt(c)}</span></label>`).join('')}
    </div>` : ''}
    ${quiz.credits ? `<div style="text-align:center;font-size:12px;color:#6b7280;margin:20px 0 0;">${fmt(quiz.credits)}</div>` : ''}
  </div>

  <script>
    // Absolute assignments-service origin baked in at render time — the student
    // app shows this page in a blob:/srcdoc iframe whose own origin is the
    // frontend host (it has no /quiz routes), so relative calls never worked.
    const API_BASE = ${JSON.stringify(String(apiBase || '').replace(/\/+$/, '')).replace(/</g, '\\u003c')} || (function() {
      try {
        if (location.protocol === 'http:' || location.protocol === 'https:') return '';
        if (location.ancestorOrigins && location.ancestorOrigins.length) return location.ancestorOrigins[0];
        if (document.referrer) return new URL(document.referrer).origin;
      } catch (e) {}
      return '';
    })();
    // Answer checks shared with the server (utils/answerCheck.js).
    ${dominantScript.toString()}
    ${requiredScript.toString()}
    ${isWrongScript.toString()}
    ${normalizeAnswer.toString()}
    ${matchesAnyAnswer.toString()}
    const WORKSHEET_SCRIPT = ${JSON.stringify(worksheetScript)};
    const SCRIPT_NAMES = { Devanagari: 'Hindi (Devanagari)', Han: 'Chinese', Kana: 'Japanese', Hangul: 'Korean', Oriya: 'Odia', Gurmukhi: 'Punjabi (Gurmukhi)' };
    // Server feedback text → safe HTML (escaped, **bold** kept).
    function fmt(t) {
      return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/[*][*](.+?)[*][*]/g, '<strong>$1</strong>');
    }
    function keysOf(a) { return [a.answer].concat(a.alts || []).filter(function(x) { return x != null && String(x).trim(); }).map(String); }
    let sc = 0;
    const tot = ${qNum};
    const done = new Set(); // questions answered CORRECTLY (drives score credit)
    // Questions ATTEMPTED at least once, right or wrong — drives the progress bar and
    // whether "Submit Assignment" unlocks. Submission must depend on the student having
    // answered every question, NOT on getting every question right — those are different
    // things, and gating submission on a perfect score blocked students who tried
    // everything but got some wrong from ever handing the assignment in.
    const attempted = new Set();
    const answers = ${JSON.stringify(answersMap)};
    const studentAnswers = {}; // { qId: { answer, correct, timeSpent } }
    const questionStartTimes = {}; // { qId: timestamp }

    // ── Effort-based credit: full marks for a clean first-attempt correct answer,
    // half marks if a Hint was used along the way, zero if the student had to
    // reveal the Show Answer before getting it right (that's reading, not solving). ──
    const hintUsed = new Set();
    const revealed = new Set();
    const semanticCredit = new Map(); // qId -> fraction, set when Tier 2 grading returns "partial"
    function creditFor(id) {
      if (revealed.has(id)) return 0;
      const base = hintUsed.has(id) ? 0.5 : 1;
      return semanticCredit.has(id) ? Math.min(base, semanticCredit.get(id)) : base;
    }

    // ── Theory/short-factual answer matching — compares meaningful keywords instead
    // of literal strings, so word order and filler words don't cause a false "wrong".
    // Pure client-side, no network call, no AI dependency. ──
    const STOPWORDS = new Set(['a','an','the','is','was','it','of','in','to','and','or','on','at','for','with','this','that','be','been','were','are','as','by','from']);
    function keywordSet(s) {
      return new Set(
        String(s).normalize('NFC').toLowerCase().replace(/[^\\p{L}\\p{M}\\p{N}\\s]/gu, ' ').split(/\\s+/)
          .filter(function(w) { return w.length > 0 && !STOPWORDS.has(w); })
      );
    }
    function keywordMatch(studentAnswer, correctAnswer) {
      // Many "theory" answers are auto-generated as a full multi-sentence
      // JUSTIFICATION ("New height will be 20. It will reach closer to the football
      // bar. The football bar is at 16, so the difference is 4. The hockey bar is
      // at 12, so the difference is 8...") when the question itself only asks for a
      // choice/short fact ("...closer to the football bar or the hockey bar?"). A
      // student who correctly answers "football" was never asked to reproduce the
      // reasoning — but matching keywords against the WHOLE narrative demands they
      // do (14 keywords → 7 required, "football" only overlaps 1). The decisive
      // conclusion almost always lives in the first sentence or two; later
      // sentences explain/compare and often mention the REJECTED alternative too
      // (here, "hockey"), so pulling keywords from the whole thing also risks
      // marking a WRONG short answer correct just because it names something
      // discussed later in the justification. Limiting the keyword pool to the
      // first couple of sentences fixes both problems at once.
      const sentences = correctAnswer.split(/(?<=[.!?])\\s+/).filter(Boolean);
      const answerSource = sentences.length > 2 ? sentences.slice(0, 2).join(' ') : correctAnswer;
      // Bare numbers (e.g. an intermediate computed value like "20" restated inside
      // "20, closer to football") are narrative filler, not something a student must
      // retype to prove correct reasoning — a purely numeric answer already goes
      // through the isNum exact-match path, so any stray digit token reaching HERE is
      // incidental. Drop it, otherwise a correct short answer ("football") gets
      // penalized for not repeating a number the question never asked for.
      const stripNums = (set) => new Set(Array.from(set).filter(function(w) { return !/^\\d+$/.test(w); }));
      const expected = Array.from(stripNums(keywordSet(answerSource)));
      if (expected.length === 0) return true; // nothing meaningful to check against
      const studentSet = stripNums(keywordSet(studentAnswer));
      const matched = expected.filter(function(w) { return studentSet.has(w); }).length;
      // Short answers (≤3 meaningful words, e.g. "rugby and badminton") still need
      // majority overlap for real discrimination. Anything longer than that — even
      // after narrowing to the first couple of sentences — is asking more than a
      // short answer box should require verbatim, so a single genuine keyword
      // overlap (already scoped to the decisive sentences, so "hockey" can't sneak
      // in from the justification) is accepted. A stricter near-100% threshold
      // marked genuinely correct short answers wrong; a lower bar costs a rare
      // false positive, which is a far smaller problem live than telling a student
      // their right answer is wrong.
      //
      // Require just ONE genuine keyword overlap, uniformly. The old
      // "ceil(len*0.5) for lists ≤3" rule was NON-MONOTONIC — a 3-keyword answer
      // demanded 2 matches while 2-keyword AND 4+-keyword answers needed only 1,
      // so "market" (1 of 2) passed but "production" (1 of 3) failed for the same
      // one-word effort. One valid keyword now passes at every list length.
      const required = 1;
      return matched >= required;
    }

    // Track when each question becomes visible / gets focus
    document.addEventListener('focusin', function(e) {
      const inp = e.target.closest('input');
      if (inp && inp.id && inp.id.endsWith('-input')) {
        const qId = inp.id.replace('-input', '');
        if (!questionStartTimes[qId]) questionStartTimes[qId] = Date.now();
      }
    });

    function up() {
      document.getElementById('score-num').textContent = (sc % 1 === 0 ? sc : sc.toFixed(1)) + '/' + tot;
      // Progress bar tracks how many questions have been attempted — completion, not correctness.
      const donePct = Math.round((attempted.size / tot) * 100);
      document.getElementById('pf').style.width = donePct + '%';
      document.getElementById('pp').textContent = donePct + '% complete';
      // Score percentage — what actually gets saved as the assignment's grade — reflects
      // effort-weighted credit (full/half/zero per question), not just attempt count.
      const scorePct = Math.round((sc / tot) * 100);
      // Build per-question answer list
      const answersArr = Object.entries(studentAnswers).map(([qId, data]) => ({
        // NFC so the same word typed on different keyboards/IMEs is stored identically.
        qId, answer: typeof data.answer === 'string' ? data.answer.normalize('NFC') : data.answer, correct: data.correct,
        timeSpent: data.timeSpent || 0,
        question: data.question || ''
      }));
      // Report score + answers to the host — web (iframe, window.parent) and
      // native (react-native-webview, which only accepts a stringified message
      // via a different bridge object) need different delivery mechanisms.
      // "correct" is a partial-credit SCORE (0 for revealed, 0.5 for hinted, 1 for
      // clean), not a count of how many questions have been checked — a host UI
      // showing "correct/total" as if it were "answered/total" undercounts and
      // confuses the student into thinking questions are still outstanding even
      // after they've checked every one. "attemptedCount" is the real signal for
      // how many have actually been checked so far.
      const scoreMsg = { type: 'quiz-score', correct: sc, total: tot, pct: scorePct, completed: attempted.size === tot, attemptedCount: attempted.size, answers: answersArr };
      try { window.parent.postMessage(scoreMsg, '*'); } catch(e) {}
      try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(scoreMsg)); } catch(e) {}
    }

    async function checkAnswer(id) {
      const a = answers[id];
      if (!a) return;
      const inp = document.getElementById(id + '-input');
      const val = inp.value.trim();
      if (!val) { inp.style.borderColor = '#C5BD96'; return; }
      const r = document.getElementById(id + '-result');
      // Wrong writing system (e.g. Tamil typed on a Telugu worksheet) is never
      // accepted — not even on open questions with no answer key.
      if (!a.isNum && isWrongScript(val, a.answer == null ? '' : String(a.answer), WORKSHEET_SCRIPT)) {
        const need = requiredScript(a.answer == null ? '' : String(a.answer), WORKSHEET_SCRIPT);
        r.innerHTML = '<span style="color:#c9605f;font-weight:700">Please write your answer in ' + (SCRIPT_NAMES[need] || need) + '.</span>';
        inp.style.borderColor = '#c9605f';
        inp.style.background = 'rgba(201,96,95,0.10)';
        return;
      }
      // Open-ended (reflection) questions have no single correct text — any written
      // response counts as answered, so completion isn't blocked waiting for an exact match.
      if (a.open) {
        const elapsedOpen = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
        studentAnswers[id] = { answer: val, correct: true, timeSpent: elapsedOpen, question: '', needsReview: !!a.review };
        attempted.add(id);
        r.innerHTML = a.review
          ? '<span style="color:#C5BD96;font-weight:700">&#10004; Answer recorded — your teacher will check it</span>'
          : '<span style="color:#4a9d6e;font-weight:700">&#10004; Answer recorded</span>';
        inp.style.borderColor = '#4a9d6e';
        inp.style.background = 'rgba(74,157,110,0.14)';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        const openSol = document.getElementById(id + '-solution');
        if (openSol) openSol.style.display = 'block';
        up();
        return;
      }
      // Theory/short-factual answers (multi-word, a real correct answer exists but the
      // student's phrasing won't line up with it exactly). Two tiers:
      // Tier 1 — instant, free, client-side KEYWORD overlap. Catches most valid
      // paraphrases immediately with zero network call.
      // Tier 2 — only when Tier 1 says "wrong": one small server-side semantic
      // check (Groq text model, not vision) that judges MEANING, so a
      // synonym-only rewrite with no shared root words ("Chlorophyll converts
      // solar energy into glucose" for an expected answer about sunlight/food)
      // isn't wrongly marked incorrect just because the words don't overlap.
      if (a.theory) {
        // Exact answer (any accepted wording) always counts. Keyword overlap is an
        // English-paraphrase heuristic: for Telugu/Hindi… spelling IS the exercise
        // ("rewrite with the correct ottu"), so those go straight to the exact
        // check and then the server.
        const latinKey = dominantScript(String(a.answer)) === 'Latin';
        const okTh = matchesAnyAnswer(val, keysOf(a)) || (latinKey && keywordMatch(val, String(a.answer)));
        const elapsedTh = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
        if (okTh) {
          studentAnswers[id] = { answer: val, correct: true, timeSpent: elapsedTh, question: '' };
          attempted.add(id);
          r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct!</span>';
          inp.style.borderColor = '#4a9d6e';
          inp.style.background = 'rgba(74,157,110,0.14)';
          if (!done.has(id)) { sc += creditFor(id); done.add(id); }
          const sol = document.getElementById(id + '-solution');
          if (sol) sol.style.display = 'block';
          up();
          return;
        }
        // Tier 1 says wrong — ask Tier 2 before finalizing, in case it's a
        // valid (or partially valid) paraphrase Tier 1's keyword overlap
        // couldn't recognize. Three-way verdict: correct / partial / incorrect.
        r.innerHTML = '<span style="color:#A8B5B3;font-weight:600">Checking...</span>';
        let semanticResult = { verdict: 'incorrect', reason: '' };
        try {
          const qEl0 = document.getElementById(id + '-card');
          const qText0 = qEl0 ? (qEl0.querySelector('.q-label, strong')?.textContent || '') : '';
          const gRes = await fetch(API_BASE + '/quiz/grade-answer', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected: String(a.answer), student: val, question: qText0, acceptableAnswers: a.alts || [], worksheetScript: WORKSHEET_SCRIPT }),
          });
          if (gRes.ok) semanticResult = await gRes.json();
        } catch (e) { /* network hiccup — fall back to Tier 1's "wrong" */ }
        const verdict = semanticResult.verdict || 'incorrect';
        studentAnswers[id] = { answer: val, correct: verdict !== 'incorrect', partial: verdict === 'partial', timeSpent: elapsedTh, question: '' };
        attempted.add(id);
        if (verdict === 'correct') {
          r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct!</span>' + (semanticResult.reason ? '<div style="font-size:12px;color:#A8B5B3;margin-top:4px;">' + fmt(semanticResult.reason) + '</div>' : '');
          inp.style.borderColor = '#4a9d6e';
          inp.style.background = 'rgba(74,157,110,0.14)';
          if (!done.has(id)) { sc += creditFor(id); done.add(id); }
          const sol = document.getElementById(id + '-solution');
          if (sol) sol.style.display = 'block';
        } else if (verdict === 'partial') {
          r.innerHTML = '<span style="color:#C5BD96;font-weight:700">&#9679; Partially Correct</span>' + (semanticResult.reason ? '<div style="font-size:12px;color:#A8B5B3;margin-top:4px;">' + fmt(semanticResult.reason) + '</div>' : '');
          inp.style.borderColor = '#C5BD96';
          inp.style.background = 'rgba(197,189,150,0.14)';
          if (!done.has(id)) { semanticCredit.set(id, 0.5); sc += creditFor(id); done.add(id); }
          const sol2 = document.getElementById(id + '-solution');
          if (sol2) sol2.style.display = 'block';
        } else {
          r.innerHTML = '<span style="color:#c9605f;font-weight:700">Not quite. Try again!</span>' + (semanticResult.reason ? '<div style="font-size:12px;color:#A8B5B3;margin-top:4px;">' + fmt(semanticResult.reason) + '</div>' : '');
          inp.style.borderColor = '#c9605f';
          const sh = document.getElementById(id + '-show');
          if (sh) sh.style.display = 'inline-block';
        }
        up();
        return;
      }
      let ok = false;
      if (a.isNum) {
        const v = parseFloat(val);
        if (isNaN(v)) { inp.style.borderColor = '#C5BD96'; return; }
        ok = a.range ? (v >= a.range[0] && v <= a.range[1]) : Math.abs(v - a.answer) < 0.01;
      } else {
        ok = matchesAnyAnswer(val, keysOf(a));
      }
      // Track student answer + time
      const elapsed = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
      const qEl = document.getElementById(id + '-card');
      const qText = qEl ? qEl.querySelector('.q-label, strong')?.textContent || '' : '';
      studentAnswers[id] = { answer: val, correct: ok, timeSpent: elapsed, question: qText };
      attempted.add(id);
      if (ok) {
        r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct!</span>';
        inp.style.borderColor = '#4a9d6e';
        inp.style.background = 'rgba(74,157,110,0.14)';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        document.getElementById(id + '-solution').style.display = 'block';
      } else {
        r.innerHTML = '<span style="color:#c9605f;font-weight:700">Not quite. Try again!</span>';
        inp.style.borderColor = '#c9605f';
        document.getElementById(id + '-show').style.display = 'inline-block';
      }
      up();
    }

    // ── Dedicated validator for missing-digit vertical arithmetic ──
    // Each blank is its own <input> (rendered by digitCell in the server
    // template as id="<qId>-vmb-<row>-<index>"). This function:
    //   1) checks EACH blank digit independently against the deterministically
    //      solved correct digit (not a single flattened string comparison),
    //   2) reconstructs the full top/bottom/result from the student's digits
    //      and independently re-verifies the arithmetic itself (top ± bottom
    //      === result) as a cross-check — so correctness never rests on trusting
    //      the per-digit compare alone,
    //   3) on a wrong answer, re-renders the same vertical column layout with
    //      the correct digits highlighted (not plain text) plus the
    //      step-by-step borrow/carry working already computed server-side.
    function checkVerticalMath(id) {
      const a = answers[id];
      if (!a || !a.vertMath) return;
      const r = document.getElementById(id + '-result');
      const blanks = a.vmBlanks || [];
      let allFilled = true;
      const studentDigits = {}; // "row-idx" -> digit typed
      for (const bl of blanks) {
        const inp = document.getElementById(id + '-vmb-' + bl.row + '-' + bl.index);
        const v = inp ? inp.value.trim() : '';
        if (!/^[0-9]$/.test(v)) { allFilled = false; if (inp) inp.style.borderColor = '#C5BD96'; continue; }
        studentDigits[bl.row + '-' + bl.index] = v;
      }
      if (!allFilled) return;

      // Reconstruct the full strings the student effectively entered.
      const reconstruct = (correctStr, row) => correctStr.split('').map((d, idx) =>
        studentDigits[row + '-' + idx] !== undefined ? studentDigits[row + '-' + idx] : d
      ).join('');
      const studentTop = reconstruct(a.vmTop, 'top');
      const studentBottom = reconstruct(a.vmBottom, 'bottom');
      const studentResult = reconstruct(a.vmResult, 'result');

      // Per-blank check.
      let allDigitsCorrect = true;
      for (const bl of blanks) {
        const typed = studentDigits[bl.row + '-' + bl.index];
        const inp = document.getElementById(id + '-vmb-' + bl.row + '-' + bl.index);
        const correct = typed === bl.digit;
        if (!correct) allDigitsCorrect = false;
        if (inp) {
          inp.style.borderColor = correct ? '#4a9d6e' : '#c9605f';
          inp.style.background = correct ? 'rgba(74,157,110,0.14)' : 'rgba(201,96,95,0.14)';
        }
      }

      // Independent mathematical cross-check — never trust the digit compare alone.
      const tN = parseInt(studentTop, 10), bN = parseInt(studentBottom, 10), rN = parseInt(studentResult, 10);
      const arithmeticOk = a.vmOperator === '+' ? (tN + bN === rN) : (tN - bN === rN);

      const ok = allDigitsCorrect && arithmeticOk;
      const elapsedVm = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
      studentAnswers[id] = { answer: studentTop + ' ' + a.vmOperator + ' ' + studentBottom + ' = ' + studentResult, correct: ok, timeSpent: elapsedVm, question: '' };
      attempted.add(id);

      if (ok) {
        r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct!</span>';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        const sol = document.getElementById(id + '-solution');
        if (sol) sol.style.display = 'block';
      } else {
        r.innerHTML = '<span style="color:#c9605f;font-weight:700">Not quite — check the highlighted digit(s).</span>';
        // Show the completed, correct working in the same vertical layout,
        // with each corrected digit highlighted — not plain text.
        const correctedRow = (s, row) => s.split('').map((d, idx) => {
          const wasBlank = blanks.some(function(bl) { return bl.row === row && bl.index === idx; });
          const style = wasBlank
            ? 'display:inline-block;min-width:1.3em;text-align:center;background:rgba(74,157,110,0.22);color:#4a9d6e;border-radius:3px;'
            : 'display:inline-block;min-width:1.3em;text-align:center;';
          return '<span style="' + style + '">' + d + '</span>';
        }).join('');
        const opSp = '<span style="display:inline-block;min-width:1.3em;text-align:center;">&nbsp;</span>';
        const opC = '<span style="display:inline-block;min-width:1.3em;text-align:center;color:#93B0AC;">' + (a.vmOperator || '-') + '</span>';
        const corrected = document.getElementById(id + '-vm-corrected');
        if (corrected) {
          corrected.innerHTML =
            '<div style="font-size:12px;color:#93B0AC;font-family:inherit;font-weight:600;margin-bottom:4px;">Corrected working:</div>' +
            '<div>' + opSp + correctedRow(a.vmTop, 'top') + '</div>' +
            '<div>' + opC + correctedRow(a.vmBottom, 'bottom') + '</div>' +
            '<div style="border-top:2px solid #93B0AC;margin:2px 0;"></div>' +
            '<div>' + opSp + correctedRow(a.vmResult, 'result') + '</div>';
          corrected.style.display = 'block';
        }
        const stepsHtml = (a.vmSteps || []).map(function(s) { return '<li>' + fmt(s) + '</li>'; }).join('');
        const sol = document.getElementById(id + '-solution');
        if (sol) {
          sol.innerHTML = '<strong>&#9989; Step-by-step:</strong><ol style="margin:6px 0 0 18px;padding:0;">' + stepsHtml + '</ol>';
          sol.style.display = 'block';
        }
        const sh = document.getElementById(id + '-show');
        if (sh) sh.style.display = 'none'; // solution is already shown inline above
      }
      up();
    }

    function checkMCQ(id) {
      const a = answers[id];
      if (!a) return;
      const sel = document.querySelector('input[name="' + id + '"]:checked');
      if (!sel) return;
      const r = document.getElementById(id + '-result');
      const ok = sel.value === a.correctLetter;
      // Track student answer + time
      const elapsed = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
      studentAnswers[id] = { answer: sel.value, correct: ok, timeSpent: elapsed, question: '' };
      attempted.add(id);
      if (ok) {
        r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct!</span>';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        document.getElementById(id + '-solution').style.display = 'block';
      } else {
        r.innerHTML = '<span style="color:#c9605f;font-weight:700">Not quite. Try again!</span>';
        document.getElementById(id + '-show').style.display = 'inline-block';
      }
      up();
    }

    // ── Drag & drop matching ──
    let mDragChip = null, mSelChip = null;
    function mDragStart(e) {
      mDragChip = e.target;
      try { e.dataTransfer.setData('text/plain', e.target.dataset.word); } catch (err) {}
    }
    function mDrop(e, slotId) {
      e.preventDefault();
      const slot = document.getElementById(slotId);
      if (mDragChip) mPlace(slot, mDragChip);
      mDragChip = null;
    }
    function mChipClick(chip) {
      // Chip sitting in a slot → send it back to the bank
      if (chip.parentElement.classList.contains('match-slot')) { mReturn(chip); return; }
      if (mSelChip === chip) { chip.classList.remove('sel'); mSelChip = null; return; }
      if (mSelChip) mSelChip.classList.remove('sel');
      mSelChip = chip; chip.classList.add('sel');
    }
    function mSlotClick(slot) {
      if (!slot.classList.contains('match-slot')) slot = slot.closest('.match-slot');
      if (!slot) return;
      if (mSelChip) { mSelChip.classList.remove('sel'); mPlace(slot, mSelChip); mSelChip = null; }
    }
    function mPlace(slot, chip) {
      if (!slot || !chip) return;
      const existing = slot.querySelector('.match-chip');
      if (existing) mReturn(existing);
      slot.appendChild(chip);
      slot.classList.add('filled');
      slot.classList.remove('m-ok', 'm-bad');
    }
    function mReturn(chip) {
      const slot = chip.parentElement;
      const bank = document.getElementById(chip.dataset.bank);
      if (bank) bank.appendChild(chip);
      if (slot && slot.classList) slot.classList.remove('filled', 'm-ok', 'm-bad');
    }
    function checkOneMatch(id) {
      const a = answers[id];
      const slot = document.getElementById(id + '-slot');
      const r = document.getElementById(id + '-result');
      const chip = slot ? slot.querySelector('.match-chip') : null;
      if (!a || !slot) return;
      if (!chip) { if (r) r.innerHTML = '<span style="color:#C5BD96;font-size:12px;">Place a word first</span>'; return; }
      const val = chip.dataset.word;
      const ok = String(val).normalize('NFC').replace(/\\s+/g, '').toLowerCase() === String(a.answer).normalize('NFC').replace(/\\s+/g, '').toLowerCase();
      studentAnswers[id] = { answer: val, correct: ok, timeSpent: 0, question: '' };
      attempted.add(id);
      if (ok) {
        slot.classList.add('m-ok'); slot.classList.remove('m-bad');
        if (r) r.innerHTML = '<span style="color:#4a9d6e;font-weight:700;font-size:12px;">&#10004; Correct!</span>';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        const sol = document.getElementById(id + '-solution');
        if (sol) sol.style.display = 'block';
      } else {
        slot.classList.add('m-bad'); slot.classList.remove('m-ok');
        if (r) r.innerHTML = '<span style="color:#c9605f;font-size:12px;">Not quite. Try again!</span>';
        const sh = document.getElementById(id + '-show');
        if (sh) sh.style.display = 'inline-block';
      }
      up();
    }

    function checkVenn(id) {
      const a = answers[id];
      if (!a || !a.venn) return;
      // Open-ended Venn (student chose their own data — no fixed correct answer):
      // accept whatever they filled in, same as open-ended text questions.
      if (a.open) {
        var anyFilledOpen = false;
        ['left','center','right'].forEach(function(rg) {
          var inp = document.getElementById(id + '-' + rg);
          if (inp && inp.value.trim()) anyFilledOpen = true;
          if (inp) { inp.style.borderColor = '#4a9d6e'; inp.style.background = 'rgba(74,157,110,0.14)'; }
        });
        if (!anyFilledOpen) return;
        var rOpen = document.getElementById(id + '-result');
        var elapsedOpen2 = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
        studentAnswers[id] = { answer: 'completed', correct: true, timeSpent: elapsedOpen2, question: 'Venn diagram' };
        attempted.add(id);
        rOpen.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Answer recorded</span>';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        up();
        return;
      }
      function normItems(s) {
        return String(s || '').replace(/\\band\\b/gi, ',').split(/[,;\\n]/)
          .map(function(x){ return x.normalize('NFC').trim().toLowerCase(); }).filter(Boolean).sort();
      }
      // Near-match, not exact-set-equality: a long "multiples of N" list (12-15 items)
      // where the student gets all-but-one right shouldn't fail the whole region red —
      // that's the same all-or-nothing problem the theory-answer keyword match already
      // solves elsewhere. Require ~80% recall (most correct items present) AND ~80%
      // precision (not padding with extra/wrong items) so partial credit is fair without
      // letting a student just paste a huge range of numbers to fish for a match.
      function setEq(typed, correct) {
        if (correct.length === 0) return typed.length === 0;
        var matched = typed.filter(function(t) { return correct.indexOf(t) !== -1; }).length;
        var recall = matched / correct.length;
        var precision = typed.length ? matched / typed.length : 0;
        return recall >= 0.8 && precision >= 0.8;
      }
      var regions = ['left', 'center', 'right'];
      var allOk = true, anyFilled = false, snapshot = [];
      regions.forEach(function(rg) {
        var inp = document.getElementById(id + '-' + rg);
        if (!inp) return;
        var val = normItems(inp.value);
        if (val.length) anyFilled = true;
        var correct = normItems((a.answers[rg] || []).join(','));
        var ok = setEq(val, correct);
        inp.style.borderColor = ok ? '#4a9d6e' : '#c9605f';
        inp.style.background = ok ? 'rgba(74,157,110,0.14)' : 'rgba(201,96,95,0.10)';
        if (!ok) allOk = false;
        snapshot.push(rg + ': ' + inp.value.trim());
      });
      if (!anyFilled) return;
      var r = document.getElementById(id + '-result');
      var elapsed = questionStartTimes[id] ? Math.round((Date.now() - questionStartTimes[id]) / 1000) : 0;
      studentAnswers[id] = { answer: snapshot.join(' | '), correct: allOk, timeSpent: elapsed, question: 'Venn diagram' };
      attempted.add(id);
      if (allOk) {
        r.innerHTML = '<span style="color:#4a9d6e;font-weight:700">&#10004; Correct! Every region is right.</span>';
        if (!done.has(id)) { sc += creditFor(id); done.add(id); }
        document.getElementById(id + '-solution').style.display = 'block';
      } else {
        r.innerHTML = '<span style="color:#c9605f;font-weight:700">Not quite — green boxes are right, red boxes need another look.</span>';
        var sh = document.getElementById(id + '-show');
        if (sh) sh.style.display = 'inline-block';
      }
      up();
    }

    function checkOneGroup(id) {
      var a = answers[id];
      var inp = document.getElementById(id + '-input');
      if (!a || !inp) return;
      var val = inp.value.trim();
      if (!val) return;
      var ok;
      if (a.isNum) {
        var v = parseFloat(val);
        ok = !isNaN(v) && (a.range ? (v >= a.range[0] && v <= a.range[1]) : Math.abs(v - a.answer) < 0.01);
      } else {
        ok = matchesAnyAnswer(val, [String(a.answer)]);
      }
      inp.style.borderColor = ok ? '#4a9d6e' : '#c9605f';
      inp.style.background = ok ? 'rgba(74,157,110,0.14)' : 'rgba(201,96,95,0.10)';
      if (ok && !done.has(id)) { sc += creditFor(id); done.add(id); }
      studentAnswers[id] = { answer: val, correct: !!ok, timeSpent: 0, question: 'diagram blank' };
      attempted.add(id);
      up();
    }

    function toggleHint(id) {
      hintUsed.add(id);
      const el = document.getElementById(id + '-hint');
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    function toggleSolution(id) {
      // Only an explicit "Show Answer" click reaches this — the auto-reveal after a
      // correct answer sets the solution box's display style directly, so this
      // reliably marks "the student needed the answer handed to them."
      revealed.add(id);
      const el = document.getElementById(id + '-solution');
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    // ── Indic language input support ──
    // Students type English phonetically (e.g. "muggulu") → auto-converts to Telugu/Hindi
    // Uses Google Input Tools REST API for transliteration with dropdown suggestions
    ${translitLang ? `
    (function() {
      // Every language the IME can type; the worksheet's own language is the default.
      const LANGS = ${JSON.stringify(WORKSHEET_LANGS.filter(l => l.translit).map(l => ({ code: l.code, name: l.name, label: l.label }))).replace(/</g, '\\u003c')};
      let current = LANGS.find(function(l) { return l.code === '${translitLang.code}'; }) || LANGS[0];
      let enabled = true;
      let composing = false; // a native/web keyboard IME is mid-word — don't touch the value

      async function transliterate(word) {
        if (!word || word.length < 1) return [];
        try {
          const res = await fetch(API_BASE + '/quiz/transliterate?text=' + encodeURIComponent(word) + '&lang=' + current.code);
          if (!res.ok) return [];
          const data = await res.json();
          return (data && data.suggestions) || [];
        } catch(e) { console.warn('Transliteration failed:', e); }
        return [];
      }

      // Suggestion dropdown
      let dropdown = document.createElement('div');
      dropdown.id = 'translit-dropdown';
      dropdown.style.cssText = 'position:absolute;z-index:9999;background:#1C1C1C;border:1px solid rgba(147,176,172,0.4);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);display:none;overflow:hidden;min-width:120px;';
      document.body.appendChild(dropdown);

      let activeInput = null;
      let currentWord = '';
      let wordStart = 0;

      function hideDropdown() { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
      // Highlight tracked by data-active — the browser rewrites inline rgba() with
      // spaces, so matching on the style string never found it (Enter/Space did nothing).
      function setActive(opt) {
        dropdown.querySelectorAll('div').forEach(function(d) { d.style.background = 'transparent'; d.removeAttribute('data-active'); });
        if (opt) { opt.style.background = 'rgba(147,176,172,0.15)'; opt.setAttribute('data-active', '1'); }
      }

      function showDropdown(suggestions, input) {
        if (!suggestions.length) { hideDropdown(); return; }
        dropdown.innerHTML = '';
        suggestions.forEach(function(s, i) {
          var opt = document.createElement('div');
          opt.textContent = s;
          opt.style.cssText = 'padding:8px 14px;font-size:15px;color:#F0EEEC;cursor:pointer;border-bottom:1px solid rgba(195,220,216,0.08);';
          if (i === 0) setActive(opt);
          opt.onmouseenter = function() { setActive(opt); };
          opt.onmousedown = function(e) {
            e.preventDefault();
            applySelection(s, input);
          };
          dropdown.appendChild(opt);
        });
        // Position near the input. getBoundingClientRect is VIEWPORT-relative but the
        // dropdown is position:absolute (DOCUMENT-relative) — without adding the scroll
        // offset it renders thousands of px above the input once the quiz is scrolled,
        // i.e. invisible. This is why "Telugu typing didn't work" on lower questions.
        var rect = input.getBoundingClientRect();
        dropdown.style.left = (rect.left + window.scrollX) + 'px';
        dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        dropdown.style.display = 'block';
      }

      function applySelection(text, input) {
        var val = input.value;
        input.value = val.substring(0, wordStart) + text + val.substring(wordStart + currentWord.length);
        currentWord = '';
        hideDropdown();
        input.focus();
      }

      // Extract current English word being typed
      function getCurrentWord(input) {
        var val = input.value;
        var pos = input.selectionStart || val.length;
        var before = val.substring(0, pos);
        var match = before.match(/[a-zA-Z]+$/);
        if (match) {
          wordStart = pos - match[0].length;
          return match[0];
        }
        return '';
      }

      // Debounce
      let debounceTimer = null;

      function onInput(e) {
        if (!enabled || composing || e.isComposing) return;
        var input = e.target;
        activeInput = input;
        currentWord = getCurrentWord(input);
        if (currentWord.length >= 2) {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async function() {
            var suggestions = await transliterate(currentWord);
            showDropdown(suggestions, input);
          }, 200);
        } else {
          hideDropdown();
        }
      }

      function onKeydown(e) {
        if (!enabled) return;
        if (dropdown.style.display === 'none') return;
        var items = dropdown.querySelectorAll('div');
        var active = dropdown.querySelector('div[data-active]');
        var idx = Array.from(items).indexOf(active);

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive(items[(idx + 1) % items.length]);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive(items[(idx - 1 + items.length) % items.length]);
        } else if (e.key === 'Enter' || e.key === ' ') {
          if (active) {
            e.preventDefault();
            applySelection(active.textContent + (e.key === ' ' ? ' ' : ''), activeInput);
          }
        } else if (e.key === 'Escape') {
          hideDropdown();
        }
      }

      // Attach to all quiz inputs
      document.querySelectorAll('.lang-input, .q-input').forEach(function(inp) {
        inp.setAttribute('lang', current.code);
        inp.addEventListener('compositionstart', function() { composing = true; hideDropdown(); });
        inp.addEventListener('compositionend', function() { composing = false; });
        inp.addEventListener('input', onInput);
        inp.addEventListener('keydown', onKeydown);
        inp.addEventListener('blur', function() { setTimeout(hideDropdown, 200); });
      });

      // Language switcher (fixed bottom-left): pick any IME language, or
      // "My keyboard" to type directly (English or a device keyboard in any script).
      var indicator = document.createElement('div');
      indicator.id = 'lang-indicator';
      indicator.setAttribute('role', 'button');
      indicator.setAttribute('aria-haspopup', 'listbox');
      indicator.innerHTML = '<span class="lang-ind-icon"></span><span class="lang-ind-text"></span>';
      indicator.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#1C1C1C;color:#93B0AC;padding:8px 16px;border-radius:20px;border:1px solid rgba(147,176,172,0.3);z-index:999;display:flex;align-items:center;gap:8px;font-family:inherit;box-shadow:0 2px 12px rgba(0,0,0,0.4);cursor:pointer;user-select:none;transition:all 0.2s;';
      var menu = document.createElement('div');
      menu.id = 'lang-menu';
      menu.setAttribute('role', 'listbox');
      menu.style.cssText = 'position:fixed;bottom:64px;left:20px;background:#1C1C1C;border:1px solid rgba(147,176,172,0.3);border-radius:12px;z-index:1000;display:none;max-height:50vh;overflow:auto;min-width:170px;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
      function paint() {
        indicator.querySelector('.lang-ind-icon').textContent = enabled ? current.label : 'EN';
        indicator.querySelector('.lang-ind-text').textContent = enabled ? current.name + ' ON' : 'My keyboard';
        indicator.style.borderColor = enabled ? 'rgba(147,176,172,0.3)' : 'rgba(197,189,150,0.3)';
        document.querySelectorAll('.lang-input, .q-input').forEach(function(inp) { inp.setAttribute('lang', enabled ? current.code : '${detectedLang}'); });
      }
      function choose(code) {
        if (code === 'off') { enabled = false; }
        else { enabled = true; current = LANGS.find(function(l) { return l.code === code; }) || current; }
        menu.style.display = 'none';
        hideDropdown();
        paint();
      }
      [{ code: 'off', name: 'My keyboard (type directly)', label: 'EN' }].concat(LANGS).forEach(function(l) {
        var opt = document.createElement('div');
        opt.setAttribute('role', 'option');
        opt.dataset.code = l.code;
        opt.textContent = l.label + '  ' + l.name;
        opt.style.cssText = 'padding:9px 14px;font-size:14px;color:#F0EEEC;cursor:pointer;border-bottom:1px solid rgba(195,220,216,0.08);';
        opt.onmousedown = function(e) { e.preventDefault(); choose(l.code); };
        menu.appendChild(opt);
      });
      indicator.onclick = function() { menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; };
      document.addEventListener('mousedown', function(e) { if (!menu.contains(e.target) && !indicator.contains(e.target)) menu.style.display = 'none'; });
      document.body.appendChild(menu);
      document.body.appendChild(indicator);
      paint();

      // Style for indicator
      var style = document.createElement('style');
      style.textContent = '.lang-ind-icon{font-size:14px;font-weight:800;} .lang-ind-text{font-size:11px;opacity:0.7;} #lang-indicator:hover{transform:scale(1.05);border-color:#93B0AC!important;}';
      document.head.appendChild(style);
    })();
    ` : ''}
    // ── French accent palette ──
    // Floating toolbar with accented characters students can click to insert
    ${isFrench ? `
    (function() {
      const ACCENTS = ['é','è','ê','ë','à','â','ç','ù','û','ü','ô','î','ï','œ','æ','É','È','Ê','Ç','À','Â'];
      let activeInput = null;

      // Build palette
      var palette = document.createElement('div');
      palette.id = 'fr-palette';
      palette.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#1C1C1C;border:1px solid rgba(147,176,172,0.3);border-radius:12px;z-index:999;padding:8px 10px;display:flex;flex-wrap:wrap;gap:4px;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,0.4);align-items:center;';

      // Label
      var label = document.createElement('span');
      label.textContent = 'FR';
      label.style.cssText = 'font-size:12px;font-weight:800;color:#93B0AC;margin-right:6px;';
      palette.appendChild(label);

      ACCENTS.forEach(function(ch) {
        var btn = document.createElement('button');
        btn.textContent = ch;
        btn.style.cssText = 'width:28px;height:28px;border:1px solid rgba(195,220,216,0.2);border-radius:6px;background:transparent;color:#F0EEEC;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;padding:0;';
        btn.onmouseenter = function() { btn.style.background = 'rgba(147,176,172,0.2)'; btn.style.borderColor = '#93B0AC'; };
        btn.onmouseleave = function() { btn.style.background = 'transparent'; btn.style.borderColor = 'rgba(195,220,216,0.2)'; };
        btn.onmousedown = function(e) {
          e.preventDefault();
          if (!activeInput) return;
          var pos = activeInput.selectionStart || activeInput.value.length;
          var val = activeInput.value;
          activeInput.value = val.substring(0, pos) + ch + val.substring(pos);
          activeInput.selectionStart = activeInput.selectionEnd = pos + ch.length;
          activeInput.focus();
        };
        palette.appendChild(btn);
      });
      document.body.appendChild(palette);

      // Track active input
      document.querySelectorAll('.lang-input, .q-input').forEach(function(inp) {
        inp.setAttribute('lang', 'fr');
        inp.addEventListener('focus', function() { activeInput = inp; });
      });
    })();
    ` : ''}
  </script>
</body>
</html>`;
}

// ── Post-generation quiz normalizers ─────────────────────────────────────
// Ported from ai-mentor/server/routes/quiz.js (2026-09-11, B05) for
// POST /quiz/render-preview and POST /quiz/normalize. All seven are pure,
// deterministic, synchronous JS transforms on the quiz JSON — zero external
// calls (no Gemini/Groq/Cloudinary) — verified by reading every line before
// porting. Deliberately NOT ported in this batch: recoverBarCharts (a Gemini
// vision call that re-reads a bar-graph image when the LLM's own extraction
// pass omitted the structured chart data) — worksheets that need it degrade
// gracefully to showing the raw scanned image instead of an interactive
// chart, rather than a broken render; picked up as a separate, explicitly
// scoped follow-up given it needs its own Gemini-vision-dependent test
// strategy, unlike everything else here.

function sanitizeDuplicateQuestionIds(quiz) {
  for (const task of (quiz.tasks || [])) {
    const seenIds = new Set();
    const allQs = task.questions || [];
    for (const q of allQs) {
      if (!q.id) {
        q.id = Math.random().toString(36).substring(7);
      }
      if (seenIds.has(q.id)) {
        const baseId = q.id;
        let counter = 2;
        while (seenIds.has(`${baseId}_${counter}`)) {
          counter++;
        }
        const newId = `${baseId}_${counter}`;

        const colGroups = task.layout?.columnGroups || [];
        for (let gIdx = colGroups.length - 1; gIdx >= 0; gIdx--) {
          const group = colGroups[gIdx];
          const qIds = group.questionIds || [];
          const idx = qIds.lastIndexOf(baseId);
          if (idx !== -1) {
            qIds[idx] = newId;
            break;
          }
        }
        q.id = newId;
      }
      seenIds.add(q.id);
    }
  }
}

// ── Post-process: auto-detect MCQ questions the LLM returned as text ──────
function autoDetectMCQ(quiz) {
  sanitizeDuplicateQuestionIds(quiz);
  for (const task of (quiz.tasks || [])) {
    const title = (task.title || '').toLowerCase();
    const isMcqTask = /tick|choose|circle.*correct|select.*option|multiple.*choice/i.test(title);

    for (const q of (task.questions || [])) {
      if (q.type === 'mcq' && Array.isArray(q.options) && q.options.length > 0) continue;

      const qText = q.question || '';

      const parenMatch = qText.match(/\(([^)]+\/[^)]+)\)/);
      if (parenMatch && (isMcqTask || /tick|choose|circle|select/i.test(qText))) {
        const rawOpts = parenMatch[1].split('/').map(s => s.trim()).filter(Boolean);
        if (rawOpts.length >= 2) {
          q.type = 'mcq';
          q.options = rawOpts.map(label => {
            const isCorrect = String(q.answer).toLowerCase().trim() === label.toLowerCase().trim();
            return { label, correct: isCorrect };
          });
          q.question = qText.replace(parenMatch[0], '').replace(/\s+$/, '').replace(/:\s*$/, ':');
          continue;
        }
      }

      if (isMcqTask && q.type !== 'mcq' && q.type !== 'activity') {
        const abcMatch = qText.match(/\ba\)\s*(.+?)\s+b\)\s*(.+?)(?:\s+c\)\s*(.+?))?(?:\s+d\)\s*(.+?))?$/i);
        if (abcMatch) {
          const rawOpts = [abcMatch[1], abcMatch[2], abcMatch[3], abcMatch[4]].filter(Boolean).map(s => s.trim());
          if (rawOpts.length >= 2) {
            q.type = 'mcq';
            q.options = rawOpts.map(label => ({
              label,
              correct: String(q.answer).toLowerCase().trim() === label.toLowerCase().trim()
            }));
            q.question = qText.replace(abcMatch[0], '').trim();
          }
        }
      }
    }
  }
}

module.exports = {
  resolveQuizLanguage, WORKSHEET_LANGS, TRANSLIT_LANG_CODES, TRANSLIT_ITC,
  renderQuizHTML, solveVerticalMath, normalizeVennQuestions, renderBarChart, stripImagesForStructuredTasks,
  autoDetectMCQ, normalizeMatchingTasks, normalizeRiddleTables, normalizeLetterGridTables, normalizeTables, normalizeCharts,
};
