# Quiz/Worksheet AI Extraction Pipeline — Migration Checklist

Goal: 100% migration of the assignment/quiz-generation pipeline off the
monolith (`ai-mentor/server/routes/quiz.js` + `services/diagram-extractor.js`)
into `aivorah-assignments-service`, with full feature parity — no
functionality removed or simplified without explicit agreement.

Rule for this file: update it after every increment. An item only moves to
"Ported" once it has a real regression test that exercises actual business
behavior (not just "returns 200") AND has been run against a real worksheet
image/PDF.

## Already ported (before this migration effort)
- `POST /assignments/extract-questions`, `/extract-questions-async`
- `POST /assignments/generate-quiz`, `/generate-ibpyp`, `/ai-generate`
- `GET /curriculum/subjects`

## Ported this migration effort
- `POST /assignments/generate-steps`
- `POST /assignments/pdf-to-quiz`, `/upload-doc`
- `POST /assignments/docx-to-pdf` (added Puppeteer)
- `POST /quiz/render-preview`, `/quiz/normalize` (+ autoDetectMCQ and 5 pure
  structural normalizers)

## PENDING — full AI extraction pipeline (this is the current work)

Ordered by dependency (each increment builds on the previous).

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Core Gemini vision call (single image → quiz JSON): prompt builder, retry/timeout wrapper, JSON parsing | **Ported, mocked tests passing (5/5), live verification pending** | No OCR, no diagram matching, no answer-verification, no fallback chain yet — foundational only. `POST /quiz/generate-image` in `routes/quiz.js`, core logic in `services/quizVision.js` |
| 2 | Tesseract OCR extraction (`tesseract.js`, pure WASM) | Pending | Needed for #3 and as a text-fallback source |
| 3 | OCR cross-validation (`validateQuizAgainstOCR` + auto-retry-with-hint on failure) | Pending | Accuracy safeguard — catches Gemini dropping/hallucinating sections |
| 4 | Diagram/figure extraction (OpenCV via `@techstark/opencv-js`, pure WASM — the Python `LAYOUT_SERVICE_URL` path is confirmed dead in production, not being ported) | Pending | ~1,296 lines in `diagram-extractor.js` |
| 5 | Diagram-to-question matching + sub-figure extraction from table crops | Pending | Depends on #4 |
| 6 | Semantic crop-caption verification (vision LLM captions each crop, checked against the assigned question) | Pending | Separate vision pass |
| 7 | Independent AI answer-verification pass (`verifyQuizAnswers`) | Pending | Runs concurrently with #5/#6 in the monolith |
| 8 | PDF handling: `POST /quiz/generate` (sync) + `POST /quiz/generate-async` (queued, `quiz_generate` job) — raw PDF sent to Gemini natively, no high-DPI page rasterization yet | **Ported, mocked tests passing (8/8), live verification pending** | Powers the docx→PDF worksheet flow and Bulk Upload. High-DPI per-page rasterization (the monolith's accuracy enhancement on top of this) is a separate follow-up |
| 9 | Multi-vendor vision fallback chain: Qwen (HuggingFace), Pixtral (Mistral), Groq text-only | **Partial — Qwen ported for image path only, mocked tests passing (2/2)** | `generateQuizFromImage` now falls back to `callQwenVision` (HF router, `Qwen/Qwen2.5-VL-72B-Instruct`) on any Gemini failure. PDF path (`generateQuizFromPdf`) has no fallback yet — Qwen needs an image, not a raw PDF; would need PDF→image rasterization first. Pixtral (`mistral-small-latest`) attempted but currently 429 rate-limited on the available key; Groq text-only not attempted. |
| 10 | `recoverBarCharts` (Gemini-vision bar-chart recovery, used by render-preview/normalize) | Pending | Flagged separately when render-preview/normalize were ported |
| 11 | Quiz library: `GET /quiz/list`, `/quiz/:id`, `/quiz/:id/html` | Not yet scoped | Not part of the original bug report; size unknown |
| 12 | `/ncert/quiz`, `/ncert/science-quiz` fallback quiz bank | Not yet scoped | Shared with student/parent challenge flows — needs its own impact check |

## Verification log
(Each entry: date, what was tested, against what real file, result.)

- **2026-09-11 — Increment 1, mocked contract tests**: 5/5 passing (validation, real-shaped response, prompt content, daily-quota fast-fail, malformed-JSON handling). See `tests/integration/quizGenerateImage.test.js`.
- **2026-09-11 — Increment 1, real Gemini API call, local, against a real worksheet image** (`aivorah-e2e-tests/tests/fixtures/worksheets/area-perimeter-1.png`), using the monolith's own `GEMINI_API_KEY`: **failed** — `429 Too Many Requests: Your prepayment credits are depleted`. This is a billing/quota issue on that specific API key, not a bug in the ported code. **Important finding: if the live monolith uses this same key for its own `/quiz/generate-image`/`/quiz/generate-async`, this fully explains the original "Generate Interactive Quiz not generating" bug report as a billing issue, independent of migration.** Also surfaced a pre-existing (not introduced here — ported verbatim) gap in `geminiRetry`'s fast-fail logic: it only skips retries for messages containing "daily"/"per day"; a "prepayment credits depleted" message doesn't match, so it retries for real elapsed time (~88s observed) against a permanently-exhausted key before failing. Not fixed as part of this port (would be a behavior change beyond parity) — flagged for a decision.
- Live verification against the deployed `aivorah-assignments-service` (its own, separate Gemini key) — pending, next step.
- **2026-09-11 — Fixed `geminiRetry`'s fast-fail gap flagged above** (this service's own code, safe to fix unlike the monolith): now also fails fast on "prepayment credits depleted" / "billing" / "insufficient funds" 429s, not just "daily quota" ones. Verified live against the monolith: the exact same depleted key causes a Cloudflare 524 timeout on `/quiz/generate-image` there (confirms the retry-hang theory end to end) — this service will now return a real error in ~1s instead of hanging.
- **2026-09-11 — Increment 8 (PDF path), mocked contract tests**: 8/8 passing (validation, real-shaped response, real PDF inline-data assertion, billing-429 fast-fail, malformed-JSON handling, async enqueue, job-handler decode/call-through). See `tests/integration/quizGeneratePdf.test.js`. This is the path Bulk Upload and the docx→PDF worksheet flow actually use — both were confirmed failing in production due to the monolith's depleted key (Cloudflare 524 timeouts).
- **Still blocking Gemini specifically**: no funded Gemini API key exists in this environment. Confirmed no other deployed service has one either. This is a billing action, not a code task.
- **2026-09-12 — Qwen vision fallback for the image path, mocked contract tests**: 2/2 passing (Gemini failure → Qwen success with real quiz returned; Gemini + Qwen both failing → clean 500, not a hang). See `tests/integration/quizGenerateImage.test.js` ("Qwen fallback when Gemini fails"). Full suite re-run: 184/184 passing, no regressions. Requires `HF_TOKEN` set on Render for the deployed service (added 2026-09-12). Live verification against a real worksheet image — pending, next step.
