// Single definition of "does this student receive this class-wide assignment".
// Used by GET /assignments (visibility) and by notification recipient resolution,
// so the two can never drift apart.
function isEligibleForClassAssignment(assignment, student, { studentTeacherIds, creatorSchool }) {
  const a = assignment;
  // Deny by default: a broadcast needs a known owner; parents only assign to their own child.
  if (!a.created_by_id) return false;
  if (a.created_by_role === 'parent') return false;
  if (a.curriculum) {
    if (!student.curriculum) return false;
    if (a.curriculum !== student.curriculum) return false;
  }
  if (a.grade && a.grade !== student.grade) return false;
  // Teacher broadcasts reach only that teacher's linked students; other roles stay curriculum-wide.
  if (a.created_by_role === 'teacher') {
    if (!a.created_by_id || !studentTeacherIds.has(a.created_by_id)) return false;
  }
  if (a.created_by_id && creatorSchool && student.school && creatorSchool !== student.school) return false;
  return true;
}

module.exports = { isEligibleForClassAssignment };
