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

describe('solution formatting and explanation questions', () => {
  const answersOf = (html) => JSON.parse(html.match(/const answers = (\{.*?\});\n/s)[1]);
  const render = (q) => renderQuizHTML({ tasks: [{ title: 'Task', questions: [{ id: 'a', ...q }] }] }, {});

  test('solution markup renders as HTML, never as literal escaped tags', () => {
    const html = render({ type: 'text', question: 'How much?', answer: '2700 ml', solution: 'Step 1 add. Step 2 compare. Answer: 12 m' });
    expect(html).not.toMatch(/&lt;(strong|br)&gt;/);
    expect(html).toContain('<br><strong>Answer:</strong>');
  });

  test('units are bolded whole, so "900 ml" is not split into "900 m" + "l"', () => {
    const html = render({ type: 'text', question: 'Total?', answer: '2700 ml', solution: '3 × 900 ml = 2700 ml. The fence is 12 m long.' });
    expect(html).toContain('900 ml');
    expect(html).not.toContain('900 m</strong>l');
    expect(html).toContain('<strong>12 m</strong>');
  });

  test('user-supplied angle brackets in a solution are still escaped', () => {
    const html = render({ type: 'text', question: 'Compare', answer: 'x', solution: '3 < 5 <script>' });
    expect(html).toContain('3 &lt; 5 &lt;script&gt;');
  });

  test.each([
    'Can three 900 ml bottles be poured into a 2900 l jar? Explain.',
    'Is 3/4 bigger than 2/3? Justify your answer.',
    'Solve 12 × 4 and show your thinking.',
  ])('"%s" accepts any genuine attempt (open-ended) instead of exact match', (question) => {
    const html = render({ type: 'text', question, answer: 'Yes, because 2700 ml is less than 2900 l.', solution: 'x' });
    expect(answersOf(html).q1.open).toBe(true);
  });

  test('a plain numeric question still uses strict checking', () => {
    const html = render({ type: 'numeric', question: '4 kg = ___ g', answer: '4000' });
    expect(answersOf(html).q1.open).toBeFalsy();
  });

  // 2026-10-13 manual test: IB worksheet pictures were squeezed to fixed
  // 200-320px boxes (wide diagrams unreadable, overflow on phones), a quote in
  // the AI description broke the <img> tag, and a dead URL showed a broken icon.
  describe('worksheet pictures', () => {
    const quizWith = (q, task = {}) => ({ tasks: [{ title: 'Look and answer', ...task, questions: [{ question: 'What is shown?', answer: 'x', ...q }] }] });

    test('pictures use the responsive wk-img class, not fixed pixel widths', () => {
      const html = renderQuizHTML(quizWith({ imageUrl: 'https://res.cloudinary.com/demo/w.png' }), {});
      expect(html).toMatch(/<img class="wk-img" onerror="wkImgError\(this\)" src="https:\/\/res\.cloudinary\.com\/demo\/w\.png"/);
      const css = html.match(/\.wk-img \{[^}]*\}/)[0];
      expect(css).toContain('max-width:100%');
      expect(css).toContain('height:auto');
      expect(css).toContain('object-fit:contain');
      expect(html).not.toMatch(/<img[^>]*style="max-width:(200|240|320)px/);
    });

    test('a quote in the image description cannot break the <img> tag', () => {
      const html = renderQuizHTML(quizWith({ imageUrl: 'https://x.test/a.png', diagramDescription: 'A "big" cat' }), {});
      expect(html).toContain('alt="A &quot;big&quot; cat"');
    });

    test('a shared task picture renders once, responsive', () => {
      const html = renderQuizHTML(quizWith({ imageUrl: 'https://x.test/shared.png' }, { sharedImage: true }), {});
      expect(html.match(/x\.test\/shared\.png/g)).toHaveLength(1);
      expect(html).toMatch(/<img class="wk-img"[^>]*shared\.png/);
    });

    test('a picture that fails to load is replaced by a note (handler defined in <head>)', () => {
      const html = renderQuizHTML(quizWith({ imageUrl: '/data/images/quiz/gone.png' }), {});
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head).toContain('function wkImgError(img)');
      expect(head).toContain('Picture unavailable');
    });
  });
});
