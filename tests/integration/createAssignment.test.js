const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const STUDENT_UUID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UUID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  mockSb.reset();
});

describe('POST /assignments', () => {
  test('creates a plain assignment for a specific student and returns the normalised row', async () => {
    mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', {
      data: {
        id: 'a1', title: 'E2E Assignment', subject: 'Mathematics', chapter: '',
        due_date: '2026-09-01', type: 'assignment', note: '',
        student_id: STUDENT_UUID, created_by_id: TEACHER_UUID, created_by_role: 'teacher',
        created_by_name: 'Ms. Rao', grade: null, curriculum: null, questions: [],
        status: null, score: null, created_at: '2026-08-26T00:00:00.000Z', completed_at: null,
      },
      error: null,
    });

    const res = await request(app).post('/assignments').send({
      title: 'E2E Assignment',
      dueDate: '2026-09-01',
      subject: 'Mathematics',
      studentId: STUDENT_UUID,
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
    expect(res.body.title).toBe('E2E Assignment');
    expect(res.body.studentId).toBe(STUDENT_UUID);
  });

  test('rejects a request missing title or dueDate', async () => {
    const res = await request(app).post('/assignments').send({ title: 'No due date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title and dueDate required/);
  });

  test('rejects a class-wide assignment (no studentId) with no resolvable curriculum', async () => {
    mockSb.setTable('users', { data: null, error: null });

    const res = await request(app).post('/assignments').send({
      title: 'Class-wide',
      dueDate: '2026-09-01',
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/curriculum/);
  });

  test('a real Supabase error on insert returns 500 with the real error message', async () => {
    mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao' }, error: null });
    mockSb.setTable('assignments', { data: null, error: { message: 'insert failed' } });

    const res = await request(app).post('/assignments').send({
      title: 'E2E Assignment',
      dueDate: '2026-09-01',
      studentId: STUDENT_UUID,
      createdById: TEACHER_UUID,
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('insert failed');
  });

  // B05: this service's POST / used to accept only a bare subset of fields
  // (title/subject/dueDate/studentId/questions/quizQuestions) — everything
  // else a teacher fills in through the AI Assignment / IB / worksheet-upload
  // flows (successCriteria, taskSteps, interactiveQuiz, documents, IB fields)
  // was silently dropped when this route (rather than the monolith) handled
  // the create. Assert the full insert payload to prove nothing is lost.
  test('persists the full teacher-authoring field set (success criteria, task steps, IB fields, documents, interactive quiz)', async () => {
    mockSb.setTable('users', { data: { id: TEACHER_UUID, name: 'Ms. Rao', school: 'Lotus School' }, error: null });
    let insertedPayload = null;
    mockSb.supabase.from.mockImplementation((table) => {
      if (table === 'assignments') {
        return {
          insert: jest.fn((payload) => { insertedPayload = payload; return {
            select: () => ({ single: () => Promise.resolve({ data: { id: 'a1', ...payload }, error: null }) }),
          }; }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: TEACHER_UUID, name: 'Ms. Rao', school: 'Lotus School' }, error: null }), in: () => Promise.resolve({ data: [], error: null }) }), in: () => Promise.resolve({ data: [], error: null }) }),
        insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      };
    });

    const res = await request(app).post('/assignments').send({
      title: 'IB Unit Assignment',
      dueDate: '2026-09-20',
      studentId: STUDENT_UUID,
      createdById: TEACHER_UUID,
      grade: 'Grade 4',
      curriculum: 'IB PYP',
      successCriteria: ['Can explain the water cycle'],
      taskSteps: [{ type: 'structured_writing', prompt: 'Describe evaporation' }],
      documentUrl: 'https://cdn.test/worksheet.pdf',
      documentUrls: ['https://cdn.test/worksheet.pdf'],
      centralIdea: 'Water shapes our world',
      linesOfInquiry: ['The water cycle'],
      learnerProfile: 'Inquirer',
      atlSkill: 'Research skills',
      keyConcept: 'Change',
      unitOfInquiry: 'Sharing the Planet',
    });

    expect(res.status).toBe(200);
    expect(insertedPayload).toEqual(expect.objectContaining({
      success_criteria: ['Can explain the water cycle'],
      task_steps: [{ type: 'structured_writing', prompt: 'Describe evaporation' }],
      document_url: 'https://cdn.test/worksheet.pdf',
      document_urls: ['https://cdn.test/worksheet.pdf'],
      central_idea: 'Water shapes our world',
      lines_of_inquiry: ['The water cycle'],
      learner_profile: 'Inquirer',
      atl_skill: 'Research skills',
      key_concept: 'Change',
    }));
  });
});
