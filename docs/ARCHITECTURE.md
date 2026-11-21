# Learn — architecture

Personal technical learning and interview-preparation platform. Single-user, homelab-hosted,
no public exposure. Prototype milestone: three complete technology modules (Python, SQL,
Microsoft Fabric) plus dashboard, search, bookmarks, progress, AI discussion and mock
interviews.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Backend | FastAPI (Python 3.14) + SQLAlchemy 2 | Same language as the content tooling; async SSE for streaming AI; tiny footprint |
| Database | SQLite (WAL) at `data/learn.db` | Single user, zero ops, durable. Postgres is a drop-in later via SQLAlchemy URL |
| Content | Files under `content/tech/<slug>/` — YAML metadata + Markdown chapters | Version-controlled, diffable, no code change to add a technology; see `content/SCHEMA.md` |
| Search | SQLite FTS5 index built from content on startup | Fast, no extra service, matches chapters/questions/notes |
| Frontend | React 19 + Vite + TypeScript + Tailwind v4 | Reactive UI without a heavy framework; built to static files and served by FastAPI |
| Graphs | `react-force-graph-2d` | Renders the technology map from `relations` in the content files |
| AI | Provider-agnostic OpenAI-compatible client (`httpx`), keys from env | Swap provider/model/base URL without touching code |
| Python/Bash playground | One-shot `docker run` per execution: `--network none`, memory/CPU caps, read-only root, 10s timeout | Real isolation, no arbitrary code in the app process |
| SQL playground | DuckDB in-process against a sample database | Zero infra, real SQL engine, fast |

## Layout

```
learn/
├─ backend/app/
│  ├─ main.py            FastAPI app, static frontend mount, routers
│  ├─ config.py          Settings from env (.env / .env.example)
│  ├─ db.py              Engine, session, schema bootstrap
│  ├─ models.py          SQLAlchemy tables (progress, notes, bookmarks, sessions…)
│  ├─ content.py         Loader + validator + FTS indexer (content/ → SQLite)
│  ├─ ai.py              Provider-agnostic LLM client + prompt builders
│  ├─ interview.py       Mock interview state machine, evaluation, report
│  ├─ sandbox.py         Docker-isolated code execution
│  └─ routers/           content, progress, notes, ai, interview, playground, search
├─ frontend/             Vite + React app
├─ content/              learning material (source of truth)
│  ├─ categories.yaml
│  ├─ SCHEMA.md
│  └─ tech/<slug>/       tech.yaml, chapters/*.md, questions/*.yaml, scenarios.yaml, quickrev.yaml
├─ data/                 learn.db (gitignored)
└─ docs/                 architecture, runbook
```

## Data model (SQLite)

- `tech_progress` — per technology: chapters completed (json), last visited chapter, timestamps
- `chapter_progress` — (tech, chapter) completed flag, updated_at
- `bookmarks` — polymorphic: kind (chapter|question|scenario|concept), tech, ref, note
- `questions_state` — question id, times seen, correct/partial/wrong counts, difficulty flag
- `notes` — free notes, optionally anchored to a tech/chapter/question, can hold AI output
- `revisions` — SM-2 style: item kind+id, ease, interval_days, due_at, repetitions, lapses
- `chat_sessions`, `chat_messages` — AI discussions, scoped to tech/chapter
- `interview_sessions`, `interview_turns`, `interview_reports` — mock interviews
- `settings` — theme, model overrides, provider config (non-secret)

## AI integration

All model calls go through `ai.py`:

- `AI_BASE_URL` (default OpenRouter), `AI_API_KEY`, default and task-specific model names
  (`AI_MODEL_CHAT`, `AI_MODEL_INTERVIEW`, `AI_MODEL_EVAL`, `AI_MODEL_CONTENT`).
- Streaming via SSE (`/api/ai/chat/stream`) so the UI shows tokens as they arrive.
- Prompt builders receive the current technology, chapter title, and a trimmed excerpt of the
  chapter so the assistant has context without re-sending the entire library.
- Secrets never reach the browser; the frontend only ever talks to our own API.

## Security notes

- Playground code runs only inside a throwaway container with no network, no host mounts and
  hard resource limits. Execution output is truncated.
- No credentials in the repo; `.env` is gitignored, `.env.example` documents the keys.
- The app binds `0.0.0.0:8099` for Tailscale access; reverse proxy/Cloudflare work is left to
  the owner as requested.

## Phases

1. Architecture + foundation (this document, schema, scaffold, DB, nav shell) — done first.
2. Learning experience: technology pages, crash courses, Q&A, scenarios, search, bookmarks,
   chapter progress.
3. AI learning assistant with chapter context, "Improve my answer".
4. Mock interviews: config, conversation, hints, evaluation, report, history.
5. Quick revision + spaced repetition queue.
6. Playgrounds (Python, DuckDB SQL, Bash) and the technology map.
7. Content expansion beyond the first eight technologies.
8. Polish, tests, runbook, deployment.
