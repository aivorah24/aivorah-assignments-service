/**
 * A teacher's private assignment library (table teacher_assignment_library).
 *
 * Every assignment a teacher creates through POST /assignments is also kept
 * here: the same body, minus who/when it was assigned to. Assigning it again
 * later (to a new student, or the class) re-sends that content to POST
 * /assignments with a new due date and recipient. One row per distinct
 * content per teacher: the same content again bumps times_assigned.
 */
const crypto = require('crypto');
const supabase = require('./supabase');

// Per-assignment fields: who it goes to and when - not part of the reusable content.
const NOT_CONTENT = new Set([
  'dueDate', 'startDate', 'studentId', 'studentName', 'createdById', 'createdByRole',
  // re-rendered from interactiveQuiz on every POST /assignments
  'interactiveQuizHtml',
  // marks a re-assign from the library; not content
  'libraryItemId',
]);

function contentFromBody(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (NOT_CONTENT.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Same JSON whatever the key order, so equal content always hashes the same.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

const hashContent = (content) => crypto.createHash('sha256').update(stableStringify(content)).digest('hex');

/**
 * Keep a teacher-created assignment in their library (or count it again).
 * Never throws: the assignment itself was already created.
 */
async function saveToLibrary({ teacherId, body, assignment }) {
  if (!teacherId) return null;
  try {
    const content = contentFromBody(body);
    const contentHash = hashContent(content);
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from('teacher_assignment_library')
      .select('id, times_assigned')
      .eq('teacher_id', teacherId)
      .eq('content_hash', contentHash)
      .maybeSingle();
    if (existing) {
      await supabase.from('teacher_assignment_library')
        .update({ times_assigned: (existing.times_assigned || 1) + 1, last_assigned_at: now })
        .eq('id', existing.id);
      return existing.id;
    }
    const { data, error } = await supabase.from('teacher_assignment_library').insert({
      teacher_id: teacherId,
      title: String(content.title || assignment?.title || 'Untitled').trim(),
      type: content.type || assignment?.type || 'assignment',
      subject: content.subject || assignment?.subject || null,
      chapter: content.chapter || assignment?.chapter || null,
      grade: assignment?.grade || content.grade || null,
      curriculum: assignment?.curriculum || content.curriculum || null,
      content,
      content_hash: contentHash,
      source_assignment_id: assignment?.id || null,
      last_assigned_at: now,
    }).select('id').single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    console.log(JSON.stringify({ svc: 'assignments', evt: 'library.save', ok: false, reason: err.message }));
    return null;
  }
}

const SUMMARY = 'id, title, type, subject, chapter, grade, curriculum, times_assigned, created_at, last_assigned_at';

async function listLibrary(teacherId) {
  const { data, error } = await supabase
    .from('teacher_assignment_library')
    .select(SUMMARY)
    .eq('teacher_id', teacherId)
    .order('last_assigned_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// One item with its full content - only if it belongs to this teacher.
async function getLibraryItem(teacherId, id) {
  const { data, error } = await supabase
    .from('teacher_assignment_library')
    .select(`${SUMMARY}, content`)
    .eq('id', id)
    .eq('teacher_id', teacherId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function deleteLibraryItem(teacherId, id) {
  const { data, error } = await supabase
    .from('teacher_assignment_library')
    .delete()
    .eq('id', id)
    .eq('teacher_id', teacherId)
    .select('id');
  if (error) throw error;
  return (data || []).length > 0;
}

module.exports = {
  contentFromBody, stableStringify, hashContent,
  saveToLibrary, listLibrary, getLibraryItem, deleteLibraryItem,
};
