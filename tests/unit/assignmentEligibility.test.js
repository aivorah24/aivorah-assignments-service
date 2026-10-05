const { isEligibleForClassAssignment } = require('../../services/assignmentEligibility');

const T1 = 'teacher-1';
const base = { curriculum: 'CBSE', grade: 'Grade 4', created_by_role: 'teacher', created_by_id: T1 };
const stu = { curriculum: 'CBSE', grade: 'Grade 4', school: 'Vethathiri' };
const ctx = (o = {}) => ({ studentTeacherIds: new Set([T1]), creatorSchool: 'Vethathiri', ...o });

test.each([
  ['matching curriculum, grade, teacher link and school', base, stu, ctx(), true],
  ['different curriculum', base, { ...stu, curriculum: 'ICSE' }, ctx(), false],
  ['student with no curriculum on a tagged assignment', base, { ...stu, curriculum: null }, ctx(), false],
  ['untagged assignment reaches any curriculum', { ...base, curriculum: null }, { ...stu, curriculum: 'ICSE' }, ctx(), true],
  ['different grade', base, { ...stu, grade: 'Grade 5' }, ctx(), false],
  ['student with no grade does not receive a graded assignment', base, { ...stu, grade: null }, ctx(), false],
  ['broadcast with no creator id (any role)', { ...base, created_by_role: 'school_admin', created_by_id: null }, stu, ctx(), false],
  ['parent broadcast (parents only assign to their own child)', { ...base, created_by_role: 'parent' }, stu, ctx(), false],
  ['teacher broadcast to a student not linked to that teacher', base, stu, ctx({ studentTeacherIds: new Set(['other']) }), false],
  ['teacher broadcast with no creator id', { ...base, created_by_id: null }, stu, ctx(), false],
  ['non-teacher broadcast ignores teacher links', { ...base, created_by_role: 'school_admin' }, stu, ctx({ studentTeacherIds: new Set() }), true],
  ['creator in a different school', base, stu, ctx({ creatorSchool: 'Other School' }), false],
  ['unknown creator school does not block', base, stu, ctx({ creatorSchool: null }), true],
  ['student with no school is not blocked by school', base, { ...stu, school: null }, ctx(), true],
])('%s', (_label, assignment, student, context, expected) => {
  expect(isEligibleForClassAssignment(assignment, student, context)).toBe(expected);
});
