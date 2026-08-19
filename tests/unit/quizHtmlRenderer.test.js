const { renderQuizHTML, solveVerticalMath } = require('../../utils/quizHtmlRenderer');

describe('renderQuizHTML', () => {
  test('renders a real non-empty HTML document for an empty task list, without crashing', () => {
    const html = renderQuizHTML({ tasks: [] }, {});
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('<html');
  });

  test('renders real question text into the HTML for a minimal MCQ task', () => {
    const html = renderQuizHTML({
      tasks: [{ title: 'Addition', questions: [{ type: 'mcq', question: 'What is 2+2?', options: ['3', '4', '5', '6'], answer: '4' }] }],
    }, {});
    expect(html).toContain('What is 2+2?');
  });
});

describe('solveVerticalMath', () => {
  test('returns not solvable for a real missing top/bottom row', () => {
    expect(solveVerticalMath({}).solvable).toBe(false);
    expect(solveVerticalMath(null).solvable).toBe(false);
  });

  test('a real fully-specified sum with nothing missing is not this feature\'s concern', () => {
    // solveVerticalMath exists to fill in a MISSING digit — a problem with
    // every digit already shown has nothing to solve for.
    const result = solveVerticalMath({ top: '23', bottom: '45', operator: '+', result: '68' });
    expect(result.solvable).toBe(false);
  });

  test('solves a real missing top digit from a shown result', () => {
    // 2_ + 45 = 68 → the missing top units digit must be 3.
    const result = solveVerticalMath({ top: '2_', bottom: '45', operator: '+', result: '68' });
    expect(result.solvable).toBe(true);
    expect(result.solvedTopStr).toBe('23');
  });
});
