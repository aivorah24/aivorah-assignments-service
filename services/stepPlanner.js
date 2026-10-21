// AI-designed assignment steps. The model picks how many steps and which kinds
// from the step types the student app can render, based on the curriculum
// standard, topic complexity and grade — no fixed per-subject templates.

const HOOK_TYPES = ['tuning_in', 'text_connection', 'social_inquiry', 'language_culture', 'artistic_exploration', 'digital_awareness', 'movement_exploration'];
const REFLECTION_TYPES = ['math_reflection', 'writing_reflection', 'social_synthesis', 'communication', 'artistic_reflection', 'digital_citizenship', 'physical_reflection'];
// Steps whose "provocation" is a reading passage (hook types hold a scenario there)
const READING_TYPES = ['reading_comprehension'];
const SECTION_TYPES = ['structured_writing', 'reading_comprehension', 'research_notes', 'language_practice', 'tech_skill_practice', 'skill_practice'];

// What each type looks like to the student, and the fields the AI must fill.
const STEP_CATALOGUE = {
  brainstorm:            { use: 'student lists keywords/ideas (chips)', fields: [] },
  prior_knowledge:       { use: 'two boxes: what I already know / what I predict', fields: [] },
  tuning_in:             { use: 'student reads a short real-world scenario and writes initial thinking', fields: ['provocation'] },
  text_connection:       { use: 'student reads a short passage you write and responds personally', fields: ['provocation'] },
  social_inquiry:        { use: 'student reads a scenario and writes notice / wonder / know', fields: ['provocation'] },
  language_culture:      { use: 'student reads a cultural text in the target language and responds', fields: ['provocation'] },
  artistic_exploration:  { use: 'student reads a description of a real artwork and responds', fields: ['provocation'] },
  digital_awareness:     { use: 'student reads a digital-life scenario and responds', fields: ['provocation'] },
  movement_exploration:  { use: 'student reads a movement/sport scenario and responds', fields: ['provocation'] },
  problem_solving:       { use: 'numbered problems; each problem is self-contained with all the numbers/data it needs; student writes answers + working', fields: ['problems'] },
  drawing:               { use: 'student draws on paper and uploads a photo — ONLY when the learning is genuinely visual (diagram, life cycle, map, graph, geometry, labelled structure)', fields: [] },
  art_creation:          { use: 'student makes an artwork and uploads a photo (Visual Arts)', fields: [] },
  structured_writing:    { use: 'written response in named sections', fields: ['sections'] },
  reading_comprehension: { use: 'student reads a passage YOU write and answers questions — the complete passage goes in "provocation"; "sections" = 3-5 actual questions (literal → inferential → evaluative), each gets its own answer box', fields: ['provocation', 'sections'] },
  research_notes:        { use: 'research and record notes in named sections', fields: ['sections'] },
  language_practice:     { use: 'vocabulary + sentence writing in the target language, in named sections; give sentence frames in the target language inside instructions', fields: ['sections', 'wordBank'] },
  tech_skill_practice:   { use: 'do a digital task and describe it, in named sections', fields: ['sections'] },
  skill_practice:        { use: 'record physical practice, in named sections', fields: ['sections'] },
  math_reflection:       { use: 'answer reflection prompts about strategy and real-life use', fields: ['reflectionPrompts'] },
  writing_reflection:    { use: 'answer reflection prompts about a text', fields: ['reflectionPrompts'] },
  social_synthesis:      { use: 'answer prompts on significance, connections and action', fields: ['reflectionPrompts'] },
  communication:         { use: 'write a paragraph in the target language + reflection prompts', fields: ['reflectionPrompts'] },
  artistic_reflection:   { use: 'artist statement prompts', fields: ['reflectionPrompts'] },
  digital_citizenship:   { use: 'prompts on responsible technology use', fields: ['reflectionPrompts'] },
  physical_reflection:   { use: 'prompts on progress, next steps and wellbeing', fields: ['reflectionPrompts'] },
};

const SECTION_DEFAULTS = {
  structured_writing:    ['Beginning', 'Middle', 'End'],
  reading_comprehension: ['What Happened?', 'Reading Between the Lines', 'My Thinking'],
  research_notes:        ['Key Facts', 'People and Perspectives', 'Cause and Effect'],
  language_practice:     ['Vocabulary Practice', 'My Sentences', 'Cultural Connection'],
  tech_skill_practice:   ['Step-by-Step Task', 'My Digital Creation', 'How I Checked My Sources'],
  skill_practice:        ['Key Skill Steps', 'My Practice Record', 'Teamwork and Fairness'],
};

const isLanguageSubject = (subject) => /language acquisition/i.test(subject || '');

function allowedTypes(subject) {
  const all = Object.keys(STEP_CATALOGUE);
  // Language learning is written production in the target language — no drawing/art
  return isLanguageSubject(subject) ? all.filter(t => !['drawing', 'art_creation'].includes(t)) : all;
}

