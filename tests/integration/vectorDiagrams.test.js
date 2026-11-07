// Diagrams drawn as shapes (not embedded pictures) used to vanish from the
// generated assignment: the question text came through, the diagram did not.
// A worksheet built with pdf-lib (tests/helpers/vectorWorksheet.js) holds four
// drawn diagrams and the drawn things that are not diagrams; the real
// fixtures hold none, so they must stay free of invented figures.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { readPdfLayout } = require('../../services/worksheet/pdfLayout');
const { findVectorFigures } = require('../../services/worksheet/vectorFigures');
const { buildDocumentModel } = require('../../services/worksheet/documentModel');
const { attachRegionCrops, resolvePictureRefs } = require('../../services/worksheet/regionCrops');
const { buildVectorWorksheet } = require('../helpers/vectorWorksheet');

const fixture = name => fs.readFileSync(path.join(__dirname, '../fixtures', name));
const fakeHost = async imgs => imgs.map((img, i) => ({ url: `https://img.test/p${img.page}-${i + 1}.png` }));

let pdf;
beforeAll(async () => { pdf = await buildVectorWorksheet(); });

describe('finding drawn diagrams', () => {
  test('the four diagrams are found with their labels; frames, boxes, lines and the table are not', async () => {
    const layout = await readPdfLayout(pdf);
    const figures = findVectorFigures(layout.pages[0]);
    expect(figures.map(f => f.labels)).toEqual([
      '5 m ; 6 m ; 8 m ; 3 m',
      expect.stringMatching(/^B ; 60° ; A \| C$/),
      '0 | 1/4 | 2/4 | 3/4 | 1',
      '5 cm ; 8 cm',
    ]);
    const skipped = figures.skipped.map(s => s.reason);
    // Page border, instructions box and table hold words; answer line; empty answer box.
    expect(skipped.sort()).toEqual(['box', 'flat', 'text-container', 'text-container']);
    // Each figure is cut tight: inside the page, not reaching into the heading above it.
    const heading = layout.pages[0].lines.find(l => l.text.startsWith('Task 1'));
    expect(figures[0].bbox.y).toBeGreaterThanOrEqual(heading.y + heading.h);
  });

  test.each([
    'b02-ib-pyp-worksheet.pdf', 'b02-no-curriculum-worksheet.pdf', 'b05-area-perimeter-worksheet.pdf',
    'b06-fractions-measurement-worksheet.pdf', 'pdf-with-embedded-image.pdf', 'thin-text-worksheet.pdf',
  ])('%s: no invented figures (logos, frames, tables, answer lines)', async (name) => {
    const layout = await readPdfLayout(fixture(name));
    for (const page of layout.pages) expect(findVectorFigures(page)).toHaveLength(0);
  });
});

describe('drawn diagrams in the transcript and the assignment', () => {
  let doc;
  beforeAll(async () => {
    doc = await buildDocumentModel({ buffer: pdf, mime: 'application/pdf', hostImages: fakeHost });
  }, 180000);

  test('each diagram is a picture placed under its own task, with its labels', () => {
    const drawn = doc.pictures.filter(p => p.vector);
    expect(drawn).toHaveLength(4);
    expect(drawn.every(p => p.buffer.slice(1, 4).toString() === 'PNG' && p.url)).toBe(true);
    const lines = doc.text.split('\n');
    const after = (start) => lines[lines.findIndex(l => l.includes(start)) + 1] || '';
    expect(after('Task 1: Find the perimeter')).toMatch(/\[IMAGE: url=img:\/\/p1-\d+\] \(text in picture: 5 m ; 6 m ; 8 m ; 3 m\)/);
    expect(after('Task 2: Measure the angle')).toMatch(/\[IMAGE: url=img:\/\/p1-\d+\].*60°/);
    expect(after('Task 3: Mark 3/4')).toMatch(/\[IMAGE: url=img:\/\/p1-\d+\].*1\/4/);
    expect(doc.text).toMatch(/Task 4: Find the area[\s\S]*\[IMAGE: url=img:\/\/p1-\d+\] \(text in picture: 5 cm ; 8 cm\)/);
  });

  test('text that is not a diagram stays text (instructions, table)', () => {
    expect(doc.text).toContain('Read each question carefully');
    expect(doc.text).toMatch(/Shape.*Number of sides.*Number of corners/);
    expect(doc.text).toMatch(/Square.*Triangle.*Pentagon/);
    expect(doc.text.match(/\[IMAGE:/g)).toHaveLength(4);
  });

  test('a quiz where the model copied the labels but left the diagrams out still shows every diagram', async () => {
    const id = labels => doc.pictures.find(p => p.labels.startsWith(labels)).id;
    const quiz = { tasks: [
      // Labels copied into the question, picture kept: must not be dropped as "text only".
      { title: 'Task 1: Find the perimeter of the L-shaped figure.', questions: [
        { question: 'Find the perimeter of the L-shaped figure with sides 5 m, 6 m, 8 m and 3 m.', imageUrl: id('5 m'), hasImage: true },
      ] },
      // Picture left out entirely.
      { title: 'Task 2: Measure the angle at B.', questions: [{ question: 'What is the angle at B?' }] },
      { title: 'Task 3: Mark 3/4 on the number line.', questions: [{ question: 'Mark 3/4 on the number line.' }] },
      { title: 'Task 4: Find the area of the rectangle.', questions: [{ question: 'Area of a 8 cm by 5 cm rectangle?' }] },
    ] };
    await attachRegionCrops(quiz, doc, fakeHost);
    resolvePictureRefs(quiz, doc);
    const urls = quiz.tasks.map(t => t.questions[0].imageUrl);
    expect(urls.every(u => /^https:\/\/img\.test\//.test(u))).toBe(true);
    expect(new Set(urls).size).toBe(4); // each task its own diagram
    expect(quiz.tasks.some(t => t.regionCrop)).toBe(false); // the diagram itself, not a strip of the page
  });
});
