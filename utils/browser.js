// Headless Chrome for docx → PDF and PDF page rendering. Puppeteer only finds
// the Chrome its postinstall downloaded into .cache/puppeteer; when that step
// didn't run (a fresh clone, `npm ci --ignore-scripts`, a Puppeteer upgrade)
// every Word upload failed with "Could not find Chrome (ver. …)". Falls back to
// a Chrome / Edge / Chromium already installed on the machine.
const fs = require('fs');
const path = require('path');

const SYSTEM_BROWSERS = {
  win32: [
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((v) => (process.env[v] ? [
      path.join(process.env[v], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env[v], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : [])),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/** The browser to launch: configured path → Puppeteer's own Chrome → an installed one. */
function findBrowser({ env = process.env, platform = process.platform, exists = fs.existsSync, bundled } = {}) {
  const configured = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH;
  if (configured && exists(configured)) return configured;
  let own = bundled;
  if (own === undefined) { try { own = require('puppeteer').executablePath(); } catch { own = null; } }
  if (own && exists(own)) return own;
  return (SYSTEM_BROWSERS[platform] || []).find(p => exists(p)) || null;
}

async function launchBrowser(extraArgs = []) {
  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error('No Chrome or Edge found to convert this document. In aivorah-assignments-service run '
      + '"npx puppeteer browsers install chrome", or set PUPPETEER_EXECUTABLE_PATH to an installed Chrome/Edge.');
  }
  return require('puppeteer').launch({
    executablePath, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
  });
}

module.exports = { findBrowser, launchBrowser, SYSTEM_BROWSERS };
