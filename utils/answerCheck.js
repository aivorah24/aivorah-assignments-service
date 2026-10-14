// Answer checks shared by the server (POST /quiz/grade-answer) and the
// student worksheet page — the page inlines these functions via
// Function.prototype.toString(), so they must stay self-contained (no
// closures over module scope, plain ES2018).

// Dominant writing system of a string: 'Latin', 'Telugu', 'Devanagari', …
// or '' when it has no letters (digits/punctuation only).
function dominantScript(text) {
  var ranges = [
    ['Telugu', /[ఀ-౿]/], ['Devanagari', /[ऀ-ॿ]/], ['Tamil', /[஀-௿]/],
    ['Kannada', /[ಀ-೿]/], ['Malayalam', /[ഀ-ൿ]/], ['Bengali', /[ঀ-৿]/],
    ['Gujarati', /[઀-૿]/], ['Gurmukhi', /[਀-੿]/], ['Oriya', /[଀-୿]/],
    ['Arabic', /[؀-ۿ]/], ['Han', /[一-鿿]/], ['Kana', /[぀-ヿ]/],
    ['Hangul', /[가-힯]/], ['Cyrillic', /[Ѐ-ӿ]/], ['Greek', /[Ͱ-Ͽ]/],
    ['Latin', /[A-Za-zÀ-ɏ]/],
  ];
  var counts = {};
  var chars = Array.from(String(text || ''));
  for (var i = 0; i < chars.length; i++) {
    for (var r = 0; r < ranges.length; r++) {
      if (ranges[r][1].test(chars[i])) { counts[ranges[r][0]] = (counts[ranges[r][0]] || 0) + 1; break; }
    }
  }
  var best = ''; var n = 0;
  for (var k in counts) { if (counts[k] > n) { best = k; n = counts[k]; } }
  return best;
}

// The script a student must write in, or '' when any is fine: the answer
// key's script when it isn't Latin, else (no key — an open answer) the
// worksheet's own non-Latin script. Number answers never need a script.
function requiredScript(expected, worksheetScript) {
  var s = dominantScript(expected);
  if (s && s !== 'Latin') return s;
  if (!s && !/\d/.test(String(expected || '')) && worksheetScript && worksheetScript !== 'Latin') return worksheetScript;
  return '';
}

// Wrong writing system — e.g. Tamil "வணக்கம்" typed on a Telugu worksheet,
// or a transliteration in Latin letters where Telugu is expected.
function isWrongScript(student, expected, worksheetScript) {
  var need = requiredScript(expected, worksheetScript);
  if (!need) return false;
  var got = dominantScript(student);
  return !!got && got !== need;
}

// For comparison: NFC, case-folded, punctuation and spaces removed.
function normalizeAnswer(text) {
  return String(text == null ? '' : text).normalize('NFC').toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function matchesAnyAnswer(student, answers) {
  var s = normalizeAnswer(student);
  if (!s) return false;
  for (var i = 0; i < answers.length; i++) {
    if (answers[i] != null && String(answers[i]).trim() && normalizeAnswer(answers[i]) === s) return true;
  }
  return false;
}

module.exports = { dominantScript, requiredScript, isWrongScript, normalizeAnswer, matchesAnyAnswer };
