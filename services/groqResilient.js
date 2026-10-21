// Groq free tier allows ~8k tokens/min per model, so a class submitting at once
// hits 429s. Text calls rotate across the available text models and, when all
// are rate-limited, wait the time Groq asks for (capped) and try again.

const TEXT_MODELS = (process.env.GROQ_TEXT_MODELS || 'openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b')
  .split(',').map(s => s.trim()).filter(Boolean);
// Models Groq has removed — route them to the text chain instead of failing
const RETIRED = new Set(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-maverick-17b-128e-instruct']);
const MAX_WAIT_MS = Number(process.env.GROQ_MAX_WAIT_MS || 20000);
const MAX_ROUNDS = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isRateLimit = (e) => e?.status === 429 || /rate.?limit/i.test(e?.message || '');
const isRetryable = (e) => isRateLimit(e) || [500, 502, 503, 504].includes(e?.status) || /model_not_found|does not exist|decommissioned/i.test(e?.message || '');

// "Please try again in 8.5s" / "in 1m2.3s" / "in 640ms"
function retryAfterMs(e) {
  const m = String(e?.message || '').match(/try again in (?:(\d+)m)?([\d.]+)(ms|s)/i);
  if (!m) return 5000;
  const ms = (Number(m[1] || 0) * 60 + Number(m[2]) / (m[3] === 'ms' ? 1000 : 1)) * 1000;
  return Math.ceil(ms) + 250;
}

const hasImage = (messages = []) => messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));

function withTextFallback(client) {
  const create = client.chat.completions.create.bind(client.chat.completions);
  async function resilientCreate(opts = {}) {
    // Vision calls choose their own model chain elsewhere
    if (hasImage(opts.messages)) return create(opts);
    const first = RETIRED.has(opts.model) ? TEXT_MODELS[0] : opts.model;
    const chain = [first, ...TEXT_MODELS.filter(m => m !== first)];
    let lastErr;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let wait = Infinity;
      for (const model of chain) {
        try {
          return await create({ ...opts, model });
        } catch (e) {
          lastErr = e;
          if (!isRetryable(e)) throw e;
          if (isRateLimit(e)) wait = Math.min(wait, retryAfterMs(e));
        }
      }
      if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) break;
      await sleep(wait);
    }
    throw lastErr;
  }
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== 'chat') return target[prop];
      return { ...target.chat, completions: new Proxy(target.chat.completions, {
        get(c, p) { return p === 'create' ? resilientCreate : c[p]; },
      }) };
    },
  });
}

module.exports = { withTextFallback, retryAfterMs, TEXT_MODELS };
