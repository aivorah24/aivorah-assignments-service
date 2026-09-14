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

  // Added 2026-09-14 after an architecture review of a real manual-test bug
  // report (missing word bank/passage/example/checklist/credits, wrong
  // numbering). These verify the renderer side of each fix - generic
  // document-agnostic fields, not tied to any one worksheet's wording.
  describe('generic content-preservation fields (word bank, passage, example, checklist, credits)', () => {
    test('quiz.wordBank renders every word, in order', () => {
      const html = renderQuizHTML({ wordBank: ['economy', 'market', 'trade'], tasks: [] }, {});
      expect(html).toContain('economy');
      expect(html).toContain('market');
      expect(html).toContain('trade');
      expect(html.indexOf('economy')).toBeLessThan(html.indexOf('market'));
      expect(html.indexOf('market')).toBeLessThan(html.indexOf('trade'));
    });

    test('an empty/absent wordBank renders no Word Bank section at all (no empty placeholder)', () => {
      const html = renderQuizHTML({ tasks: [] }, {});
      expect(html).not.toContain('Word Bank');
    });

    test('task.passage renders verbatim, unaltered - including intentionally wrong words (the Task 3 error-detection case)', () => {
      const html = renderQuizHTML({
        tasks: [{ title: 'Error Detective', passage: 'A busy buyer sold goods at the consumption.', questions: [{ question: 'Fix it', answer: 'x' }] }],
      }, {});
      expect(html).toContain('A busy buyer sold goods at the consumption.');
    });

    test('task.example renders verbatim (the Task 4 sentence-writing case)', () => {
      const html = renderQuizHTML({
        tasks: [{ title: 'Sentence Challenge', questions: [{ question: 'Write your own', example: 'The buyer went to the market to purchase goods from the seller.', answer: '' }] }],
      }, {});
      expect(html).toContain('The buyer went to the market to purchase goods from the seller.');
    });

    test('quiz.checklist renders every criterion as an interactive checkbox', () => {
      const html = renderQuizHTML({ checklist: ['I can solve the riddles.', 'I can use vocabulary correctly.'], tasks: [] }, {});
      expect(html).toContain('I can solve the riddles.');
      expect(html).toContain('I can use vocabulary correctly.');
      expect(html).toContain('type="checkbox"');
    });

    test('quiz.credits renders verbatim', () => {
      const html = renderQuizHTML({ credits: 'Credits: PYP 4 Team', tasks: [] }, {});
      expect(html).toContain('Credits: PYP 4 Team');
    });
  });

  describe('fmt() HTML-escapes untrusted document content (security)', () => {
    test('a task title containing a script tag is neutralized, not executed as HTML', () => {
      const html = renderQuizHTML({
        tasks: [{ title: '<script>alert(1)</script>', questions: [{ question: 'x', answer: 'y' }] }],
      }, {});
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    test('a passage containing HTML-meaningful characters is escaped, not injected raw', () => {
      const html = renderQuizHTML({
        tasks: [{ title: 'Task', passage: 'Use <b>bold</b> tags carefully & "quote" it.', questions: [{ question: 'x', answer: 'y' }] }],
      }, {});
      expect(html).not.toContain('Use <b>bold</b> tags');
      expect(html).toContain('&lt;b&gt;');
      expect(html).toContain('&amp;');
    });

    test('**markdown bold** still converts to <strong> after escaping (feature preserved)', () => {
      const html = renderQuizHTML({
        tasks: [{ title: 'Task', passage: 'This is **important** text.', questions: [{ question: 'x', answer: 'y' }] }],
      }, {});
      expect(html).toContain('<strong>important</strong>');
    });
  });

  describe('riddle-set table numbering preserves the source\'s sequential numbering, not internal layout ids', () => {
    test('a 10-item "I am..." riddle set numbers rows 1-10, not a-j (the real reported bug)', () => {
      const questions = Array.from({ length: 10 }, (_, i) => ({
        id: String.fromCharCode(97 + i), // a, b, c... — the internal layout id
        question: `I am riddle number ${i + 1}.`,
        answer: `word${i + 1}`,
        type: 'text',
      }));
      const html = renderQuizHTML({ tasks: [{ title: 'Task 1: Read each riddle carefully.', questions }] }, {});
      // The visible "No." column must show sequential digits, not the internal letter ids
      expect(html).toMatch(/>\s*1\s*</);
      expect(html).toMatch(/>\s*10\s*</);
    });
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
