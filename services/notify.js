// Notification V2 producer: builds the business event and hands it to the DB
// function notify_event() (aivorah-db 0006), which fans out to students + parents
// idempotently. Never throws — the assignment is already saved when this runs.
const supabase = require('./supabase');

function logEvent(fields) {
  console.log(JSON.stringify({ svc: 'assignments', ...fields }));
}

function formatDue(dueDate) {
  if (!dueDate) return null;
  const d = new Date(String(dueDate).includes('T') ? dueDate : `${dueDate}T00:00:00Z`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : null;
}

function assignmentAssignedEvent(assignment, { studentIds, actorEmail, actorRole }) {
  const label = assignment.type === 'quiz' ? 'quiz' : 'assignment';
  const due = formatDue(assignment.due_date);
  const body = [assignment.subject || null, due ? `Due ${due}` : null].filter(Boolean).join(' · ') || null;
  return {
    type: 'assignment_assigned',
    entity_type: 'assignment',
    entity_id: String(assignment.id),
    version: assignment.created_at,
    student_ids: studentIds,
    actor_email: actorEmail || null,
    actor_role: actorRole || null,
    title: `New ${label}: ${assignment.title}`,
    body,
    parent_title: `New ${label} for {child}: ${assignment.title}`,
    parent_body: body,
    data: {
      assignmentId: String(assignment.id),
      assignmentType: assignment.type || 'assignment',
      subject: assignment.subject || null,
      dueDate: assignment.due_date || null,
    },
  };
}

function assignmentFeedbackEvent(assignment, { studentId, feedback, version, actorEmail, edited = false }) {
  const label = assignment?.type === 'quiz' ? 'quiz' : 'assignment';
  const name = assignment?.title ? `: ${assignment.title}` : '';
  const text = String(feedback || '').trim();
  const body = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  return {
    type: 'assignment_feedback',
    entity_type: 'assignment',
    entity_id: String(assignment?.id),
    version,
    student_ids: [studentId],
    actor_email: actorEmail || null,
    actor_role: 'teacher',
    title: `${edited ? 'Teacher updated feedback' : 'Teacher feedback'} on your ${label}${name}`,
    body: body || null,
    parent_title: `${edited ? 'Teacher updated feedback' : 'Teacher feedback'} for {child}${name}`,
    parent_body: body || null,
    data: {
      assignmentId: String(assignment?.id),
      assignmentType: assignment?.type || 'assignment',
      subject: assignment?.subject || null,
      edited,
    },
  };
}

async function createNotificationEvent(evt) {
  const base = { evt: 'notification.create', type: evt.type, entityType: evt.entity_type, entity: evt.entity_id };
  if (!evt.student_ids?.length) {
    logEvent({ ...base, ok: true, recipients: 0, inserted: 0, reason: 'no eligible students' });
    return { ok: true, inserted: [], recipients: 0, duplicates: 0 };
  }
  try {
    const { data, error } = await supabase.rpc('notify_event', { p_event: evt });
    if (error) throw new Error(error.message);
    const inserted = data?.inserted ?? [];
    logEvent({
      ...base, ok: true, eventKey: data?.eventKey, students: evt.student_ids.length,
      recipients: data?.recipients ?? 0, inserted: inserted.length, duplicates: data?.duplicates ?? 0,
      orphanParentLinks: data?.orphanParentLinks ?? 0, notificationIds: inserted.map(r => r.id),
    });
    return { ok: true, inserted, recipients: data?.recipients ?? 0, duplicates: data?.duplicates ?? 0 };
  } catch (err) {
    logEvent({ ...base, ok: false, students: evt.student_ids.length, reason: err.message });
    return { ok: false, error: err.message };
  }
}

// Clears (marks read) open notifications for an assignment: a student's (and their
// parents' rows about that child) after they submit, or everyone's after a delete. Never throws.
async function clearNotificationsForEntity({ entityId, studentId, reason }) {
  const base = { evt: 'notification.clear', entityType: 'assignment', entity: String(entityId), reason };
  try {
    let q = supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('entity_type', 'assignment')
      .eq('entity_id', String(entityId))
      .is('read_at', null);
    // Without a student (assignment deleted) every recipient's row is stale.
    if (studentId) q = q.or(`recipient_id.eq.${studentId},child_id.eq.${studentId}`);
    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    logEvent({ ...base, ok: true, cleared: (data || []).length });
    return { ok: true, cleared: (data || []).length };
  } catch (err) {
    logEvent({ ...base, ok: false, reason: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { assignmentAssignedEvent, assignmentFeedbackEvent, createNotificationEvent, clearNotificationsForEntity, formatDue };
