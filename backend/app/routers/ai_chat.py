"""AI learning assistant: contextual discussions (streamed) and 'improve my answer'."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import ai
from ..config import settings
from ..content import store
from ..db import SessionLocal, get_db
from ..models import ChatMessage, ChatSession

router = APIRouter(prefix="/api/ai", tags=["ai"])


class ChatIn(BaseModel):
    session_id: int | None = None
    tech: str | None = None
    chapter: str | None = None
    message: str


def _context(tech: str | None, chapter: str | None) -> str | None:
    if not tech or tech not in store.techs:
        return None
    obj = store.techs[tech]
    if chapter:
        ch = obj.chapter(chapter)
        if ch:
            return ai.chapter_context(obj.title, ch.title, ch.body)
    return f"The reader is studying '{obj.title}'. Summary: {obj.summary}"


@router.get("/status")
def status() -> dict[str, Any]:
    return {
        "configured": ai.configured(),
        "model": settings.ai_model_chat,
        "baseUrl": settings.ai_base_url.split("/v1")[0] if settings.ai_base_url else "",
    }


@router.get("/sessions")
def sessions(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(ChatSession).order_by(ChatSession.updated_at.desc()).limit(50))
    return [
        {
            "id": s.id,
            "title": s.title,
            "tech": s.tech_slug,
            "chapter": s.chapter_id,
            "updatedAt": s.updated_at.isoformat(),
        }
        for s in rows
    ]


@router.post("/sessions")
def new_session(body: dict[str, Any], db: Session = Depends(get_db)) -> dict[str, Any]:
    row = ChatSession(
        title=body.get("title") or "New discussion",
        tech_slug=body.get("tech"),
        chapter_id=body.get("chapter"),
    )
    db.add(row)
    db.commit()
    return {"id": row.id}


@router.get("/sessions/{session_id}")
def session_detail(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    row = db.get(ChatSession, session_id)
    if not row:
        raise HTTPException(404, "session not found")
    msgs = db.scalars(select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.id))
    return {
        "id": row.id,
        "title": row.title,
        "tech": row.tech_slug,
        "chapter": row.chapter_id,
        "messages": [{"role": m.role, "content": m.content, "at": m.created_at.isoformat()} for m in msgs],
    }


@router.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    row = db.get(ChatSession, session_id)
    if row:
        for m in db.scalars(select(ChatMessage).where(ChatMessage.session_id == session_id)):
            db.delete(m)
        db.delete(row)
        db.commit()
    return {"deleted": True}


@router.post("/chat/stream")
async def chat_stream(body: ChatIn) -> StreamingResponse:
    if not ai.configured():
        raise HTTPException(503, "AI is not configured — set AI_API_KEY in .env")

    db = SessionLocal()
    try:
        session = db.get(ChatSession, body.session_id) if body.session_id else None
        if session is None:
            session = ChatSession(
                title=body.message[:60] or "New discussion", tech_slug=body.tech, chapter_id=body.chapter
            )
            db.add(session)
            db.flush()
        user_msg = ChatMessage(session_id=session.id, role="user", content=body.message)
        db.add(user_msg)
        session.updated_at = datetime.now(timezone.utc)
        db.commit()

        history = [
            {"role": m.role, "content": m.content}
            for m in db.scalars(
                select(ChatMessage).where(ChatMessage.session_id == session.id).order_by(ChatMessage.id)
            )
        ][-20:]
        session_id = session.id
        db.close()

        messages = ai.build_chat_messages(history, context=_context(body.tech, body.chapter))
    except Exception:
        db.close()
        raise

    async def gen() -> AsyncIterator[bytes]:
        chunks: list[str] = []
        yield f'data: {json.dumps({"session_id": session_id})}\n\n'.encode()
        try:
            async for delta in ai.stream(messages, model=settings.ai_model_chat):
                chunks.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n".encode()
        except (ai.AIError, httpx.HTTPError) as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n".encode()
        finally:
            text = "".join(chunks).strip()
            if text:
                s = SessionLocal()
                s.add(ChatMessage(session_id=session_id, role="assistant", content=text))
                sess = s.get(ChatSession, session_id)
                if sess and sess.title in ("New discussion", ""):
                    sess.title = text[:60]
                s.commit()
                s.close()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ImproveIn(BaseModel):
    tech: str | None = None
    question: str
    my_answer: str


@router.post("/improve")
async def improve(body: ImproveIn) -> StreamingResponse:
    if not ai.configured():
        raise HTTPException(503, "AI is not configured — set AI_API_KEY in .env")
    tech_title = store.techs[body.tech].title if body.tech in store.techs else "the subject"
    prompt = f"""You are coaching a lead-level {tech_title} candidate to answer interviews better.

Question: {body.question}

The candidate's answer:
\"\"\"{body.my_answer}\"\"\"

Return Markdown with exactly these sections:
## Verdict
One line: correct / partially correct / incorrect, and why.
## What was good
- bullets
## What was missing
- bullets
## Inaccuracies
- bullets (say "none found" if so)
## A better answer
A tightened version they could actually say out loud, 120-200 words.
## Senior-level answer
What a lead engineer would add: trade-offs, failure modes, numbers where defensible.
## Likely follow-ups
3 follow-up questions an interviewer would ask next."""
    messages = [
        {"role": "system", "content": ai.SYSTEM_TUTOR},
        {"role": "user", "content": prompt},
    ]

    async def gen() -> AsyncIterator[bytes]:
        try:
            async for delta in ai.stream(messages, model=settings.ai_model_eval, temperature=0.3):
                yield f"data: {json.dumps({'delta': delta})}\n\n".encode()
        except (ai.AIError, httpx.HTTPError) as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n".encode()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})
