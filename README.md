# Aivorah Assignments Service

Standalone microservice for the **student-facing** Assignments flow — list,
quiz submission/grading, scaffolded task-step grading, worksheet-image
grading, quiz generation, and fill-blank validation — extracted from
`ai-mentor/server/routes/assignments.js`.

## Structure

```
routes/
  assignments.js   — the 6 student-facing endpoints (see below)
services/
  supabase.js       — Supabase client
  embeddings.js      — local embedding model (Xenova/all-MiniLM-L6-v2)
  qdrant.js          — Qdrant client + textbook-grounding search
utils/
  quizHtmlRenderer.js — renderQuizHTML + its 4 direct helpers, copied
                        verbatim from ai-mentor/server/routes/quiz.js
                        (confirmed zero further requires — doesn't drag
                        in quiz.js's teacher-side generation pipeline)
```

## Why only 6 of the original 19 endpoints

`assignments.js` (3490 lines) mixes teacher-authoring endpoints (AI-generate,
generate-steps, generate-ibpyp, docx-to-pdf, extract-questions(-async), detect-meta,
pdf-to-quiz, upload-doc, `POST /`, `GET /:id/submissions`,
`PUT /:id/teacher-feedback`, `DELETE /:id`) with student-completion
endpoints. The teacher-side ones depend on `routes/quiz.js`'s generation
pipeline — Cloudinary, Gemini, puppeteer/mammoth doc conversion, the
vision-based upload-grading wizard — a much heavier and differently-shaped
dependency set than anything a student needs. Those stayed in the monolith.

The one student-facing exception that reaches into `quiz.js`: `GET /`
calls `normalise()`, which live-regenerates each assignment's interactive
quiz HTML via `renderQuizHTML` on every read (so template fixes propagate to
already-created assignments instead of only new ones). `renderQuizHTML` and
its 4 direct helpers were verified to have **zero further `require()`
calls** of their own, so copying them into `utils/quizHtmlRenderer.js` does
not pull in any of `quiz.js`'s teacher-side dependencies.

`GET /` still supports the `?teacherId=` query branch too (same handler the
not-yet-extracted teacher list also uses) — kept verbatim rather than split,
so the two callers can't silently drift apart.

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3015`).

## Endpoints

- `GET /assignments?studentId=` (or `?teacherId=`) — a student's (or
  teacher's) assignment list, merged with their own submission status/score.
- `POST /assignments/generate-quiz` — Qdrant-grounded MCQ/fill-blank/mixed
  quiz generation, with a deterministic offline fallback bank.
- `POST /assignments/:id/submit` — grades a submission (quiz answers,
  scaffolded task-step answers, worksheet text answers, or worksheet
  images) via Groq, records the result.
- `PUT /assignments/:id/complete` — records completion for the
  interactive-quiz (iframe) flow.
- `POST /assignments/:id/explain-question` — step-by-step AI explanation
  for a question the student got wrong.
- `POST /assignments/validate-fill-blank` — fuzzy-tolerant fill-blank
  answer validation (exact/numeric/decimal-equivalence/Levenshtein).
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
