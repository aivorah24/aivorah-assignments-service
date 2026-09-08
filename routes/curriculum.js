const express = require('express');
const router  = express.Router();
const { client, resolveCollection } = require('../services/qdrant');
const { normalizeCurriculum } = require('../utils/curriculum');
const OFFICIAL_SUBJECTS = require('../data/ncert-official-subjects.json').byGrade;

// B01: some ingested Qdrant chunks were never given a human topic name —
// their `topic` payload is the raw internal ingestion code instead (e.g.
// "bemr101", "cebu101"). Those codes are 2-8 lowercase letters immediately
// followed by 2-4 digits and nothing else; a real topic title always has a
// space, punctuation, or a capital letter, so this pattern never matches one.
const INTERNAL_CODE_RE = /^[a-z]{2,8}\d{2,4}$/;

function isInternalCode(topic) {
  return INTERNAL_CODE_RE.test(String(topic || '').trim());
}

// The internal code must never reach the teacher-facing label (acceptance
// criteria), but we also don't fabricate a specific real-world title we
// can't verify — that would risk showing a WRONG name, which is worse than
// a code. Fall back to the chapter number when the ingested chunk carried
// one; otherwise a stable, honest per-subject counter. The original code
// stays available in `internalId` for callers that still need it (e.g. AI
// generation grounding), it just never becomes the display label.
function safeTopicLabel(subject, chapterNum, ordinal) {
  return chapterNum > 0 ? `${subject} — Chapter ${chapterNum}` : `${subject} — Topic ${ordinal}`;
}

const subjectsCache = new Map(); // key -> { at, data }
const SUBJECTS_CACHE_TTL_MS = 5 * 60 * 1000;

// GET /curriculum/subjects?grade=Grade+3&curriculum=CBSE
// Moved off the monolith (ai-mentor/server/routes/curriculum.js) as part of
// the B01 fix — same Qdrant collections/query shape (verified identical
// resolveCollection + collection names in both services, 2026-09-08), plus
// the topic-code fallback above that the monolith's version never had.
router.get('/subjects', async (req, res) => {
  try {
    const { grade = 'Grade 3' } = req.query;
    const normCurr = normalizeCurriculum(req.query.curriculum, 'IB PYP');
    const { collection, qdrantCurriculum, qdrantGrade } = resolveCollection(normCurr, grade);

    const cacheKey = `${collection}|${qdrantCurriculum}|${qdrantGrade}`;
    const cached = subjectsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SUBJECTS_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const seen = new Set();
    const topicMap = {}; // subject -> [{ topic, internalId, unit, description, chapter }]
    let offset = null;

    do {
      const result = await client.scroll(collection, {
        filter: {
          must: [
            { key: 'curriculum', match: { value: qdrantCurriculum } },
            { key: 'grade', match: { value: qdrantGrade } },
          ],
          must_not: [{ key: 'content_type', match: { value: 'image' } }],
        },
        limit: 2000,
        offset: offset ?? undefined,
        with_payload: ['subject', 'topic', 'unit', 'textbook', 'description', 'chapter'],
        with_vector: false,
      });

      for (const point of result.points) {
        const p = point.payload;
        if (!p.topic || /^\[?IMAGE\]?/i.test(p.topic) || /^this image/i.test(p.topic)) continue;
        const key = `${p.subject}|${p.topic}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (!topicMap[p.subject]) topicMap[p.subject] = [];
          topicMap[p.subject].push({
            topic: p.topic,
            unit: p.unit || p.textbook || '',
            description: p.description || p.text || '',
            chapter: p.chapter || 0,
          });
        }
      }

      offset = result.next_page_offset ?? null;
    } while (offset !== null);

    const subjects = Object.entries(topicMap).map(([subject, topics]) => {
      const sorted = topics.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0) || a.topic.localeCompare(b.topic));
      const unitNames = [...new Set(sorted.map((t) => (t.unit || '').trim()).filter(Boolean))];
      const displayTopics = sorted.map((t, i) => {
        if (!isInternalCode(t.topic)) return { topic: t.topic, unit: t.unit, description: t.description, chapter: t.chapter };
        return {
          topic: safeTopicLabel(subject, t.chapter, i + 1),
          internalId: t.topic,
          unit: t.unit,
          description: t.description,
          chapter: t.chapter,
        };
      });
      return {
        subject,
        topicCount: sorted.length,
        unitCount: unitNames.length,
        units: unitNames,
        topics: displayTopics,
      };
    }).sort((a, b) => a.subject.localeCompare(b.subject));

    // For CBSE/NCERT, show only the subjects that officially exist for this
    // grade (ported from the monolith's own filter, same source/date).
    let outSubjects = subjects;
    try {
      const isNcert = /ncert|cbse/i.test(String(normCurr || ''));
      if (isNcert) {
        const gNum = (String(grade).match(/(\d+)/) || [])[1];
        const allowed = (OFFICIAL_SUBJECTS[gNum] || []).map((s) => s.toLowerCase());
        if (allowed.length) {
          const norm = (s) => (s.toLowerCase() === 'evs' ? 'environmental studies' : s.toLowerCase());
          outSubjects = subjects.filter((sub) => allowed.includes(norm(sub.subject)));
        }
      }
    } catch (_) { /* on any error, fall back to unfiltered */ }

    const responseBody = { grade, curriculum: normCurr, subjects: outSubjects };
    subjectsCache.set(cacheKey, { at: Date.now(), data: responseBody });
    res.json(responseBody);
  } catch (err) {
    console.error('Error in GET /curriculum/subjects:', err.message);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

module.exports = router;
module.exports._internal = { isInternalCode, safeTopicLabel };
