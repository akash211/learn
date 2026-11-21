"""SM-2 style spaced repetition for questions and concepts."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Revision

GRADES = {"wrong": 0, "partial": 1, "correct_hint": 2, "correct": 3}


def upsert(db: Session, *, kind: str, item_id: str, tech: str, label: str) -> Revision:
    rev = db.scalar(select(Revision).where(Revision.item_kind == kind, Revision.item_id == item_id))
    if rev is None:
        rev = Revision(item_kind=kind, item_id=item_id, tech_slug=tech, label=label, due_at=datetime.now(timezone.utc))
        db.add(rev)
        db.flush()
    return rev


def grade(db: Session, rev: Revision, result: str) -> Revision:
    """result: wrong | partial | correct_hint | correct"""
    now = datetime.now(timezone.utc)
    quality = GRADES.get(result, 1)

    if quality < 2:
        rev.repetitions = 0
        rev.lapses += 1
        rev.interval_days = 1
        rev.ease = max(1.3, rev.ease - 0.2)
    else:
        rev.repetitions += 1
        if rev.repetitions == 1:
            rev.interval_days = 1
        elif rev.repetitions == 2:
            rev.interval_days = 3
        else:
            rev.interval_days = int(round(rev.interval_days * rev.ease))
        # a hint-assisted answer should not stretch the interval as much
        if quality == 2:
            rev.interval_days = max(1, int(round(rev.interval_days * 0.6)))
            rev.ease = max(1.3, rev.ease - 0.05)
        else:
            rev.ease = min(2.8, rev.ease + 0.05)

    rev.interval_days = max(1, min(rev.interval_days, 180))
    rev.due_at = now + timedelta(days=rev.interval_days)
    rev.last_result = result
    rev.updated_at = now
    db.flush()
    return rev


def due_items(db: Session, limit: int = 50, tech: str | None = None) -> list[Revision]:
    stmt = select(Revision).where(Revision.due_at <= datetime.now(timezone.utc))
    if tech:
        stmt = stmt.where(Revision.tech_slug == tech)
    stmt = stmt.order_by(Revision.due_at).limit(limit)
    return list(db.scalars(stmt))


def upcoming(db: Session, days: int = 14) -> list[Revision]:
    until = datetime.now(timezone.utc) + timedelta(days=days)
    stmt = select(Revision).where(Revision.due_at > datetime.now(timezone.utc), Revision.due_at <= until)
    return list(db.scalars(stmt.order_by(Revision.due_at)))
