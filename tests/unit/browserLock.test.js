// Render OOM-killed the service (512 MB) when Chrome ran next to another Chrome
// or warm Tesseract workers (2026-10-26 bulk upload). launchBrowser now runs one
// Chrome at a time, frees OCR workers first, and uses low-memory flags.
const { EventEmitter } = require('events');

jest.mock('puppeteer', () => ({ launch: jest.fn(), executablePath: () => '/own/chrome' }));
jest.mock('../../services/worksheet/ocrEngine', () => ({ terminateWorkers: jest.fn(async () => {}) }));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), existsSync: () => true }));

const puppeteer = require('puppeteer');
const ocr = require('../../services/worksheet/ocrEngine');
const { launchBrowser, LOW_MEMORY_ARGS } = require('../../utils/browser');

function fakeBrowser() {
  const b = new EventEmitter();
  b.close = jest.fn(async () => b.emit('disconnected'));
  return b;
}

beforeEach(() => { puppeteer.launch.mockReset(); ocr.terminateWorkers.mockClear(); });

test('a second Chrome waits until the first one closes', async () => {
  puppeteer.launch.mockImplementation(async () => fakeBrowser());
  const first = await launchBrowser();
  let secondStarted = false;
  const second = launchBrowser().then(b => { secondStarted = true; return b; });
  await new Promise(r => setTimeout(r, 20));
  expect(secondStarted).toBe(false);
  expect(puppeteer.launch).toHaveBeenCalledTimes(1);

  await first.close();
  const b2 = await second;
  expect(secondStarted).toBe(true);
  expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  await b2.close();
});

test('OCR workers are freed before Chrome starts, with low-memory flags', async () => {
  puppeteer.launch.mockImplementation(async () => fakeBrowser());
  const b = await launchBrowser(['--disable-dev-shm-usage']);
  expect(ocr.terminateWorkers).toHaveBeenCalled();
  const { args } = puppeteer.launch.mock.calls[0][0];
  expect(args).toEqual(expect.arrayContaining(LOW_MEMORY_ARGS));
  expect(args.filter(a => a === '--disable-dev-shm-usage')).toHaveLength(1);
  await b.close();
});

test('a failed launch does not block the next one', async () => {
  puppeteer.launch.mockRejectedValueOnce(new Error('no chrome')).mockImplementation(async () => fakeBrowser());
  await expect(launchBrowser()).rejects.toThrow('no chrome');
  const b = await launchBrowser();
  expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  await b.close();
});
