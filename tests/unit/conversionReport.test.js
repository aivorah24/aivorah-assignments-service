// buildConversionReport — added 2026-09-14 (zero-silent-content-loss
// gate). Rolls up findIncompleteTasks/enforceVisualGrounding/
// flagUngroundedTaskContent's independent per-issue detections into one
// per-task status (PRESERVED/REQUIRES_REVIEW/FAILED) and one overall
// status (COMPLETE/REVIEW_REQUIRED), so a partial conversion can never be
// silently presented as a complete one.
//
// Deliberately schema-driven (reads task.questions/table/chart/etc and
// the flags already set by other validators), NOT tied to any specific
// subject, worksheet, or task-type keyword - tested here against Math,
// Science, and English fixtures to prove that, not just against the
// three original example worksheets.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { buildConversionReport, taskHasRealContent } = require('../../services/quizVision');

describe('taskHasRealContent - schema-driven, not task-type-driven', () => {
  test('true for a task with plain questions', () => {
    expect(taskHasRealContent({ questions: [{ question: 'x' }] })).toBeTruthy();
  });
  test('true for a task with only a table (no literal questions array)', () => {
    expect(taskHasRealContent({ questions: [], table: { rows: [[{ text: '1' }]] } })).toBeTruthy();
  });
  test('true for a task with only a chart', () => {
    expect(taskHasRealContent({ questions: [], chart: { bars: [{ label: 'x', value: 1 }] } })).toBeTruthy();
  });
  test('false for a task with nothing at all', () => {
    expect(taskHasRealContent({ questions: [] })).toBe(false);
  });
});

describe('buildConversionReport - generality across different subjects/task-types', () => {
  test('Mathematics fixture (fraction table): all PRESERVED, overall COMPLETE', () => {
    const quiz = { tasks: [{ title: 'Task 2: Reduce fractions', questions: [
      { question: 'Reduce 28/50.', answer: '14/25' },
      { question: 'Reduce 8/24.', answer: '1/3' },
    ] }] };
    const report = buildConversionReport(quiz);
    expect(report.overallStatus).toBe('COMPLETE');
    expect(report.items[0].status).toBe('PRESERVED');
  });

  test('Science fixture (true/false + matching): all PRESERVED, overall COMPLETE - proves no math-specific hardcoding', () => {
    const quiz = { tasks: [
      { title: 'Task 1: True or False', questions: [{ question: 'The sun rises in the east.', type: 'mcq', options: ['True', 'False'], answer: 'True' }] },
      { title: 'Task 2: Match the animal to its habitat', questions: [{ question: 'Fish', type: 'mcq', options: ['Ocean', 'Desert'], answer: 'Ocean' }] },
    ] };
    const report = buildConversionReport(quiz);
    expect(report.overallStatus).toBe('COMPLETE');
    expect(report.taskCount).toBe(2);
    expect(report.items.every(i => i.status === 'PRESERVED')).toBe(true);
  });

  test('English reading-comprehension fixture (passage + open-ended questions): PRESERVED - proves no MCQ-only assumption', () => {
    const quiz = { tasks: [{
      title: 'Comprehension: The Water Cycle',
      passage: 'Water evaporates from oceans, forms clouds, and falls as rain.',
      questions: [
        { question: 'What happens to water after it evaporates?', type: 'text', answer: 'It forms clouds.' },
        { question: 'Why is the water cycle important?', type: 'text', answer: 'It provides fresh water for living things.' },
      ],
    }] };
    const report = buildConversionReport(quiz);
    expect(report.overallStatus).toBe('COMPLETE');
  });

  test('a task with a genuinely unanswerable visual-dependent question is REQUIRES_REVIEW, not silently PRESERVED', () => {
    const quiz = { tasks: [{ title: 'Task: Diagram question', questions: [
      { question: 'What shape is shown?', answer: null, visualUnderstandingRequired: true },
    ] }] };
    const report = buildConversionReport(quiz);
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
    expect(report.items[0].status).toBe('REQUIRES_REVIEW');
    expect(report.items[0].reason).toMatch(/vision-capable/);
  });

  test('a task flagged contentGroundingUncertain is REQUIRES_REVIEW with its own reason', () => {
    const quiz = { tasks: [{ title: 'Task', contentGroundingUncertain: true, contentGroundingNote: 'custom note', questions: [{ question: 'x', answer: 'y' }] }] };
    const report = buildConversionReport(quiz);
    expect(report.items[0].status).toBe('REQUIRES_REVIEW');
    expect(report.items[0].reason).toBe('custom note');
  });

  test('a task with zero content at all is FAILED, and the overall status reflects it - never silently dropped from the report', () => {
    const quiz = { tasks: [
      { title: 'Task 1', questions: [{ question: 'x', answer: 'y' }] },
      { title: 'Task 2', questions: [] },
    ] };
    const report = buildConversionReport(quiz);
    expect(report.taskCount).toBe(2); // both tasks accounted for, even the failed one
    expect(report.items[1].status).toBe('FAILED');
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
  });

  test('mixed worksheet: one preserved, one visual-pending, one grounding-uncertain - the report enumerates all three distinctly', () => {
    const quiz = { tasks: [
      { title: 'Good Task', questions: [{ question: 'x', answer: 'y' }] },
      { title: 'Visual Task', questions: [{ question: 'x', answer: null, visualUnderstandingRequired: true }] },
      { title: 'Uncertain Task', contentGroundingUncertain: true, questions: [{ question: 'x', answer: 'y' }] },
    ] };
    const report = buildConversionReport(quiz);
    expect(report.items.map(i => i.status)).toEqual(['PRESERVED', 'REQUIRES_REVIEW', 'REQUIRES_REVIEW']);
    expect(report.overallStatus).toBe('REVIEW_REQUIRED');
  });

  test('an empty document (zero tasks at all) is reported as FAILED overall, not COMPLETE', () => {
    const report = buildConversionReport({ tasks: [] });
    expect(report.overallStatus).toBe('FAILED');
    expect(report.taskCount).toBe(0);
  });
});
