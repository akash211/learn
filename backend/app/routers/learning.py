"""Content read APIs: bootstrap, technologies, chapters, questions, scenarios, quick revision,
graph and search."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from ..content import store
from ..db import engine
from ..models import Bookmark, ChapterProgress, QuestionState, TechProgress

router = APIRouter(prefix="/api", tags=["learning"])


@router.get("/bootstrap")
def bootstrap() -> dict[str, Any]:
    with engine.connect() as conn:
        chapters_done = conn.execute(text("SELECT COUNT(*) FROM chapter_progress WHERE completed = 1")).scalar_one()
        total_chapters = sum(len(t.chapters) for t in store.techs.values())
        started = conn.execute(text("SELECT COUNT(*) FROM tech_progress")).scalar_one()
        bookmarks = conn.execute(text("SELECT COUNT(*) FROM bookmarks")).scalar_one()
        due = conn.execute(
            text("SELECT COUNT(*) FROM revisions WHERE due_at <= datetime('now')")
        ).scalar_one()
        interviews = conn.execute(text("SELECT COUNT(*) FROM interview_sessions WHERE status = 'finished'")).scalar_one()
        last = conn.execute(
            text("SELECT tech_slug, last_chapter_id FROM tech_progress ORDER BY last_visited_at DESC LIMIT 1")
        ).first()

    return {
        "app": "Learn",
        "categories": store.categories,
        "techs": [
            {
                "slug": t.slug,
                "title": t.title,
                "summary": t.summary,
                "category": t.category,
                "level": t.level,
                "chapters": len(t.chapters),
                "questions": len(t.basic) + len(t.recent),
                "scenarios": len(t.scenarios),
            }
            for t in store.list_techs()
        ],
        "stats": {
            "total_chapters": total_chapters,
            "chapters_completed": chapters_done,
            "techs_started": started,
            "techs_total": len(store.techs),
            "bookmarks": bookmarks,
            "due_revisions": due,
            "interviews_completed": interviews,
            "continue": {"tech": last[0], "chapter": last[1]} if last and last[0] else None,
        },
        "content_errors": store.errors,
    }


@router.get("/techs")
def list_techs(category: str | None = None) -> list[dict[str, Any]]:
    items = store.list_techs()
    if category:
        items = [t for t in items if t.category == category]
    return [
        {
            "slug": t.slug,
            "title": t.title,
            "summary": t.summary,
            "category": t.category,
            "categoryTitle": store.categories.get(t.category, t.category),
            "level": t.level,
            "chapters": [{"id": c.id, "title": c.title, "minutes": c.minutes, "level": c.level} for c in t.chapters],
            "questionCount": len(t.basic) + len(t.recent),
            "scenarioCount": len(t.scenarios),
        }
        for t in items
    ]


@router.get("/tech/{slug}")
def get_tech(slug: str) -> dict[str, Any]:
    tech = store.techs.get(slug)
    if not tech:
        raise HTTPException(404, f"unknown technology: {slug}")
    with engine.connect() as conn:
        done = {
            row[0]
            for row in conn.execute(
                text("SELECT chapter_id FROM chapter_progress WHERE tech_slug = :s AND completed = 1"), {"s": slug}
            )
        }
        last = conn.execute(
            text("SELECT last_chapter_id FROM tech_progress WHERE tech_slug = :s"), {"s": slug}
        ).scalar_one_or_none()
    return {
        "slug": tech.slug,
        "title": tech.title,
        "summary": tech.summary,
        "category": tech.category,
        "categoryTitle": store.categories.get(tech.category, tech.category),
        "level": tech.level,
        "intro": tech.intro,
        "relations": [
            {"to": r["to"], "type": r.get("type", "related"), "note": r.get("note", ""), "title": store.techs[r["to"]].title}
            for r in tech.relations
        ],
        "chapters": [
            {
                "id": c.id,
                "title": c.title,
                "minutes": c.minutes,
                "level": c.level,
                "completed": c.id in done,
            }
            for c in tech.chapters
        ],
        "lastChapter": last,
        "counts": {
            "basic": len(tech.basic),
            "recent": len(tech.recent),
            "scenarios": len(tech.scenarios),
            "quickrev": len(tech.quickrev.concepts),
        },
    }


@router.get("/tech/{slug}/chapter/{chapter_id}")
def get_chapter(slug: str, chapter_id: str) -> dict[str, Any]:
    tech = store.techs.get(slug)
    if not tech:
        raise HTTPException(404, f"unknown technology: {slug}")
    chapter = tech.chapter(chapter_id)
    if not chapter:
        raise HTTPException(404, f"unknown chapter: {chapter_id}")
    order = [c.id for c in tech.chapters]
    idx = order.index(chapter_id)
    with engine.connect() as conn:
        completed = conn.execute(
            text("SELECT completed FROM chapter_progress WHERE tech_slug = :s AND chapter_id = :c"),
            {"s": slug, "c": chapter_id},
        ).scalar_one_or_none()
    return {
        "tech": {"slug": tech.slug, "title": tech.title},
        "chapter": {
            "id": chapter.id,
            "title": chapter.title,
            "minutes": chapter.minutes,
            "level": chapter.level,
            "body": chapter.body,
            "completed": bool(completed),
        },
        "prev": {"id": tech.chapters[idx - 1].id, "title": tech.chapters[idx - 1].title} if idx > 0 else None,
        "next": {"id": tech.chapters[idx + 1].id, "title": tech.chapters[idx + 1].title} if idx + 1 < len(tech.chapters) else None,
    }


@router.get("/tech/{slug}/questions")
def get_questions(slug: str, kind: str = Query("basic", pattern="^(basic|recent|all)$")) -> list[dict[str, Any]]:
    tech = store.techs.get(slug)
    if not tech:
        raise HTTPException(404, f"unknown technology: {slug}")
    items = []
    for source, qs in (("basic", tech.basic), ("recent", tech.recent)):
        if kind != "all" and kind != source:
            continue
        for q in qs:
            items.append(
                {
                    "id": q.id,
                    "kind": source,
                    "topic": q.topic,
                    "difficulty": q.difficulty,
                    "question": q.question,
                    "answer": q.answer,
                    "tags": q.tags,
                    "period": q.period,
                    "type": q.type,
                }
            )
    with engine.connect() as conn:
        state = {
            row[0]: {"seen": row[1], "correct": row[2], "wrong": row[3], "difficult": bool(row[4])}
            for row in conn.execute(
                text("SELECT question_id, seen, correct, wrong, marked_difficult FROM question_state WHERE tech_slug = :s"),
                {"s": slug},
            )
        }
    for item in items:
        item["state"] = state.get(item["id"])
    return items


@router.get("/tech/{slug}/scenarios")
def get_scenarios(slug: str) -> list[dict[str, Any]]:
    tech = store.techs.get(slug)
    if not tech:
        raise HTTPException(404, f"unknown technology: {slug}")
    return [
        {
            "id": s.id,
            "title": s.title,
            "difficulty": s.difficulty,
            "technologies": s.technologies,
            "prompt": s.prompt,
            "approach": s.approach,
            "red_flags": s.red_flags,
        }
        for s in tech.scenarios
    ]


@router.get("/tech/{slug}/quickrev")
def get_quickrev(slug: str) -> dict[str, Any]:
    tech = store.techs.get(slug)
    if not tech:
        raise HTTPException(404, f"unknown technology: {slug}")
    qr = tech.quickrev
    return {
        "tech": {"slug": tech.slug, "title": tech.title},
        "concepts": qr.concepts,
        "traps": qr.traps,
        "advanced": qr.advanced,
        "comparisons": qr.comparisons,
        "commands": qr.commands,
    }


@router.get("/graph")
def graph() -> dict[str, Any]:
    return store.graph()


@router.get("/search")
def search(q: str, kind: str | None = None, tech: str | None = None, limit: int = 25) -> list[dict[str, Any]]:
    q = q.strip()
    if not q:
        return []
    # FTS5 syntax is easy to break with user text: quote every token
    tokens = [f'"{t}"*' for t in q.replace('"', " ").split() if t]
    match = " AND ".join(tokens)
    sql = "SELECT kind, tech, ref, title, snippet(search_fts, 4, '<mark>', '</mark>', '…', 18) FROM search_fts WHERE search_fts MATCH :m"
    params: dict[str, Any] = {"m": match}
    if kind:
        sql += " AND kind = :kind"
        params["kind"] = kind
    if tech:
        sql += " AND tech = :tech"
        params["tech"] = tech
    sql += " ORDER BY rank LIMIT :lim"
    params["lim"] = limit
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).all()
    return [
        {
            "kind": r[0],
            "tech": r[1],
            "techTitle": store.techs[r[1]].title if r[1] in store.techs else r[1],
            "ref": r[2],
            "title": r[3],
            "snippet": r[4],
        }
        for r in rows
    ]
