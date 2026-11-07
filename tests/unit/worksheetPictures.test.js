// Picture handling helpers: stacked fractions, table grids, picture-id
// resolution, region pictures, unverified numbers.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { Jimp } = require('jimp');
const { pairFractions, readingOrder } = require('../../services/worksheet/documentModel');
const { findGridCells } = require('../../services/worksheet/pngImage');
const { resolvePictureRefs, attachRegionPictures, dropTextOnlyPictures, attachOrphanPictures } = require('../../services/worksheet/regionCrops');
const { renderQuizHTML } = require('../../utils/quizHtmlRenderer');
const { flagUnverifiedNumbers, buildConversionReport } = require('../../services/quizVision');

const word = (text, x0, y0, x1, y1) => ({ text, confidence: 95, bbox: { x0, y0, x1, y1 } });

describe('pairFractions / readingOrder', () => {
  test('a number directly above another becomes a fraction; item labels stay in order', () => {
    const words = [
      word('28', 216, 13, 240, 40), word('1)', 45, 44, 60, 70), word('50', 215, 58, 240, 85),
      word('8', 220, 290, 232, 317), word('2)', 45, 307, 60, 333), word('24', 217, 334, 241, 361),
    ];
    expect(readingOrder(pairFractions(words))).toBe('1) 28/50 ; 2) 8/24');
  });

  test('side-by-side numbers are not paired', () => {
    expect(readingOrder(pairFractions([word('12', 0, 0, 20, 20), word('13', 40, 0, 60, 20)]))).toBe('12 13');
  });
});

