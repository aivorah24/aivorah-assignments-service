// B03: single source of truth for whether a score counts as "correct".
// An LLM's self-reported correctness boolean must never be trusted directly.
const CORRECT_SCORE_THRESHOLD = 70;

function resolveCorrectFromScore(score, threshold = CORRECT_SCORE_THRESHOLD) {
  return Number(score) >= threshold;
}

module.exports = { resolveCorrectFromScore, CORRECT_SCORE_THRESHOLD };
