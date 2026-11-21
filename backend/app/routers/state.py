"""Personal state: progress, bookmarks, notes, question results, revision queue."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import revision as rev
from ..content import store
from ..db import get_db
from ..models import Bookmark, ChapterProgress, Note, QuestionState, TechProgress

router = APIRouter(prefix="/api", tags=["state"])


# ------------------------------------------------------------------ progress
class ChapterProgressIn(BaseModel):
    tech: str
    chapter: str
    completed: bool = True


@router.post("/progress/chapter")
def set_chapter_progress(body: ChapterProgressIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    if body.tech not in store.techs:
        raise HTTPException(404, "unknown technology")
    row = db.scalar(
        select(ChapterProgress).where(
            ChapterProgress.tech_slug == body.tech, ChapterProgress.chapter_id == body.chapter
        )
    )
    if row is None:
        row = ChapterProgress(tech_slug=body.tech, chapter_id=body.chapter)
        db.add(row)
    row.completed = body.completed
    tech_row = db.get(TechProgress, body.tech)
    if tech_row is None:
        tech_row = TechProgress(tech_slug=body.tech)
        db.add(tech_row)
    tech_row.last_chapter_id = body.chapter
    tech_row.last_visited_at = datetime.now(timezone.utc)
    db.commit()
    return {"tech": body.tech, "chapter": body.chapter, "completed": body.completed}


class VisitIn(BaseModel):
    tech: str
    chapter: str | None = None


@router.post("/progress/visit")
def visit(body: VisitIn, db: Session = Depends(get_db)) -> dict[str, str]:
    if body.tech not in store.techs:
        raise HTTPException(404, "unknown technology")
    row = db.get(TechProgress, body.tech)
    if row is None:
        row = TechProgress(tech_slug=body.tech)
        db.add(row)
    row.last_visited_at = datetime.now(timezone.utc)
    if body.chapter:
        row.last_chapter_id = body.chapter
    db.commit()
    return {"status": "ok"}


@router.get("/progress")
def progress(db: Session = Depends(get_db)) -> dict[str, Any]:
    by_tech: dict[str, list[str]] = {}
    for row in db.scalars(select(ChapterProgress).where(ChapterProgress.completed.is_(True))):
        by_tech.setdefault(row.tech_slug, []).append(row.chapter_id)
    out = []
    for slug, tech in store.techs.items():
        done = [c for c in by_tech.get(slug, []) if any(ch.id == c for ch in tech.chapters)]
        total = len(tech.chapters) or 1
        out.append(
            {
                "slug": slug,
                "title": tech.title,
                "completed": len(done),
                "total": len(tech.chapters),
                "percent": round(100 * len(done) / total),
                "chapters": done,
            }
        )
    return {"techs": out}


# ------------------------------------------------------------------ bookmarks
class BookmarkIn(BaseModel):
    kind: str
    tech: str
    ref: str
    label: str = ""
    note: str | None = None


@router.get("/bookmarks")
def list_bookmarks(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(Bookmark).order_by(Bookmark.created_at.desc()))
    return [
        {
            "id": b.id,
            "kind": b.kind,
            "tech": b.tech_slug,
            "techTitle": store.techs[b.tech_slug].title if b.tech_slug in store.techs else b.tech_slug,
            "ref": b.ref,
            "label": b.label,
            "note": b.note,
            "createdAt": b.created_at.isoformat(),
        }
        for b in rows
    ]


@router.post("/bookmarks")
def add_bookmark(body: BookmarkIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    existing = db.scalar(
        select(Bookmark).where(
            Bookmark.kind == body.kind, Bookmark.tech_slug == body.tech, Bookmark.ref == body.ref
        )
    )
    if existing:
        return {"id": existing.id, "already": True}
    row = Bookmark(kind=body.kind, tech_slug=body.tech, ref=body.ref, label=body.label, note=body.note)
    db.add(row)
    db.commit()
    return {"id": row.id, "already": False}


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    row = db.get(Bookmark, bookmark_id)
    if row:
        db.delete(row)
        db.commit()
    return {"deleted": True}


# ------------------------------------------------------------------ notes
class NoteIn(BaseModel):
    title: str = ""
    body: str = ""
    tech: str | None = None
    chapter: str | None = None
    ref: str | None = None
    source: str = "manual"


@router.get("/notes")
def list_notes(tech: str | None = None, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    stmt = select(Note)
    if tech:
        stmt = stmt.where(Note.tech_slug == tech)
    rows = db.scalars(stmt.order_by(Note.updated_at.desc()))
    return [
        {
            "id": n.id,
            "title": n.title,
            "body": n.body,
            "tech": n.tech_slug,
            "chapter": n.chapter_id,
            "ref": n.ref,
            "source": n.source,
            "updatedAt": n.updated_at.isoformat(),
        }
        for n in rows
    ]


@router.post("/notes")
def create_note(body: NoteIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    row = Note(
        title=body.title or "Untitled note",
        body=body.body,
        tech_slug=body.tech,
        chapter_id=body.chapter,
        ref=body.ref,
        source=body.source,
    )
    db.add(row)
    db.commit()
    return {"id": row.id}


class NotePatch(BaseModel):
    title: str | None = None
    body: str | None = None


@router.patch("/notes/{note_id}")
def update_note(note_id: int, body: NotePatch, db: Session = Depends(get_db)) -> dict[str, bool]:
    row = db.get(Note, note_id)
    if not row:
        raise HTTPException(404, "note not found")
    if body.title is not None:
        row.title = body.title
    if body.body is not None:
        row.body = body.body
    db.commit()
    return {"ok": True}


@router.delete("/notes/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    row = db.get(Note, note_id)
    if row:
        db.delete(row)
        db.commit()
    return {"deleted": True}


# ------------------------------------------------------------------ question state
class QuestionResultIn(BaseModel):
    question_id: str
    tech: str
    result: str = Field(pattern="^(correct|partial|wrong)$")
    difficult: bool | None = None


@router.post("/questions/result")
def question_result(body: QuestionResultIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    row = db.get(QuestionState, body.question_id)
    if row is None:
        row = QuestionState(question_id=body.question_id, tech_slug=body.tech)
        db.add(row)
    row.seen += 1
    if body.result == "correct":
        row.correct += 1
    elif body.result == "partial":
        row.partial += 1
    else:
        row.wrong += 1
    if body.difficult is not None:
        row.marked_difficult = body.difficult
    row.last_seen_at = datetime.now(timezone.utc)

    # keep the spaced-repetition queue in step with self-assessment
    if store.techs.get(body.tech):
        tech = store.techs[body.tech]
        question = next((q for q in tech.basic + tech.recent if q.id == body.question_id), None)
        label = question.question[:180] if question else body.question_id
        entry = rev.upsert(db, kind="question", item_id=body.question_id, tech=body.tech, label=label)
        rev.grade(db, entry, {"correct": "correct", "partial": "partial", "wrong": "wrong"}[body.result])
    db.commit()
    return {"ok": True, "streak": {"correct": row.correct, "partial": row.partial, "wrong": row.wrong}}


@router.get("/questions/difficult")
def difficult(tech: str | None = None, db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    stmt = select(QuestionState).where(QuestionState.marked_difficult.is_(True))
    if tech:
        stmt = stmt.where(QuestionState.tech_slug == tech)
    rows = db.scalars(stmt)
    out = []
    for row in rows:
        tech_obj = store.techs.get(row.tech_slug)
        question = None
        if tech_obj:
            question = next((q for q in tech_obj.basic + tech_obj.recent if q.id == row.question_id), None)
        out.append(
            {
                "id": row.question_id,
                "tech": row.tech_slug,
                "techTitle": tech_obj.title if tech_obj else row.tech_slug,
                "question": question.question if question else row.question_id,
                "wrong": row.wrong,
                "partial": row.partial,
                "correct": row.correct,
            }
        )
    return out


# ------------------------------------------------------------------ revisions
class RevisionGradeIn(BaseModel):
    result: str = Field(pattern="^(wrong|partial|correct_hint|correct)$")


@router.get("/revisions")
def revisions(db: Session = Depends(get_db)) -> dict[str, Any]:
    due = rev.due_items(db, limit=100)
    soon = rev.upcoming(db, days=14)
    all_rows = list(db.scalars(select(rev.Revision)))
    return {
        "due": [
            {
                "id": r.id,
                "kind": r.item_kind,
                "itemId": r.item_id,
                "tech": r.tech_slug,
                "label": r.label,
                "intervalDays": r.interval_days,
                "ease": round(r.ease, 2),
                "lapses": r.lapses,
            }
            for r in due
        ],
        "upcoming": [
            {
                "id": r.id,
                "label": r.label,
                "tech": r.tech_slug,
                "dueAt": r.due_at.isoformat(),
                "intervalDays": r.interval_days,
            }
            for r in soon
        ],
        "counts": {"due": len(due), "upcoming": len(soon), "tracked": len(all_rows)},
    }


@router.post("/revisions/{revision_id}/grade")
def grade_revision(revision_id: int, body: RevisionGradeIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    row = db.get(rev.Revision, revision_id)
    if not row:
        raise HTTPException(404, "revision not found")
    rev.grade(db, row, body.result)
    db.commit()
    return {"id": row.id, "dueAt": row.due_at.isoformat(), "intervalDays": row.interval_days}

class UpsertGradeIn(BaseModel):
    kind: str = "concept"
    item_id: str
    tech: str
    label: str = ""
    result: str = Field(pattern="^(wrong|partial|correct_hint|correct)$")


@router.post("/revisions/grade-item")
def grade_item(body: UpsertGradeIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Create the schedule entry if needed, then grade it. Used by Quick Revision."""
    entry = rev.upsert(db, kind=body.kind, item_id=body.item_id, tech=body.tech, label=body.label or body.item_id)
    rev.grade(db, entry, body.result)
    db.commit()
    return {"id": entry.id, "dueAt": entry.due_at.isoformat(), "intervalDays": entry.interval_days}
