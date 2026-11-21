# Learn

Personal technical learning and interview-preparation platform. Single user, homelab hosted,
Tailscale only. Content is plain files under `content/`, state is SQLite, AI is a swappable
OpenAI-compatible client.

## What works today

| Area | State |
|---|---|
| Dashboard, navigation, dark/light theme, ⌘K search | working |
| Eight technology modules (Python, SQL, Microsoft Fabric, PySpark, Airflow, PostgreSQL, Docker, System Design) — 10 chapters, 22 foundation + 10 recent questions, 6 scenarios and 16 quick-revision concepts each; 80 chapters / 256 questions in total | working |
| Chapter progress, bookmarks, notes, difficult-question flags | working |
| Full-text search over chapters, questions, scenarios and concepts (SQLite FTS5) | working |
| Quick revision sessions, single or combined technology | working |
| Spaced repetition (SM-2 style) queue with grading | working |
| Mock interviews: config → one question at a time → hints → evaluation → report → history | working |
| AI tutor with chapter context, streamed answers, "improve my answer" | working (needs a model endpoint) |
| Playgrounds: Python and Bash in isolated containers, SQL on DuckDB | working |
| Technology relationship map | working |
| Content authoring without code changes | working — add a folder under `content/tech/` |

## Run it

```bash
cd ~/projects/learn
cp .env.example .env          # then set AI_BASE_URL / AI_API_KEY / models
./.venv/bin/uvicorn backend.app.main:app --host 0.0.0.0 --port 8099
```

Production-style run (installed as a user-independent systemd unit):

```bash
sudo cp deploy/learn.service /etc/systemd/system/learn.service
sudo systemctl daemon-reload
sudo systemctl enable --now learn
systemctl status learn --no-pager
```

Frontend build (only needed after changing `frontend/`):

```bash
cd frontend && npm install && npm run build     # writes frontend/dist, served by FastAPI
```

Tests:

```bash
./.venv/bin/pytest backend/tests -q
```

## Configuration (`.env`)

| Key | Purpose |
|---|---|
| `AI_BASE_URL` | OpenAI-compatible endpoint, e.g. OpenRouter `https://openrouter.ai/api/v1`, or local Ollama `http://127.0.0.1:11434/v1` |
| `AI_API_KEY` | Bearer token (any non-empty string for Ollama) |
| `AI_MODEL_CHAT` | Tutor / discussion model |
| `AI_MODEL_INTERVIEW` | Question generation |
| `AI_MODEL_EVAL` | Answer evaluation and reports |
| `AI_MODEL_CONTENT` | Reserved for bulk content work |
| `HOST`, `PORT` | Bind address (default `0.0.0.0:8099`) |

Switching provider is an `.env` edit plus a service restart — no code change.

## Content authoring

`content/SCHEMA.md` is the contract. A technology is a folder:

```
content/tech/<slug>/
├─ tech.yaml          # metadata, intro, chapter index, relations
├─ chapters/NN-*.md   # crash course
├─ questions/basic.yaml
├─ questions/recent.yaml
├─ scenarios.yaml
└─ quickrev.yaml
```

After editing, either restart the service or `POST /api/content/reload` (Settings → Reload
content). The loader validates every folder, refuses broken ones, and reports the exact path.

## Architecture

See `docs/ARCHITECTURE.md`. Short version:

- **Backend** FastAPI + SQLAlchemy 2 + SQLite (WAL). `backend/app/`
- **Frontend** React 19 + Vite + Tailwind v4, built to `frontend/dist` and served by FastAPI.
- **AI** provider-agnostic `ai.py`; prompts get the current technology + chapter excerpt, not
  the whole library.
- **Sandbox** one container per execution: `--network none`, 256 MB, 0.5 CPU, read-only root,
  tmpfs `/tmp`, 10 s timeout. Nothing user-submitted runs in the app process.
- **Search** FTS5 index rebuilt from content at startup.

## Known limits

- Single user by design: no authentication. Keep it on Tailscale; do not expose it publicly
  without putting an auth layer in front.
- The mock-interview quality follows the configured model. A 3B local model asks narrower
  questions than a frontier model; swap `AI_MODEL_INTERVIEW` when a stronger provider is
  available.
- Content covers eight of the 52 technologies in the taxonomy; the rest are authored in batches. Referenced-but-unwritten slugs appear as an authoring backlog in Settings.
