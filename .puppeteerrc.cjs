const { join } = require('path');

// Keep Chrome inside the project: Render only ships the project dir to runtime,
// so the default ~/.cache/puppeteer download from the build step is missing there.
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
