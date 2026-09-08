// Ported verbatim from ai-mentor/server/utils/curriculum.js (2026-09-08, B01
// refactor — moving GET /curriculum/subjects off the monolith onto this
// service). Must stay in sync with the monolith's canonical mapping: this
// service's resolveCollection() (services/qdrant.js) picks the Qdrant
// collection based on the NORMALIZED curriculum name, and the monolith's
// route normalizes before resolving too — if the two map CBSE differently,
// this endpoint queries the wrong collection and silently returns
// different/empty data instead of the same topics the monolith serves today.
function normalizeCurriculum(curriculum, fallback = 'IB PYP') {
  const value = String(curriculum || fallback).trim();

  const canonicalMap = {
    'IB_PYP':        'IB PYP',
    'IB PYP':        'IB PYP',
    'IBPYP':         'IB PYP',
    'ib pyp':        'IB PYP',
    'ib_pyp':        'IB PYP',
    'NCERT':         'NCERT',
    'ncert':         'NCERT',
    'Cambridge':     'Cambridge',
    'Oxford':        'Oxford',
    'Pearson':       'Pearson',
    'Singapore MOE': 'Singapore MOE',
    'Singapore_MOE': 'Singapore MOE',
    'CBSE':          'NCERT',
    'cbse':          'NCERT',
    'Cbse':          'NCERT',
    'ICSE':          'ICSE',
    'icse':          'ICSE',
    'Icse':          'ICSE',
    'NIOS':          'NIOS',
    'nios':          'NIOS',
    'Nios':          'NIOS',
  };

  return canonicalMap[value] ?? value;
}

module.exports = { normalizeCurriculum };
