// A maths worksheet whose diagrams are DRAWN (vector shapes, as Word and most
// worksheet makers produce them) rather than embedded pictures, plus the
// drawn things that are not diagrams. Built with pdf-lib so the test needs no
// binary fixture. Coordinates below are in top-left points (y down), converted
// to PDF's bottom-left space when drawing.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const W = 595;
const H = 842;

async function buildVectorWorksheet() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([W, H]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const text = (t, x, y, size = 11, f = font) => page.drawText(t, { x, y: H - y - size, size, font: f, color: black });
  const line = (x1, y1, x2, y2, thickness = 1.2) => page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness, color: black });
  const rect = (x, y, w, h, opts = {}) => page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: black, borderWidth: 1, ...opts });
  const poly = (pts) => page.drawSvgPath(`M ${pts.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`, { x: 0, y: H, borderColor: black, borderWidth: 1.2 });

  // ── Not diagrams ──
  rect(20, 20, W - 40, H - 40);                                       // page border
  text('Measurement and Geometry', 200, 40, 16, bold);
  rect(40, 70, 515, 40);                                              // instructions box
  text('Read each question carefully and show your working in the space given.', 50, 84);

  // ── Task 1: L-shape (one path, straight lines) with side labels ──
  text('Task 1: Find the perimeter of the L-shaped figure.', 40, 130, 12, bold);
  poly([[80, 160], [140, 160], [140, 230], [240, 230], [240, 270], [80, 270]]);
  text('5 m', 100, 148, 10);
  text('6 m', 146, 190, 10);
  text('8 m', 182, 218, 10);
  text('3 m', 246, 246, 10);
  text('Answer: ', 300, 250);
  line(345, 262, 520, 262, 0.6);                                       // answer line

  // ── Task 2: triangle (diagonal lines) with vertex labels and an angle ──
  text('Task 2: Measure the angle at B.', 40, 300, 12, bold);
  poly([[100, 420], [200, 330], [300, 420]]);
  text('A', 88, 424, 11);
  text('B', 196, 316, 11);
  text('C', 304, 424, 11);
  text('60°', 190, 344, 9);

  // ── Task 3: number line (a long flat line with ticks and numbers) ──
  text('Task 3: Mark 3/4 on the number line.', 40, 450, 12, bold);
  line(70, 500, 470, 500);
  for (let i = 0; i <= 4; i++) {
    line(70 + i * 100, 494, 70 + i * 100, 506);
    text(i === 0 ? '0' : i === 4 ? '1' : `${i}/4`, 66 + i * 100, 512, 10);
  }

  // ── Task 4: labelled rectangle (rectangles only) ──
  text('Task 4: Find the area of the rectangle.', 40, 545, 12, bold);
  rect(80, 580, 160, 80);
  text('8 cm', 145, 666, 10);
  text('5 cm', 246, 615, 10);

  // ── More things that are not diagrams ──
  text('Write your answer in the box:', 300, 590);
  rect(300, 610, 120, 40);                                             // empty answer box
  text('Task 5: Complete the table.', 40, 690, 12, bold);
  const cols = [40, 200, 360, 555];
  const rows = [710, 735, 760];
  for (const y of rows) line(cols[0], y, cols[3], y, 0.6);             // table grid
  for (const x of cols) line(x, rows[0], x, rows[2], 0.6);
  text('Shape', 50, 716); text('Number of sides', 210, 716); text('Number of corners', 370, 716);
  text('Square', 50, 741); text('Triangle', 210, 741); text('Pentagon', 370, 741);

  return Buffer.from(await pdf.save());
}

module.exports = { buildVectorWorksheet, PAGE: { W, H } };
