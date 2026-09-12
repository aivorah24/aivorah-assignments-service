// classifyProviderError / PROVIDER_STATUS — added 2026-09-12 (Phase 1/2).
// The Qwen quota-depletion outage silently affected ordinary English
// worksheets before being noticed - in the logs it looked like just
// another generic engine failure. This makes the CLASS of failure
// explicit and diagnosable, tested against the exact real error strings
// observed live from Gemini, Qwen, and Mistral in this session.
jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const { classifyProviderError, PROVIDER_STATUS } = require('../../services/quizVision');

describe('classifyProviderError', () => {
  test('classifies a real, live-observed Qwen quota-depletion message', () => {
    const err = new Error('You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers.');
    expect(classifyProviderError('qwen', err)).toBe(PROVIDER_STATUS.QUOTA_EXHAUSTED);
  });

  test('classifies a real, live-observed Gemini prepayment-depleted message', () => {
    const err = new Error('429 Too Many Requests: Your prepayment credits are depleted.');
    expect(classifyProviderError('gemini', err)).toBe(PROVIDER_STATUS.QUOTA_EXHAUSTED);
  });

  test('classifies a real, live-observed Mistral rate-limit message', () => {
    const err = new Error('Rate limit exceeded');
    expect(classifyProviderError('mistral', err)).toBe(PROVIDER_STATUS.RATE_LIMITED);
  });

  test('classifies a missing-API-key configuration state as DISABLED', () => {
    expect(classifyProviderError('gemini', new Error('GEMINI_API_KEY not configured'))).toBe(PROVIDER_STATUS.DISABLED);
    expect(classifyProviderError('qwen', new Error('HF_TOKEN not configured'))).toBe(PROVIDER_STATUS.DISABLED);
  });

  test('classifies a 401/403-shaped message as AUTH_FAILURE', () => {
    expect(classifyProviderError('x', new Error('401 Unauthorized'))).toBe(PROVIDER_STATUS.AUTH_FAILURE);
    expect(classifyProviderError('x', new Error('403 Forbidden: invalid API key'))).toBe(PROVIDER_STATUS.AUTH_FAILURE);
  });

  test('classifies a 503/overloaded/timeout-shaped message as TEMPORARY_FAILURE', () => {
    expect(classifyProviderError('x', new Error('503 Service Unavailable'))).toBe(PROVIDER_STATUS.TEMPORARY_FAILURE);
    expect(classifyProviderError('x', new Error('ETIMEDOUT'))).toBe(PROVIDER_STATUS.TEMPORARY_FAILURE);
  });

  test('an unrecognized error shape defaults to TEMPORARY_FAILURE, not a throw', () => {
    expect(classifyProviderError('x', new Error('something totally unexpected happened'))).toBe(PROVIDER_STATUS.TEMPORARY_FAILURE);
  });

  test('handles a plain string error, not just an Error object', () => {
    expect(classifyProviderError('x', 'quota exhausted')).toBe(PROVIDER_STATUS.QUOTA_EXHAUSTED);
  });
});
