const { makeFakeSupabase } = require('../helpers/fakeSupabase');

let mockFake;
jest.mock('../../services/supabase', () => ({
  from: (...a) => mockFake.from(...a),
}));
const { resolveClassRecipients } = require('../../services/assignmentRecipients');

const T1 = 't1';
const users = [
  { id: 's1', role: 'student', curriculum: 'CBSE', grade: 'Grade 4', school: 'A' },
  { id: 's2', role: 'student', curriculum: 'CBSE', grade: 'Grade 5', school: 'A' }, // wrong grade
  { id: 's3', role: 'student', curriculum: 'ICSE', grade: 'Grade 4', school: 'A' }, // wrong curriculum
  { id: 's4', role: 'student', curriculum: 'CBSE', grade: 'Grade 4', school: 'B' }, // other school
  { id: 's5', role: 'student', curriculum: 'CBSE', grade: null, school: 'A' },       // no grade → not eligible for a graded item
  { id: 's6', role: 'student', curriculum: 'CBSE', grade: 'Grade 4', school: 'A' }, // not linked to t1
  { id: 'p1', role: 'parent', curriculum: 'CBSE', grade: 'Grade 4', school: 'A' },  // not a student
];
const teacher_student = ['s1', 's2', 's3', 's4', 's5', 'p1'].map(student_id => ({ teacher_id: T1, student_id }));

const classWide = (o = {}) => ({
  id: 'a1', student_id: null, curriculum: 'CBSE', grade: 'Grade 4',
  created_by_role: 'teacher', created_by_id: T1, ...o,
});

beforeEach(() => { mockFake = makeFakeSupabase({ users, teacher_student }); });

test('individual assignment → exactly that student, no queries', async () => {
  expect(await resolveClassRecipients({ id: 'a1', student_id: 's9' }, 'A')).toEqual(['s9']);
  expect(mockFake.calls).toEqual([]);
});

test('teacher broadcast → only that teacher’s linked students who pass curriculum/grade/school', async () => {
  expect(await resolveClassRecipients(classWide(), 'A')).toEqual(['s1']);
});

test('teacher broadcast with no linked students → nobody', async () => {
  mockFake = makeFakeSupabase({ users, teacher_student: [] });
  expect(await resolveClassRecipients(classWide(), 'A')).toEqual([]);
});

test('teacher broadcast without a creator id → nobody (matches GET /assignments)', async () => {
  expect(await resolveClassRecipients(classWide({ created_by_id: null }), 'A')).toEqual([]);
});

test('non-teacher broadcast → curriculum-wide students, school-scoped, no teacher link needed', async () => {
  const r = await resolveClassRecipients(classWide({ created_by_role: 'school_admin', created_by_id: 'admin1' }), 'A');
  expect(r).toEqual(['s1', 's6']);
});

test('non-teacher, untagged curriculum → every student in the creator school with a matching grade', async () => {
  const r = await resolveClassRecipients(classWide({ created_by_role: 'school_admin', created_by_id: 'admin1', curriculum: null }), 'A');
  expect(r).toEqual(['s1', 's3', 's6']);
});

test('reads past the 1000-row page limit', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({
    id: `x${String(i).padStart(4, '0')}`, role: 'student', curriculum: 'CBSE', grade: 'Grade 4', school: 'A',
  }));
  mockFake = makeFakeSupabase({ users: many, teacher_student: [] });
  const r = await resolveClassRecipients(classWide({ created_by_role: 'school_admin', created_by_id: 'admin1' }), 'A');
  expect(r).toHaveLength(1500);
});
