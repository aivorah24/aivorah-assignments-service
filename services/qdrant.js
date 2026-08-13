const { QdrantClient } = require('@qdrant/js-client-rest');

const COLLECTION        = 'aivorah_curriculum_chunks_v1'; // NCERT + new content
const IB_COLLECTION     = 'ai_mentor_content';            // IB PYP, CBSE, Cambridge, etc.

// Pick the right collection and normalise grade/curriculum for Qdrant
function resolveCollection(normCurriculum, grade) {
  if (normCurriculum === 'NCERT') {
    // NCERT collection stores grade as integer (6, 7, …)
    const m = String(grade || '').match(/(\d+)/);
    const qdrantGrade = m ? parseInt(m[1], 10) : grade;
    return { collection: COLLECTION, qdrantCurriculum: normCurriculum, qdrantGrade };
  }
  // All other curricula (IB PYP → IB_PYP, CBSE, Cambridge, …) live in ai_mentor_content
  // Those store grade as "Grade 4" string and curriculum with underscores for IB PYP
  const qdrantCurriculum = normCurriculum === 'IB PYP' ? 'IB_PYP' : normCurriculum;
  const m = String(grade || '').match(/(\d+)/);
  const qdrantGrade = m ? `Grade ${m[1]}` : grade;
  return { collection: IB_COLLECTION, qdrantCurriculum, qdrantGrade };
}
const VECTOR_SIZE = 384; // all-MiniLM-L6-v2 (local, no API key)

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

async function initCollection() {
  const { collections } = await client.getCollections();
  const exists = collections.some(c => c.name === COLLECTION);

  if (!exists) {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });

    // Payload indexes for fast filtering during search
    const indexFields = ['curriculum', 'grade', 'subject', 'content_type', 'school_id'];
    for (const field of indexFields) {
      await client.createPayloadIndex(COLLECTION, {
        field_name: field,
        field_schema: 'keyword',
      });
    }

    console.log('✅ Qdrant collection created:', COLLECTION);
  } else {
    console.log('✅ Qdrant collection ready:', COLLECTION);
  }
}

async function searchContent({ vector, curriculum, grade, subject, topic, limit = 5, collection, contentType }) {
  const must = [];

  if (curriculum) must.push({ key: 'curriculum', match: { value: curriculum } });
  if (grade) must.push({ key: 'grade', match: { value: grade } });
  if (subject) must.push({ key: 'subject', match: { value: subject } });
  if (topic) must.push({ key: 'topic', match: { value: topic } });
  if (contentType) must.push({ key: 'content_type', match: { value: contentType } });

  const targetCollection = collection || COLLECTION;
  const results = await client.search(targetCollection, {
    vector,
    limit,
    filter: must.length > 0 ? { must } : undefined,
    with_payload: true,
  });

  return results;
}

// Robust grounding retrieval used by assignment/quiz generation. Routes to the
// correct collection (the plain searchContent always defaulted to the NCERT one,
// so IB/CBSE queries silently returned nothing → generic content), normalises the
// grade/curriculum to how they're actually stored, and falls back progressively:
//   1. native curriculum for the grade+subject
//   2. IB PYP → its BASE standard (CBSE then NCERT) for the same grade+subject
//      (per product rule "IB follows the NCERT/CBSE base standard")
//   3. relax subject, then curriculum, as a last resort (still same grade)
// Returns { chunks, source } — chunks empty only when nothing is ingested at all.
async function searchGrounding({ vector, curriculum, grade, subject, topic, limit = 6 }) {
  const rawCurr = String(curriculum || '').trim();
  const norm = /ncert/i.test(rawCurr) ? 'NCERT'
    : /ib[\s_]*pyp/i.test(rawCurr) ? 'IB PYP'
    : /cbse/i.test(rawCurr) ? 'CBSE'
    : rawCurr;
  const gradeNum = (String(grade || '').match(/(\d+)/) || [])[1];

  const primary = resolveCollection(norm, grade);
  const attempts = [
    { collection: primary.collection, curriculum: primary.qdrantCurriculum, grade: primary.qdrantGrade, subject, topic },
  ];
  if (norm === 'IB PYP') {
    // IB PYP → CBSE base (same collection), then NCERT base.
    attempts.push({ collection: IB_COLLECTION, curriculum: 'CBSE', grade: gradeNum ? `Grade ${gradeNum}` : grade, subject });
    if (gradeNum) attempts.push({ collection: COLLECTION, curriculum: 'NCERT', grade: parseInt(gradeNum, 10), subject });
  }
  // Relax subject, then curriculum (keep grade), on the primary collection.
  attempts.push({ collection: primary.collection, curriculum: primary.qdrantCurriculum, grade: primary.qdrantGrade });
  attempts.push({ collection: primary.collection, grade: primary.qdrantGrade });

  for (const a of attempts) {
    try {
      const res = await searchContent({ vector, limit, ...a });
      if (res && res.length > 0) return { chunks: res, source: a };
    } catch { /* try next */ }
  }
  return { chunks: [], source: null };
}

async function upsertContent(points) {
  await client.upsert(COLLECTION, { points, wait: true });
}

async function getCollectionInfo() {
  return client.getCollection(COLLECTION);
}

module.exports = { initCollection, searchContent, searchGrounding, upsertContent, getCollectionInfo, client, COLLECTION, IB_COLLECTION, resolveCollection };
