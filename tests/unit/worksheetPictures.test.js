// Picture handling helpers: stacked fractions, table grids, picture-id
// resolution, region pictures, unverified numbers.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { Jimp } = require('jimp');
const { pairFractions, readingOrder, insertBlanks } = require('../../services/worksheet/documentModel');
const { findGridCells, findFractionBars, estimateSkew, straighten, jimpFromPng, pngBuffer, findPictureRegions, findUnderlines } = require('../../services/worksheet/pngImage');
const { resolvePictureRefs, attachRegionPictures, dropTextOnlyPictures } = require('../../services/worksheet/regionCrops');
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

describe('findFractionBars', () => {
  const rect = (img, x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.setPixelColor(0x000000ff, x, y); };
  // "digits" as solid blocks: 3/4 □ 5/6
  const img = new Jimp({ width: 200, height: 80, color: 0xffffffff });
  rect(img, 22, 10, 30, 30); rect(img, 18, 36, 37, 37); rect(img, 22, 43, 30, 63); // fraction 1
  rect(img, 60, 20, 85, 21); rect(img, 60, 50, 85, 51); rect(img, 60, 20, 61, 51); rect(img, 84, 20, 85, 51); // box
  rect(img, 122, 10, 130, 30); rect(img, 118, 36, 137, 37); rect(img, 122, 43, 130, 63); // fraction 2

  test('finds each bar with its numerator and denominator bands, and the answer box', () => {
    const { bars, boxes } = findFractionBars(img);
    expect(bars.map(b => [b.x0, b.y, b.num.y, b.num.h, b.den.y, b.den.h])).toEqual([[18, 36, 10, 21, 43, 21], [118, 36, 10, 21, 43, 21]]);
    expect(boxes).toEqual([{ x: 60, y: 20, w: 26, h: 32 }]);
  });

  test('an underline with nothing below it is not a fraction', () => {
    const u = new Jimp({ width: 100, height: 60, color: 0xffffffff });
    rect(u, 20, 10, 60, 30); rect(u, 18, 34, 62, 35);
    expect(findFractionBars(u).bars).toEqual([]);
  });
});

describe('estimateSkew / straighten', () => {
  // Lines of "text" (short dashes with gaps) on a page lying on a dark table.
  const page = () => {
    const img = new Jimp({ width: 600, height: 500, color: 0x000000ff });
    for (let y = 40; y < 460; y++) for (let x = 40; x < 560; x++) img.setPixelColor(0xffffffff, x, y);
    for (let y = 80; y < 420; y += 24) for (let x = 70; x < 530; x += 14) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 9; dx++) img.setPixelColor(0x000000ff, x + dx, y + dy);
    return img;
  };

  test('a level page reads 0°; a tilted one reads its tilt, despite the dark table', () => {
    expect(Math.abs(estimateSkew(page()))).toBeLessThan(0.3);
    const tilted = page(); tilted.rotate({ deg: 2, mode: true });
    expect(Math.abs(Math.abs(estimateSkew(tilted)) - 2)).toBeLessThanOrEqual(0.3);
  });

  test('straighten levels a tilted photo and leaves a level one untouched', () => {
    const tilted = page(); tilted.rotate({ deg: -2.5, mode: true });
    expect(Math.abs(estimateSkew(jimpFromPng(straighten(pngBuffer(tilted)))))).toBeLessThanOrEqual(0.3);
    const level = pngBuffer(page());
    expect(straighten(level)).toBe(level);
  });
});

describe('findPictureRegions (pictures inside a photo)', () => {
  const rect = (img, x0, y0, x1, y1, c = 0x000000ff) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.setPixelColor(c, x, y); };
  // A sheet on a dark table: a text line, a framed text box, and a drawing.
  const photo = () => {
    const img = new Jimp({ width: 800, height: 1000, color: 0x202020ff });
    rect(img, 40, 40, 760, 960, 0xffffffff);
    rect(img, 100, 100, 600, 112); // text line (OCR box given)
    rect(img, 100, 200, 700, 201); rect(img, 100, 300, 700, 301); rect(img, 100, 200, 101, 301); rect(img, 699, 200, 700, 301); // frame
    rect(img, 120, 240, 600, 252); // text inside the frame (OCR box given)
    for (let i = 0; i < 200; i += 8) rect(img, 200 + i, 500 + i, 205 + i, 505 + i); // a drawing: a diagonal
    rect(img, 200, 500, 400, 503); rect(img, 200, 500, 203, 700);
    return img;
  };
  const text = [{ x: 98, y: 98, w: 505, h: 17 }, { x: 118, y: 238, w: 485, h: 17 }];

  test('finds the drawing, marks the text box as a frame, and ignores text and the table', () => {
    const regions = findPictureRegions(photo(), text);
    const drawing = regions.filter(r => !r.frame);
    expect(drawing).toHaveLength(1);
    expect(drawing[0].x).toBeLessThanOrEqual(200);
    expect(drawing[0].y).toBeLessThanOrEqual(500);
    expect(drawing[0].x + drawing[0].w).toBeGreaterThanOrEqual(400);
    expect(drawing[0].y + drawing[0].h).toBeGreaterThanOrEqual(700);
    const frames = regions.filter(r => r.frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].y).toBeLessThanOrEqual(200);
  });
});

describe('printed blanks (findUnderlines / insertBlanks)', () => {
  const rect = (img, x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.setPixelColor(0x000000ff, x, y); };
  const line = (words, y0 = 100, y1 = 130) => ({ text: words.map(w => w[0]).join(' '), confidence: 80, bbox: { x0: words[0][1], y0, x1: words[words.length - 1][2], y1 },
    words: words.map(([text, x0, x1, confidence = 90]) => ({ text, confidence, bbox: { x0, y0, x1, y1 } })) });

  test('an empty answer line is found; underlined text and a box edge are not', () => {
    const img = new Jimp({ width: 600, height: 300, color: 0xffffffff });
    rect(img, 100, 50, 260, 51); // blank
    rect(img, 100, 120, 260, 121); rect(img, 105, 100, 250, 115); // underlined word
    rect(img, 300, 200, 460, 201); rect(img, 300, 170, 301, 201); rect(img, 459, 170, 460, 201); // box bottom
    expect(findUnderlines(img, { minLen: 30 })).toEqual([{ x0: 100, x1: 260, y: 50 }]);
  });

  test('a blank goes into the word gap it sits in', () => {
    const lines = [line([['a)', 10, 30], ['4', 40, 52], ['kg', 60, 85], ['=', 95, 105], ['gm', 260, 290]])];
    insertBlanks(lines, [{ x0: 120, x1: 240, y: 128 }]);
    expect(lines[0].text).toBe('a) 4 kg = ____ gm');
  });

  test('a line OCR read as a dash, or folded into the next word, still becomes one blank', () => {
    const lines = [line([['e)5l=—', 10, 120, 30], ['ml', 130, 400, 30]])];
    insertBlanks(lines, [{ x0: 130, x1: 360, y: 128 }]);
    expect(lines[0].text).toBe('e)5l= ____ ml');
    expect(lines[0].words.find(w => w.text === 'ml').confidence).toBeGreaterThanOrEqual(60);
  });

  test('a line under a word is not a blank', () => {
    const lines = [line([['Read', 10, 80], ['carefully', 90, 200]])];
    insertBlanks(lines, [{ x0: 90, x1: 200, y: 128 }]);
    expect(lines[0].text).toBe('Read carefully');
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
