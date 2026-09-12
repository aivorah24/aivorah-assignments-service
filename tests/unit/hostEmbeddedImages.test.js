// hostEmbeddedImages / htmlToStructuredText image markers — added
// 2026-09-12 (Phase 2 - image/diagram preservation). Root cause: mammoth
// embeds a docx's images as base64 data URIs by default (verified against
// mammoth's own source: options.convertImage || images.dataUri), but the
// pipeline discarded them entirely - htmlToStructuredText replaced every
// <img> with a bare "[IMAGE]" text marker, and the renderer already has
// full support for showing a real question.imageUrl (verified in
// quizHtmlRenderer.js) that nothing ever populated. This uploads each
// embedded image to Cloudinary (already used elsewhere in this service)
// and preserves the real URL as an explicit marker instead.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const mockUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload: (...args) => mockUpload(...args) } },
}));

const { hostEmbeddedImages } = require('../../routes/assignments');
const { htmlToStructuredText } = require('../../services/quizVision');

const TINY_PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

beforeEach(() => mockUpload.mockReset());

describe('hostEmbeddedImages', () => {
  test('replaces a data: URI image with its real hosted Cloudinary URL', async () => {
    mockUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/worksheet.png' });
    const html = `<p>Task 1</p><img src="${TINY_PNG_DATA_URI}"><p>a) question</p>`;

    const result = await hostEmbeddedImages(html);

    expect(result).toContain('https://res.cloudinary.com/demo/image/upload/v1/worksheet.png');
    expect(result).not.toContain('data:image/png;base64');
    expect(mockUpload).toHaveBeenCalledWith(TINY_PNG_DATA_URI, expect.objectContaining({ resource_type: 'image' }));
  });

  test('a failed upload leaves the original data: URI in place, not an error - non-fatal per image', async () => {
    mockUpload.mockRejectedValue(new Error('Cloudinary down'));
    const html = `<p>Task 1</p><img src="${TINY_PNG_DATA_URI}">`;

    const result = await hostEmbeddedImages(html);

    expect(result).toContain('data:image/png;base64');
  });

  test('the same image appearing twice is only uploaded once', async () => {
    mockUpload.mockResolvedValue({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/worksheet.png' });
    const html = `<img src="${TINY_PNG_DATA_URI}"><p>between</p><img src="${TINY_PNG_DATA_URI}">`;

    await hostEmbeddedImages(html);

    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  test('html with no images is returned unchanged and uploads nothing', async () => {
    const html = '<p>Task 1: no images here</p>';
    const result = await hostEmbeddedImages(html);
    expect(result).toBe(html);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('htmlToStructuredText image markers', () => {
  test('a real hosted URL becomes an [IMAGE: url=...] marker with the exact URL', () => {
    const html = '<p>Task 1</p><img src="https://res.cloudinary.com/demo/image/upload/v1/worksheet.png"><p>a) question</p>';
    const text = htmlToStructuredText(html);
    expect(text).toContain('[IMAGE: url=https://res.cloudinary.com/demo/image/upload/v1/worksheet.png]');
  });

  test('an un-hosted data: URI image falls back to a bare [IMAGE] marker (presence noted, no fabricated URL)', () => {
    const html = `<p>Task 1</p><img src="${TINY_PNG_DATA_URI}">`;
    const text = htmlToStructuredText(html);
    expect(text).toContain('[IMAGE]');
    expect(text).not.toContain('data:image');
    expect(text).not.toMatch(/\[IMAGE: url=/);
  });
});
