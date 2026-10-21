const { withTextFallback, retryAfterMs } = require('../../services/groqResilient');

const rateLimited = (wait = '0.01s') => Object.assign(new Error(`Rate limit reached. Please try again in ${wait}`), { status: 429 });
const ok = (model) => ({ model, choices: [{ message: { content: '{}' } }] });
const client = (create) => withTextFallback({ chat: { completions: { create } } });

describe('groqResilient', () => {
  test('rotates to the next text model on a 429', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(rateLimited())
      .mockImplementation(async (o) => ok(o.model));
    const res = await client(create).chat.completions.create({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] });
    expect(create.mock.calls.map(c => c[0].model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(res.model).toBe('qwen/qwen3.8-27b');
  });

  test('waits and retries when every model is rate-limited', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited())
      .mockImplementation(async (o) => ok(o.model));
    const res = await client(create).chat.completions.create({ model: 'openai/gpt-oss-120b', messages: [] });
    expect(create).toHaveBeenCalledTimes(4);
    expect(res.model).toBe('openai/gpt-oss-120b');
  });

  test('retired models are routed to a live one; non-retryable errors surface', async () => {
    const create = jest.fn(async (o) => ok(o.model));
    await client(create).chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [] });
    expect(create.mock.calls[0][0].model).toBe('openai/gpt-oss-120b');
    const bad = jest.fn().mockRejectedValue(Object.assign(new Error('invalid request'), { status: 400 }));
    await expect(client(bad).chat.completions.create({ model: 'openai/gpt-oss-120b', messages: [] })).rejects.toThrow('invalid request');
    expect(bad).toHaveBeenCalledTimes(1);
  });

  test('image calls pass straight through', async () => {
    const create = jest.fn().mockRejectedValue(rateLimited());
    const msg = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }];
    await expect(client(create).chat.completions.create({ model: 'qwen/qwen3.8-27b', messages: msg })).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('parses Groq wait hints', () => {
    expect(retryAfterMs(new Error('try again in 8.5s'))).toBe(8750);
    expect(retryAfterMs(new Error('try again in 1m2s'))).toBe(62250);
    expect(retryAfterMs(new Error('try again in 640ms'))).toBe(890);
  });
});
