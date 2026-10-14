// "Could not find Chrome (ver. 148…)" on every Word upload (2026-10-14 local
// test): Puppeteer's own Chrome download had not run. findBrowser falls back
// to an installed Chrome/Edge.
const { findBrowser } = require('../../utils/browser');

const only = (...paths) => p => paths.includes(p);

describe('findBrowser', () => {
  test('a configured path wins', () => {
    expect(findBrowser({ env: { PUPPETEER_EXECUTABLE_PATH: '/x/chrome' }, platform: 'linux', exists: only('/x/chrome', '/own/chrome'), bundled: '/own/chrome' })).toBe('/x/chrome');
  });

  test('Puppeteer\'s own Chrome when it was downloaded', () => {
    expect(findBrowser({ env: {}, platform: 'linux', exists: only('/own/chrome', '/usr/bin/chromium'), bundled: '/own/chrome' })).toBe('/own/chrome');
  });

  test('Windows without the download: the installed Edge is used', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(findBrowser({ env: {}, platform: 'win32', exists: only(edge), bundled: 'C:\\repo\\.cache\\puppeteer\\chrome.exe' })).toBe(edge);
  });

  test('a configured path that does not exist is skipped', () => {
    expect(findBrowser({ env: { CHROME_PATH: '/nope' }, platform: 'darwin', exists: only('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), bundled: null }))
      .toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  test('nothing installed → null (the caller explains how to fix it)', () => {
    expect(findBrowser({ env: {}, platform: 'linux', exists: () => false, bundled: null })).toBeNull();
  });
});