function stepDesignGuide({ topic, subject, grade, curriculum, language }) {
  const types = allowedTypes(subject);
  return `DESIGN THE TASK STEPS YOURSELF — like an expert ${curriculum || ''} ${subject || ''} teacher would for ${grade || 'this grade'}.
- Decide the NUMBER of steps (2-5) from the topic's complexity and the grade: a simple topic for young students needs 2-3 short steps; a rich or multi-part topic for older students can need 4-5.
- Decide the KIND of each step from what "${topic}" actually requires students to do (recall, calculate, read, explain, compare, analyse, research, create, reflect). Order them as a learning progression (activate → learn/practise → apply → reflect), matching ${curriculum || 'the curriculum'} expectations for ${grade || 'this grade'}.
- Each step must be a different type. Never add a step just to fill a template, and don't open every assignment the same way — pick the opening that suits this topic.
- Every step must be self-contained and specific to "${topic}": name the actual concepts, and include any passage, data, example or word list the student needs in that step. Never write generic text like "answer the prompts", "use the sections provided" or "read the passage below" without the passage. Labels must be specific to the topic too.
- Use "drawing" only if the learning outcome is genuinely visual; otherwise choose a written or problem-based type.${isLanguageSubject(subject) ? `\n- This is language learning${language ? ` in ${language}` : ''}: every step must make the student read and WRITE the target language. No drawing, no audio.` : ''}
- Students can only type text or upload a photo — never ask them to speak, record, or watch a video.

ALLOWED STEP TYPES (use these exact names):
${types.map(t => `• ${t}: ${STEP_CATALOGUE[t].use}${STEP_CATALOGUE[t].fields.length ? ` — must include "${STEP_CATALOGUE[t].fields.join('", "')}"` : ''}`).join('\n')}

Field formats: "provocation" = the full text the student reads, written out completely (no image references) — a reading passage is a real, titled text like a textbook extract: 120-200 words for Grades 1-5, 200-350 words for Grade 6 and above, in the language being studied; "wordBank" = 6-10 entries the step uses, each "word (romanisation) – meaning" for languages or "term – meaning" otherwise; "problems" = array of 3-6 problem strings with actual numbers; "sections" = array of 2-4 section headings specific to the topic; "reflectionPrompts" = array of 2-3 question strings.`;
}

const STEP_JSON_SHAPE = `"taskSteps": [
    { "type": "<allowed type>", "label": "<3-5 word engaging title>", "instructions": "<exact, topic-specific instructions for the student>", "provocation": "<full scenario or reading passage, for reading types>", "problems": ["<only for problem_solving>"], "sections": ["<only for section types>"], "reflectionPrompts": ["<only for reflection types>"], "wordBank": ["<only when the step uses a word list>"] }
  ]`;

const strList = (v) => (Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : []);

// Keep only renderable, distinct types; fill the fields each type needs.
function normaliseSteps(rawSteps, { subject, wordBank = [], fallbackProblems } = {}) {
  const allowed = new Set(allowedTypes(subject));
  const seen = new Set();
  const steps = [];
  for (const s of Array.isArray(rawSteps) ? rawSteps : []) {
    const type = String(s?.type || '').trim();
    if (!allowed.has(type) || seen.has(type)) continue;
    const label = String(s.label || '').trim();
    const instructions = String(s.instructions || '').trim();
    if (!label || !instructions) continue;
    seen.add(type);
    const sections = strList(s.sections);
    const reflectionPrompts = strList(s.reflectionPrompts);
    let problems = type === 'problem_solving' ? strList(s.problems) : [];
    if (type === 'problem_solving' && problems.length === 0 && fallbackProblems) problems = fallbackProblems(label);
    steps.push({
      type, label, instructions,
      provocation: HOOK_TYPES.includes(type) || READING_TYPES.includes(type) ? String(s.provocation || '').trim() : undefined,
      sections: SECTION_TYPES.includes(type) || REFLECTION_TYPES.includes(type)
        ? (sections.length ? sections : (SECTION_DEFAULTS[type] || []))
        : [],
      problems,
      reflectionPrompts: REFLECTION_TYPES.includes(type) ? reflectionPrompts : [],
      wordBank: strList(s.wordBank).length ? strList(s.wordBank) : strList(wordBank),
    });
    if (steps.length === 5) break;
  }
  return steps;
}

// Writing systems, to catch a model drifting into another language's script
const SCRIPTS = {
  devanagari: /[ऀ-ॿ]/, bengali: /[ঀ-৿]/, gurmukhi: /[਀-੿]/, gujarati: /[઀-૿]/,
  odia: /[଀-୿]/, tamil: /[஀-௿]/, telugu: /[ఀ-౿]/, kannada: /[ಀ-೿]/,
  malayalam: /[ഀ-ൿ]/, arabic: /[؀-ۿ]/, han: /[一-鿿]/, kana: /[぀-ヿ]/,
  hangul: /[가-힯]/, cyrillic: /[Ѐ-ӿ]/, greek: /[Ͱ-Ͽ]/, thai: /[฀-๿]/,
};
const LANGUAGE_SCRIPTS = {
  hindi: ['devanagari'], marathi: ['devanagari'], sanskrit: ['devanagari'], nepali: ['devanagari'],
  bengali: ['bengali'], assamese: ['bengali'], punjabi: ['gurmukhi'], gujarati: ['gujarati'], odia: ['odia'],
  tamil: ['tamil'], telugu: ['telugu'], kannada: ['kannada'], malayalam: ['malayalam'],
  urdu: ['arabic'], arabic: ['arabic'], persian: ['arabic'], mandarin: ['han'], chinese: ['han'],
  japanese: ['kana', 'han'], korean: ['hangul'], russian: ['cyrillic'], greek: ['greek'], thai: ['thai'],
};