describe('findGridCells', () => {
  const draw = (w, h, lines) => {
    const img = new Jimp({ width: w, height: h, color: 0xffffffff });
    for (const [x0, y0, x1, y1] of lines) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.setPixelColor(0x000000ff, x, y);
    return img;
  };

  test('a 3×2 table drawn in a picture yields 6 enclosed cells, row by row', () => {
    const img = draw(300, 200, [[0, 0, 299, 1], [0, 99, 299, 100], [0, 198, 299, 199], [0, 0, 1, 199], [99, 0, 100, 199], [199, 0, 200, 199], [298, 0, 299, 199]]);
    const cells = findGridCells(img);
    expect(cells).toHaveLength(6);
    expect(cells.map(c => c.row)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  test('a framed picture (one enclosed cell) is not a table', () => {
    expect(findGridCells(draw(300, 200, [[20, 20, 280, 21], [20, 180, 280, 181], [20, 20, 21, 181], [279, 20, 280, 181]]))).toBeNull();
  });
});

describe('resolvePictureRefs', () => {
  const doc = { pictures: [
    { id: 'img://p1-1', url: 'https://cdn.test/a.png', buffer: Buffer.from('a'), mime: 'image/png' },
    { id: 'img://p1-2', url: null, buffer: Buffer.from('b'), mime: 'image/jpeg' },
  ] };

  test('ids become hosted urls, or inline images when hosting is unavailable; invented ids are dropped', () => {
    const quiz = { tasks: [{ questions: [{ imageUrl: 'img://p1-1' }, { imageUrl: 'img://p1-2' }, { imageUrl: 'img://p9-9' }, { imageUrl: 'https://x.test/y.png' }] }] };
    resolvePictureRefs(quiz, doc);
    const urls = quiz.tasks[0].questions.map(q => q.imageUrl);
    expect(urls).toEqual(['https://cdn.test/a.png', `data:image/jpeg;base64,${Buffer.from('b').toString('base64')}`, undefined, 'https://x.test/y.png']);
  });
});

describe('attachRegionPictures', () => {
  const doc = {
    anchors: [
      { page: 1, y: 100, h: 12, text: 'Task 1: Convert the following units of measurement.' },
      { page: 1, y: 400, h: 12, text: 'Task 2: Reduce the fractions to their lowest terms.' },
    ],
    pageSizes: [{ page: 1, width: 600, height: 840 }],
    pictures: [
      { id: 'img://p1-1', page: 1, bbox: { x: 50, y: 130, w: 200, h: 80 }, labels: 'x1000 kg g mg' },
      { id: 'img://p1-2', page: 1, bbox: { x: 50, y: 430, w: 90, h: 150 }, labels: '1) 28/50 ; 2) 8/24' },
      { id: 'img://p1-3', page: 1, bbox: { x: 400, y: 700, w: 60, h: 60 }, labels: '' },
    ],
  };

  test('a task left without a picture gets the informative picture from its own region', () => {
    const quiz = { tasks: [
      { title: 'Task 1: Convert the following units of measurement.', questions: [{ question: '4 kg = ___ gm' }] },
      { title: 'Task 2: Reduce the fractions to their lowest terms.', questions: [{ question: '28/50' }] },
    ] };
    attachRegionPictures(quiz, doc);
    expect(quiz.tasks[0].questions[0].imageUrl).toBe('img://p1-1');
    expect(quiz.tasks[0].sharedImage).toBe(true);
    expect(quiz.tasks[1].questions[0].imageUrl).toBe('img://p1-2');
  });

  test('a label-less decorative picture is not forced onto a task that does not need one', () => {
    const quiz = { tasks: [{ title: 'Task 2: Reduce the fractions to their lowest terms.', questions: [{ question: 'x' }] }] };
    attachRegionPictures(quiz, { ...doc, pictures: [doc.pictures[2]] });
    expect(quiz.tasks[0].questions[0].imageUrl).toBeUndefined();
  });
});

describe('flagUnverifiedNumbers', () => {
  test('text-only: a number missing from the transcript flags the task for review', () => {
    const quiz = { tasks: [{ title: 'Task 2', questions: [
      { question: 'Reduce 28/50', answer: '14/25', solution: 's' },
      { question: 'Reduce 24/36', answer: '2/3', solution: 's' },
    ] }] };
    flagUnverifiedNumbers(quiz, { visualUnderstandingAvailable: false, sourceText: 'Task 2 (text in picture: 1) 28/50 ; 2) 8/24)' });
    expect(quiz.tasks[0].questions[0].unverifiedValues).toBeUndefined();
    expect(quiz.tasks[0].questions[1].unverifiedValues).toEqual(['36']);
    const report = buildConversionReport(quiz, { sourceText: '' });
    expect(report.items[0].status).toBe('REQUIRES_REVIEW');
    expect(report.items[0].reason).toMatch(/36/);
  });

  test('a vision provider read the page itself: no flags', () => {
    const quiz = { tasks: [{ title: 'T', questions: [{ question: 'Reduce 24/36' }] }] };
    flagUnverifiedNumbers(quiz, { visualUnderstandingAvailable: true, sourceText: 'nothing' });
    expect(quiz.tasks[0].unverifiedValues).toBeUndefined();
  });
});

describe('dropTextOnlyPictures (MHLE-29: the Task 2 picture repeated Q1–Q4 under Q1)', () => {
  const doc = { pictures: [
    { id: 'img://p1-1', labels: 'x1000 x1000 ; KL L mL' },
    { id: 'img://p1-2', labels: '1) 28/50 ; 8/24 ; 30/54 ; 18/42' },
    { id: 'img://p1-4', labels: '5 32/48 ; 36/54' },
    { id: 'img://p2-5', labels: '7 6 | 1/2 9/9 | se 2' },
  ] };

  test('a picture that only prints the task\'s own questions is dropped, and no crop replaces it', () => {
    const task = { title: 'Task 2', questions: [
      { question: '28/50', imageUrl: 'img://p1-2', hasImage: true }, { question: '8/24' }, { question: '30/54' }, { question: '18/42' },
      { question: '32/48', imageUrl: 'img://p1-4', hasImage: true }, { question: '36/54' },
    ] };
    expect(dropTextOnlyPictures({ tasks: [task] }, doc)).toBe(1);
    expect(task.questions.some(q => q.imageUrl || q.hasImage)).toBe(false);
    expect(task.picturesAsText).toBe(true);
  });

  test('a chart whose content is not in the questions stays (Task 1: ×1000 arrows)', () => {
    const task = { title: 'Task 1', questions: [{ question: '4 kg = ___ gm', imageUrl: 'img://p1-1' }, { question: '1000 ml = ___ l' }] };
    dropTextOnlyPictures({ tasks: [task] }, doc);
    expect(task.questions[0].imageUrl).toBe('img://p1-1');
  });

  test('a picture with values the questions do not have stays (Task 4: unread table)', () => {
    const task = { title: 'Task 4', questions: [{ question: '1/2 ☐ 9/9', imageUrl: 'img://p2-5' }] };
    dropTextOnlyPictures({ tasks: [task] }, doc);
    expect(task.questions[0].imageUrl).toBe('img://p2-5');
  });

  test('a diagram whose labels the model copied into its question stays (perimeter of a shape)', () => {
    const shape = { pictures: [{ id: 'img://p1-1', labels: '5m ; 6m ; 8m ; 3m' }] };
    const task = { title: 'Task 1', questions: [
      { question: 'Find the perimeter: sides 5m, 6m, 8m, 3m', imageUrl: 'img://p1-1' }, { question: 'Find the area' },
    ] };
    expect(dropTextOnlyPictures({ tasks: [task] }, shape)).toBe(0);
    expect(task.questions[0].imageUrl).toBe('img://p1-1');
  });

  test('a drawn diagram is never dropped, even when its values are spread over the questions', () => {
    const drawn = { pictures: [{ id: 'img://p1-1', labels: '3 cm ; 4 cm ; 5 cm', vector: true }] };
    const task = { title: 'Triangle', questions: [
      { question: 'Side AB is 3 cm', imageUrl: 'img://p1-1' }, { question: 'Side BC is 4 cm' }, { question: 'Side AC is 5 cm' },
    ] };
    dropTextOnlyPictures({ tasks: [task] }, drawn);
    expect(task.questions[0].imageUrl).toBe('img://p1-1');
  });

  test('vertex letters are not values: a lettered figure stays', () => {
    const lettered = { pictures: [{ id: 'img://p1-1', labels: 'A ; B ; C' }] };
    const task = { title: 'T', questions: [{ question: 'Name A', imageUrl: 'img://p1-1' }, { question: 'Name B' }, { question: 'Name C' }] };
    dropTextOnlyPictures({ tasks: [task] }, lettered);
    expect(task.questions[0].imageUrl).toBe('img://p1-1');
  });
});

describe('attachOrphanPictures (a diagram the model left out of every question)', () => {
  const doc = {
    anchors: [
      { page: 1, y: 100, h: 12, text: 'Task 1: Answer the geometry questions.' },
      { page: 1, y: 130, h: 12, text: '1. Find the perimeter of the rectangle below.' },
      { page: 1, y: 260, h: 12, text: '2. Measure the angle in the triangle below.' },
      { page: 1, y: 400, h: 12, text: '3. Name a shape with four equal sides.' },
    ],
    pictures: [
      { id: 'img://p1-1', page: 1, bbox: { x: 60, y: 150, w: 160, h: 90 }, labels: '8 cm ; 5 cm', vector: true },
      { id: 'img://p1-2', page: 1, bbox: { x: 60, y: 280, w: 160, h: 100 }, labels: 'A ; B ; C', vector: true },
      { id: 'img://p1-3', page: 1, bbox: { x: 60, y: 420, w: 60, h: 60 }, labels: '' },
    ],
  };
  const quiz = () => ({ tasks: [{ title: 'Task 1: Answer the geometry questions.', questions: [
    { question: 'Find the perimeter of the rectangle.' },
    { question: 'Measure the angle in the triangle.' },
    { question: 'Name a shape with four equal sides.' },
  ] }] });

  test('each drawn diagram goes to the question printed just above it', () => {
    const q = quiz();
    expect(attachOrphanPictures(q, doc)).toBe(2);
    expect(q.tasks[0].questions.map(x => x.imageUrl)).toEqual(['img://p1-1', 'img://p1-2', undefined]);
  });

  test('an embedded picture goes only to a question that needs one; dropped and used pictures are left alone', () => {
    const q = quiz();
    q.tasks[0].questions[0].imageUrl = 'img://p1-2';
    expect(attachOrphanPictures(q, doc, new Set(['img://p1-1']))).toBe(0);
    q.tasks[0].questions[2].hasImage = true;
    expect(attachOrphanPictures(q, doc, new Set(['img://p1-1']))).toBe(1);
    expect(q.tasks[0].questions[2].imageUrl).toBe('img://p1-3');
  });

  test('a task whose pictures were turned into text gets none back', () => {
    const q = quiz();
    q.tasks[0].picturesAsText = true;
    expect(attachOrphanPictures(q, doc)).toBe(0);
  });
});

describe('student page: fractions and worked examples', () => {
  const quiz = { title: 'Fractions', tasks: [{ title: 'Task 2: Reduce', example: 'To reduce 18/21 divide by 3', questions: [
    { id: '1', type: 'fraction', question: '28/50', answer: '14/25' },
    { id: '2', type: 'text', question: 'Is 1/2 < 9/9? Due 13/03/2026', answer: 'yes' },
  ] }] };
  const html = renderQuizHTML(JSON.parse(JSON.stringify(quiz)), {});

  test('fractions are stacked as printed; dates are not', () => {
    expect(html).toContain('<span class="frac"><span>28</span><span>50</span></span>');
    expect(html).toContain('13/03/2026');
    expect(html).not.toMatch(/<span>13<\/span><span>03/);
  });

  test('question text from the document is escaped', () => {
    expect(html).toContain('&lt; <span class="frac"><span>9</span><span>9</span></span>');
  });

  test('the task\'s worked example is shown', () => {
    expect(html).toMatch(/task-example[^>]*>.*Example:.*To reduce <span class="frac"><span>18<\/span><span>21<\/span><\/span>/);
  });
});
