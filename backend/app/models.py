"""SQLAlchemy models. Single-user app: no auth tables, everything is shared."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ChapterProgress(Base):
    __tablename__ = "chapter_progress"
    __table_args__ = (UniqueConstraint("tech_slug", "chapter_id", name="uq_chapter"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    tech_slug: Mapped[str] = mapped_column(String(80), index=True)
    chapter_id: Mapped[str] = mapped_column(String(120))
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    seconds_spent: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class TechProgress(Base):
    __tablename__ = "tech_progress"

    tech_slug: Mapped[str] = mapped_column(String(80), primary_key=True)
    last_chapter_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_visited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Bookmark(Base):
    __tablename__ = "bookmarks"
    __table_args__ = (UniqueConstraint("kind", "tech_slug", "ref", name="uq_bookmark"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # chapter | question | scenario | concept | tech
    tech_slug: Mapped[str] = mapped_column(String(80), index=True)
    ref: Mapped[str] = mapped_column(String(160))
    label: Mapped[str] = mapped_column(String(400), default="")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class QuestionState(Base):
    __tablename__ = "question_state"

    question_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    tech_slug: Mapped[str] = mapped_column(String(80), index=True)
    seen: Mapped[int] = mapped_column(Integer, default=0)
    correct: Mapped[int] = mapped_column(Integer, default=0)
    partial: Mapped[int] = mapped_column(Integer, default=0)
    wrong: Mapped[int] = mapped_column(Integer, default=0)
    marked_difficult: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    tech_slug: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    chapter_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    ref: Mapped[str | None] = mapped_column(String(160), nullable=True)  # question/scenario id
    title: Mapped[str] = mapped_column(String(300), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | ai | interview
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Revision(Base):
    """SM-2 style schedule entry for a concept or question."""

    __tablename__ = "revisions"
    __table_args__ = (UniqueConstraint("item_kind", "item_id", name="uq_revision_item"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    item_kind: Mapped[str] = mapped_column(String(20))  # question | concept | chapter
    item_id: Mapped[str] = mapped_column(String(160))
    tech_slug: Mapped[str] = mapped_column(String(80), index=True)
    label: Mapped[str] = mapped_column(String(400), default="")
    ease: Mapped[float] = mapped_column(Float, default=2.5)
    interval_days: Mapped[int] = mapped_column(Integer, default=1)
    repetitions: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    last_result: Mapped[str | None] = mapped_column(String(20), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), default="New discussion")
    tech_slug: Mapped[str | None] = mapped_column(String(80), nullable=True, index=True)
    chapter_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant | system
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InterviewSession(Base):
    __tablename__ = "interview_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    techs: Mapped[str] = mapped_column(String(400))  # comma separated slugs
    difficulty: Mapped[str] = mapped_column(String(20), default="intermediate")
    format: Mapped[str] = mapped_column(String(30), default="mixed")
    total_questions: Mapped[int] = mapped_column(Integer, default=6)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | finished
    current_index: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    report_md: Mapped[str | None] = mapped_column(Text, nullable=True)


class InterviewTurn(Base):
    __tablename__ = "interview_turns"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("interview_sessions.id", ondelete="CASCADE"), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    tech_slug: Mapped[str] = mapped_column(String(80), default="")
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    hints_json: Mapped[str] = mapped_column(Text, default="[]")
    feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    hints_used: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[bool] = mapped_column(Boolean, default=False)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    asked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