function stepText(s) {
  return [s.label, s.instructions, s.provocation, ...s.sections, ...s.problems, ...s.reflectionPrompts, ...s.wordBank].filter(Boolean).join(' ');
}

// Content a step promises but doesn't contain — sent back to the model to fill
function findStepGaps(steps, { language, single = false } = {}) {
  const gaps = [];
  if (!single && steps.length < 2) gaps.push(`The assignment has only ${steps.length} step — design 2-5 complete steps for this topic.`);
  const allowed = new Set(LANGUAGE_SCRIPTS[String(language || '').trim().toLowerCase()] || []);
  steps.forEach((s, i) => {
    const n = `Step ${i + 1} (${s.type})`;
    // "fill the boxes below" points at the app's own answer boxes, not missing content
    const instr = s.instructions.replace(/\b(boxes?|sections?|prompts?|questions?|fields?|spaces?) (below|above)\b/gi, '');
    const refersToContent = /\b(listed|following|below|above|shown|word bank|these words|the words)\b/i.test(instr);
    if (['drawing', 'art_creation'].includes(s.type) && s.instructions.length < 80) gaps.push(n + ': say exactly what to draw, which parts to label, and any arrows/key needed.');
    if (s.type === 'problem_solving' && s.problems.length < 2) gaps.push(`${n}: needs 3-6 self-contained problems in "problems".`);
    if (s.type === 'language_practice' && s.wordBank.length < 4) gaps.push(`${n}: needs a "wordBank" of 6-10 target-language words with romanisation and meaning.`);
    if (READING_TYPES.includes(s.type) && (s.provocation || '').length < 400) gaps.push(`${n}: needs the complete reading passage (with a title) in "provocation" — the student only sees what you write there.`);
    if (READING_TYPES.includes(s.type) && s.sections.filter(q => /\?\s*$/.test(q) || q.length > 30).length < 3) gaps.push(`${n}: "sections" must be 3-5 actual questions about the passage (each gets its own answer box), not headings.`);
    if (HOOK_TYPES.includes(s.type) && (s.provocation || '').length < 60) gaps.push(`${n}: needs the full text the student reads in "provocation".`);
    if (language) {
      const foreign = Object.keys(SCRIPTS).filter(k => !allowed.has(k) && SCRIPTS[k].test(stepText(s)));
      if (foreign.length) gaps.push(`${n}: contains ${foreign.join('/')} script text — write it only in ${language} (and English glosses).`);
    }
    if (REFLECTION_TYPES.includes(s.type) && s.reflectionPrompts.length < 2) gaps.push(`${n}: needs 2-3 specific "reflectionPrompts".`);
    if (refersToContent && !s.wordBank.length && !s.problems.length && !s.reflectionPrompts.length && !s.provocation && s.instructions.length < 250) {
      gaps.push(`${n}: the instructions refer to content ("${s.instructions.slice(0, 60)}…") that isn't included — include it.`);
    }
  });
  return gaps;
}

// Up to two repair rounds: give the model its own steps + the gaps and keep the
// version with the fewest gaps. `complete(prompt)` returns the model's JSON text.
async function repairStepGaps(steps, { complete, normaliseOpts, context = '', language, single = false, rounds = 2 }) {
  let best = { steps, gaps: findStepGaps(steps, { language, single }) };
  for (let round = 0; round < rounds && best.gaps.length; round++) {
    try {
      const raw = await complete(`${context}
These task steps are incomplete. Fix ONLY these problems and return ALL steps in the same order and format, with the missing content written out in full (real words, passages, problems, questions — no placeholders):
${best.gaps.map(g => `- ${g}`).join('\n')}

Current steps:
${JSON.stringify({ taskSteps: best.steps })}

Return ONLY valid JSON: { "taskSteps": [ ... ] }`);
      const fixed = normaliseSteps(JSON.parse(raw).taskSteps, normaliseOpts);
      const left = findStepGaps(fixed, { language, single });
      if (fixed.length && left.length < best.gaps.length) best = { steps: fixed, gaps: left };
    } catch (e) {
      console.warn('[stepPlanner] repair failed:', e.message);
      break;
    }
  }
  if (best.gaps.length) console.warn('[stepPlanner] gaps left after repair:', best.gaps.join(' | '));
  return best;
}

module.exports = {
  STEP_CATALOGUE, HOOK_TYPES, REFLECTION_TYPES, SECTION_TYPES, READING_TYPES,
  allowedTypes, stepDesignGuide, STEP_JSON_SHAPE, normaliseSteps, findStepGaps, repairStepGaps,
};
