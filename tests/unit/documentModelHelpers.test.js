// Pure helpers of the worksheet document model.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));
const { assessTextLayer, cleanLine, composeRows, classifyImage, isDecorative, coveredBy, makeCorpus } = require('../../services/worksheet/documentModel');
const { scriptsFromHints, langsForScripts, scriptsInText } = require('../../services/worksheet/ocrEngine');

const line = (text, y = 0) => ({ text, x: 0, y, w: 100, h: 10 });

describe('assessTextLayer', () => {
  test('ordinary Latin text is trusted', () => {
    expect(assessTextLayer([line('Task 1: Find the perimeter of the rectangle.')]).reliable).toBe(true);
  });
  test('an Indic text layer (Word export loses shaping) is not trusted', () => {
    const a = assessTextLayer([line('ఆ ) కింది వాక్యా లు చదవిండి. పదానిక సింబింధించిన వాక్యా లు రాయిండి.')]);
    expect(a.reliable).toBe(false);
    expect(a.scripts).toEqual(['Telugu']);
  });
  test('Private-Use-Area glyphs (broken font mapping) are not trusted', () => {
    expect(assessTextLayer([line(' abc def ghi jkl mno pqr stu ')]).reliable).toBe(false);
  });
});

describe('cleanLine', () => {
  test('dotted/underscored answer lines become one blank', () => {
    expect(cleanLine('Perimeter = .............. cm')).toBe('Perimeter = ____ cm');
    expect(cleanLine('ఉంది. ……………')).toBe('ఉంది. ____');
    expect(cleanLine('Name: ________')).toBe('Name: ____');
  });
});

describe('composeRows', () => {
  test('side-by-side items share a row; stacked items do not', () => {
    const rows = composeRows([
      { kind: 'image', x: 0, y: 100, w: 80, h: 60, text: '[IMAGE: url=a]' },
      { kind: 'text', x: 200, y: 120, w: 50, h: 12, text: 'కంఠం' },
      { kind: 'text', x: 0, y: 10, w: 300, h: 12, text: 'Match the words' },
      { kind: 'text', x: 0, y: 30, w: 300, h: 12, text: 'to the pictures' },
    ]);
    expect(rows).toEqual(['Match the words', 'to the pictures', '[IMAGE: url=a]   |   కంఠం']);
  });
});

describe('coveredBy', () => {
  test('ignores the missing spaces of a Word text layer', () => {
    const corpus = makeCorpus('Purpose:To practice using datahandlingto solve problems.');
    expect(coveredBy('Purpose: To practice using data handling to solve problems.', corpus)).toBe(true);
    expect(coveredBy('Sticky Frogs! The next morning', corpus)).toBe(false);
  });
});

describe('image classification', () => {
  const img = (bbox, areaRatio = 0.05) => ({ bbox, areaRatio });
  const ocrLine = (text, x, y, w, h, confidence = 90) => ({ text, x, y, w, h, confidence });

  test('a screenshot full of text lines is text, a labelled diagram stays a picture, a page-sized image is a scan', () => {
    const box = { x: 0, y: 0, w: 400, h: 100 };
    const textLines = [ocrLine('చెట్టు కింద పాము పుట్ట ఉంది', 10, 10, 380, 30), ocrLine('దుర్గ ముగ్గులు బాగా పెడుతుంది', 10, 50, 380, 30)];
    expect(classifyImage(img(box), textLines).kind).toBe('text');
    expect(classifyImage(img(box), [ocrLine('5m', 10, 10, 20, 10), ocrLine('8m', 100, 50, 20, 10)]).kind).toBe('picture');
    expect(classifyImage(img(box, 0.9), textLines).kind).toBe('scan');
  });

  test('logos in the header, thin rules and repeated images are decorative', () => {
    const page = { width: 600, height: 840 };
    expect(isDecorative({ bbox: { x: 240, y: 30, w: 100, h: 30 }, areaRatio: 0.006 }, page)).toBe(true);
    expect(isDecorative({ bbox: { x: 0, y: 400, w: 500, h: 4 }, areaRatio: 0.004 }, page)).toBe(true);
    expect(isDecorative({ bbox: { x: 50, y: 400, w: 200, h: 150 }, areaRatio: 0.06, repeat: true }, page)).toBe(true);
    expect(isDecorative({ bbox: { x: 50, y: 400, w: 200, h: 150 }, areaRatio: 0.06 }, page)).toBe(false);
  });
});

describe('OCR language selection', () => {
  test('hints and visible scripts choose the Tesseract languages, English always included', () => {
    expect(scriptsFromHints(['Language Acquisition-Telugu'])).toEqual(['Telugu']);
    expect(scriptsFromHints(['hi'])).toEqual(['Devanagari']);
    expect(scriptsInText('அம்மா and माँ')).toEqual(['Devanagari', 'Tamil']);
    expect(langsForScripts(['Telugu'])).toEqual(['tel', 'eng']);
    expect(langsForScripts([])).toEqual(['eng']);
  });
});
