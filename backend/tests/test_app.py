"""Smoke tests for the Learn backend. AI endpoints are exercised only for their
configuration guards — no model calls in the test suite."""
from __future__ import annotations

import os
import tempfile

import pytest

os.environ.setdefault("AI_API_KEY", "")

from fastapi.testclient import TestClient  # noqa: E402

from backend.app.content import store  # noqa: E402
from backend.app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _content_loaded():
    """Load content and build the search index once for the whole session."""
    from backend.app.content import rebuild_search_index
    from backend.app.db import engine, init_db

    init_db()
    store.load()
    with engine.connect() as conn:
        rebuild_search_index(conn)
    yield


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_content_library_loaded():
    assert len(store.techs) >= 3
    for slug in ("python", "sql", "microsoft-fabric"):
        tech = store.techs[slug]
        assert len(tech.chapters) >= 8, slug
        assert len(tech.basic) >= 15, slug
        assert len(tech.recent) >= 5, slug
        assert tech.quickrev.concepts, slug
        assert store.errors == []


def test_chapter_bodies_present():
    for tech in store.techs.values():
        for chapter in tech.chapters:
            assert chapter.body.strip(), f"{tech.slug}/{chapter.id} has no body"


def test_health_and_bootstrap(client):
    health = client.get("/api/health").json()
    assert health["ok"] is True
    boot = client.get("/api/bootstrap").json()
    assert boot["stats"]["total_chapters"] > 0
    assert len(boot["techs"]) >= 3


def test_tech_and_chapter_endpoints(client):
    detail = client.get("/api/tech/python").json()
    assert detail["chapters"]
    chapter_id = detail["chapters"][0]["id"]
    chapter = client.get(f"/api/tech/python/chapter/{chapter_id}").json()
    assert chapter["chapter"]["body"]
    assert client.get("/api/tech/does-not-exist").status_code == 404


def test_questions_have_answers(client):
    questions = client.get("/api/tech/sql/questions?kind=all").json()
    assert len(questions) >= 20
    assert all(q["answer"].strip() for q in questions)


def test_search_finds_content(client):
    hits = client.get("/api/search?q=generator").json()
    assert hits
    assert {h["kind"] for h in hits} & {"chapter", "question"}


def test_progress_roundtrip(client):
    detail = client.get("/api/tech/python").json()
    chapter_id = detail["chapters"][0]["id"]
    res = client.post("/api/progress/chapter", json={"tech": "python", "chapter": chapter_id, "completed": True})
    assert res.status_code == 200
    assert res.json()["completed"] is True

    visit = client.post("/api/progress/visit", json={"tech": "python", "chapter": chapter_id})
    assert visit.status_code == 200

    boot = client.get("/api/bootstrap").json()
    assert boot["stats"]["chapters_completed"] >= 1
    assert boot["stats"]["continue"]["tech"] == "python"


def test_bookmark_roundtrip(client):
    created = client.post(
        "/api/bookmarks",
        json={"kind": "chapter", "tech": "python", "ref": "data-structures", "label": "Data structures"},
    ).json()
    listed = client.get("/api/bookmarks").json()
    assert any(b["id"] == created["id"] for b in listed)
    client.delete(f"/api/bookmarks/{created['id']}")


def test_revision_grading_expands_interval(client):
    first = client.post(
        "/api/revisions/grade-item",
        json={"kind": "concept", "item_id": "python-GIL", "tech": "python", "label": "GIL", "result": "correct"},
    ).json()
    second = client.post(
        "/api/revisions/grade-item",
        json={"kind": "concept", "item_id": "python-GIL", "tech": "python", "label": "GIL", "result": "correct"},
    ).json()
    assert second["intervalDays"] >= first["intervalDays"]
    due = client.get("/api/revisions").json()
    assert "counts" in due


def test_sql_playground_runs_query(client):
    res = client.post("/api/playground/sql", json={"sql": "SELECT count(*) AS n FROM orders"}).json()
    assert res["ok"] is True
    assert res["columns"] == ["n"]
    assert res["rows"][0][0] >= 1


def test_sql_playground_reports_errors(client):
    res = client.post("/api/playground/sql", json={"sql": "SELECT * FROM nope"}).json()
    assert res["ok"] is False
    assert "nope" in res["error"]


def test_ai_endpoints_require_configuration(client, monkeypatch):
    from backend.app import ai

    monkeypatch.setattr(ai, "configured", lambda: False)
    res = client.post("/api/ai/chat/stream", json={"message": "hi"})
    assert res.status_code == 503
