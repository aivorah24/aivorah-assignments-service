const supabase = require('./supabase');
const { isEligibleForClassAssignment } = require('./assignmentEligibility');

const PAGE = 1000;
const STUDENT_COLUMNS = 'id, role, curriculum, grade, school';

async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

// Students who receive a class-wide assignment at the moment it is created.
// Later joiners see the assignment via GET /assignments but get no notification.
async function resolveClassRecipients(assignment, creatorSchool) {
  if (assignment.student_id) return [assignment.student_id];

  let candidates;
  let studentTeacherIds;
  if (assignment.created_by_role === 'teacher') {
    if (!assignment.created_by_id) return [];
    const links = await fetchAll(() => supabase.from('teacher_student')
      .select('student_id').eq('teacher_id', assignment.created_by_id).order('student_id'));
    const ids = [...new Set(links.map(l => l.student_id).filter(Boolean))];
    if (ids.length === 0) return [];
    candidates = await fetchAll(() => supabase.from('users').select(STUDENT_COLUMNS)
      .in('id', ids).eq('role', 'student').order('id'));
    // Every candidate came from this teacher's links.
    studentTeacherIds = new Set([assignment.created_by_id]);
  } else {
    candidates = await fetchAll(() => {
      let q = supabase.from('users').select(STUDENT_COLUMNS).eq('role', 'student').order('id');
      if (assignment.curriculum) q = q.eq('curriculum', assignment.curriculum);
      return q;
    });
    studentTeacherIds = new Set();
  }

  return candidates
    .filter(s => isEligibleForClassAssignment(assignment, s, { studentTeacherIds, creatorSchool }))
    .map(s => s.id);
}

module.exports = { resolveClassRecipients };
