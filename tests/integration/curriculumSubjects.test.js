// R01 (Master Defect Register, B01) — Assignments > Upload & Classify: the
// topic chips a teacher sees must never be an internal ingestion code like
// "bemr101"/"cebu101". Regression test for the topic-code leak.
const mockScroll = jest.fn();
const mockResolveCollection = jest.fn().mockReturnValue({
  collection: 'aivorah_curriculum_chunks_v1',
  qdrantCurriculum: 'NCERT',
  qdrantGrade: 3,
});
jest.mock('../../services/qdrant', () => ({
  client: { scroll: (...args) => mockScroll(...args) },
  resolveCollection: (...args) => mockResolveCollection(...args),
}));

const request = require('supertest');
const app = require('../../index');

function point(payload) {
  return { payload };
}

beforeEach(() => {
  mockScroll.mockReset();
});

describe('GET /curriculum/subjects', () => {
  test('never returns an internal ingestion code as the teacher-facing topic label', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        point({ subject: 'Mathematics', topic: 'bemr101', unit: '', description: '', chapter: 0 }),
        point({ subject: 'Mathematics', topic: 'bemr102', unit: '', description: '', chapter: 0 }),
        point({ subject: 'Mathematics', topic: 'Addition and Subtraction', unit: '', description: 'Real title', chapter: 1 }),
      ],
      next_page_offset: null,
    });

    const res = await request(app).get('/curriculum/subjects?grade=Grade+3&curriculum=CBSE');

    expect(res.status).toBe(200);
    const maths = res.body.subjects.find((s) => s.subject === 'Mathematics');
    expect(maths).toBeTruthy();

    // Negative assertion the defect doc calls for: no displayed topic name
    // matches the internal-code pattern.
    for (const t of maths.topics) {
      expect(t.topic).not.toMatch(/^[a-z]{2,8}\d{2,4}$/);
    }

    // The real, already-human title must pass through completely untouched.
    expect(maths.topics.some((t) => t.topic === 'Addition and Subtraction')).toBe(true);

    // Internal codes are still available to the backend (e.g. for AI
    // generation grounding) — they just never become the display label.
    const relabelled = maths.topics.filter((t) => t.internalId);
    expect(relabelled).toHaveLength(2);
    expect(relabelled.map((t) => t.internalId).sort()).toEqual(['bemr101', 'bemr102']);
  });

  test('a genuinely unmapped topic still gets a stable, distinct fallback label per item', async () => {
    // Different grade (4, not 3) so this hits a different cache key than the
    // test above — the 5-minute subjects cache is keyed by collection +
    // curriculum + grade, and both tests share the mocked resolveCollection.
    mockResolveCollection.mockReturnValueOnce({
      collection: 'aivorah_curriculum_chunks_v1',
      qdrantCurriculum: 'NCERT',
      qdrantGrade: 4,
    });
    mockScroll.mockResolvedValueOnce({
      points: [
        point({ subject: 'Arts', topic: 'cebu101', unit: '', description: '', chapter: 0 }),
        point({ subject: 'Arts', topic: 'cebu102', unit: '', description: '', chapter: 0 }),
      ],
      next_page_offset: null,
    });

    const res = await request(app).get('/curriculum/subjects?grade=Grade+4&curriculum=CBSE');

    const arts = res.body.subjects.find((s) => s.subject === 'Arts');
    const labels = arts.topics.map((t) => t.topic);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate labels
    for (const label of labels) {
      expect(label).toMatch(/^Arts — (Chapter|Topic) \d+$/);
    }
  });
});
