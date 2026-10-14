// Grade / curriculum / chapter code read straight from what is printed on a
// worksheet (text layer, OCR) or its file name — no AI. "Revised_PYP4_-MHLE-29.pdf"
// → Grade 4, IB PYP, MHLE-29. Used so the upload form fills these in seconds,
// and as a fallback when the AI extraction returns nothing.
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const NOT_A_CODE = new Set(['PYP', 'MYP', 'CBSE', 'ICSE', 'NCERT', 'IGCSE', 'GRADE', 'CLASS', 'STD', 'PAGE', 'TASK', 'UNIT', 'ROLL', 'NO', 'DATE', 'MARKS', 'PDF', 'DOCX', 'IMG', 'IMAGE', 'SCAN', 'COPY', 'FINAL', 'REVISED', 'VER']);

function gradeIn(text) {
  const s = String(text || '');
  let m = s.match(/\b(?:grade|class|std\.?|standard)\s*[:\-]?\s*(\d{1,2})(?!\d)/i);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `Grade ${+m[1]}`;
  // Upper-case Roman numerals not followed by prose ("In class I learned" is not a grade).
  m = s.match(/\b(?:[Gg]rade|GRADE|[Cc]lass|CLASS|[Ss]td\.?|STD|[Ss]tandard)\s*[:\-]?\s*(XII|XI|IX|X|VIII|VII|VI|IV|V|III|II|I)\b(?!\s+[a-z])/);
  if (m) return `Grade ${ROMAN[m[1]]}`;
  m = s.match(/\bPYP\s*[:\-]?\s*([1-6])(?!\d)/i);
  if (m) return `Grade ${m[1]}`;
  return '';
}

function curriculumIn(text) {
  const s = String(text || '');
  if (/\bPYP\b|\bPYP\s*\d|\bIB\s+(?:PYP|primary)/i.test(s)) return 'IB PYP';
  if (/\bCBSE\b|\bNCERT\b/i.test(s)) return 'CBSE';
  if (/\bICSE\b/i.test(s)) return 'ICSE';
  if (/\bIGCSE\b|\bCambridge\b/i.test(s)) return 'Cambridge';
  return '';
}

// A unit/chapter code like "MHLE-29", "LHLE 19", "THLE-2" (capitals + number).
function chapterCodeIn(text) {
  const re = /\b([A-Z]{3,6})[\s_-]*(\d{1,3})(?!\d)(?!\s+[a-z])/g; // not "READ 2 pages"
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (!NOT_A_CODE.has(m[1])) return `${m[1]}-${+m[2]}`;
  }
  return '';
}

// File names use _ and . as spaces ("Revised_PYP4_-MHLE-29.pdf").
const fileNameText = name => String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_.]+/g, ' ');

/** Printed text wins over the file name, field by field. */
function detectWorksheetMeta({ text = '', fileName = '' } = {}) {
  const head = String(text).slice(0, 3000); // headers are at the top
  const name = fileNameText(fileName);
  return {
    grade: gradeIn(head) || gradeIn(name),
    curriculum: curriculumIn(head) || curriculumIn(name),
    chapter: chapterCodeIn(head) || chapterCodeIn(name),
  };
}

module.exports = { detectWorksheetMeta, gradeIn, curriculumIn, chapterCodeIn };
