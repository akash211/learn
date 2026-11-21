"""Mock interview endpoints."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import interview as engine
from ..content import store
from ..db import get_db
from ..models import InterviewSession, InterviewTurn

router = APIRouter(prefix="/api/interview", tags=["interview"])


class StartIn(BaseModel):
    techs: list[str]
    difficulty: str = Field(default="intermediate", pattern="^(beginner|intermediate|advanced|expert)$")
    format: str = Field(default="mixed", pattern="^(conceptual|coding|scenario|system_design|mixed)$")
    questions: int = Field(default=6, ge=1, le=15)


@router.post("/start")
async def start(body: StartIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    techs = [t for t in body.techs if t in store.techs]
    if not techs:
        raise HTTPException(400, "select at least one known technology")
    session = InterviewSession(
        techs=",".join(techs),
        difficulty=body.difficulty,
        format=body.format,
        total_questions=body.questions,
    )
    db.add(session)
    db.commit()

    question = await engine.generate_question(session, [])
    turn = InterviewTurn(
        session_id=session.id,
        idx=0,
        tech_slug=question.get("tech", techs[0]),
        question=question["question"],
        hints_json=json.dumps(question.get("hints", [])),
    )
    db.add(turn)
    session.current_index = 0
    db.commit()
    return {
        "session_id": session.id,
        "total": session.total_questions,
        "index": 0,
        "turn_id": turn.id,
        "tech": turn.tech_slug,
        "topic": question.get("topic", ""),
        "question": turn.question,
        "hints": question.get("hints", []),
    }


class AnswerIn(BaseModel):
    answer: str


@router.get("/{session_id}")
def detail(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(404, "session not found")
    turns = engine.active_turns(db, session_id)
    return {
        "id": session.id,
        "techs": session.techs.split(","),
        "difficulty": session.difficulty,
        "format": session.format,
        "total": session.total_questions,
        "status": session.status,
        "score": session.score,
        "report": session.report_md,
        "startedAt": session.started_at.isoformat(),
        "turns": [
            {
                "id": t.id,
                "idx": t.idx,
                "tech": t.tech_slug,
                "question": t.question,
                "answer": t.answer,
                "feedback": t.feedback,
                "score": t.score,
                "hintsUsed": t.hints_used,
                "skipped": t.skipped,
            }
            for t in turns
        ],
    }


@router.post("/{session_id}/answer")
async def answer(session_id: int, body: AnswerIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if session.status != "active":
        raise HTTPException(409, "interview already finished")
    turns = engine.active_turns(db, session_id)
    if not turns:
        raise HTTPException(400, "no open question")
    turn = turns[-1]
    if turn.answer:
        raise HTTPException(409, "question already answered")

    evaluation = await engine.evaluate_answer(turn, body.answer)
    turn.answer = body.answer
    turn.score = float(evaluation.get("score", 0))
    turn.feedback = _feedback_markdown(evaluation)
    turn.answered_at = datetime.now(timezone.utc)
    db.commit()

    next_payload: dict[str, Any] | None = None
    if session.current_index + 1 < session.total_questions:
        session.current_index += 1
        db.commit()
        asked = [t.question for t in turns]
        question = await engine.generate_question(session, asked)
        new_turn = InterviewTurn(
            session_id=session.id,
            idx=session.current_index,
            tech_slug=question.get("tech", session.techs.split(",")[0]),
            question=question["question"],
            hints_json=json.dumps(question.get("hints", [])),
        )
        db.add(new_turn)
        db.commit()
        next_payload = {
            "turn_id": new_turn.id,
            "index": session.current_index,
            "tech": new_turn.tech_slug,
            "topic": question.get("topic", ""),
            "question": new_turn.question,
            "hints": question.get("hints", []),
        }
    else:
        all_turns = engine.active_turns(db, session_id)
        score, report = await engine.build_report(session, all_turns)
        engine.finish(db, session, score, report)
        db.commit()

    return {
        "evaluation": {
            "verdict": evaluation.get("verdict"),
            "score": turn.score,
            "feedback": turn.feedback,
            "followUp": evaluation.get("follow_up", ""),
        },
        "next": next_payload,
        "finished": session.status == "finished",
    }


def _feedback_markdown(ev: dict) -> str:
    lines = [f"**{ev.get('verdict', 'partial').title()} · {ev.get('score', 0)}/10**", "", ev.get("why", "")]
    for title, key in (("Strengths", "strengths"), ("Gaps", "gaps"), ("Inaccuracies", "inaccuracies")):
        items = ev.get(key) or []
        if items:
            lines += ["", f"*{title}:* " + "; ".join(items)]
    if ev.get("follow_up"):
        lines += ["", f"**Follow-up:** {ev['follow_up']}"]
    return "\n".join(lines)


class HintIn(BaseModel):
    level: int = Field(default=1, ge=1, le=3)


@router.post("/{session_id}/hint")
def hint(session_id: int, body: HintIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(404, "session not found")
    turns = engine.active_turns(db, session_id)
    if not turns:
        raise HTTPException(400, "no open question")
    turn = turns[-1]
    # hints were generated with the question; store them on first use
    hints = _stored_hints(turn)
    if not hints:
        return {"hint": "No hints recorded for this question — answer what you can and we will discuss it.", "level": body.level}
    level = min(body.level, len(hints))
    turn.hints_used = max(turn.hints_used, level)
    db.commit()
    return {"hint": hints[level - 1], "level": level, "of": len(hints)}


def _stored_hints(turn: InterviewTurn) -> list[str]:
    try:
        data = json.loads(turn.hints_json or "[]")
        return [str(h) for h in data if h]
    except json.JSONDecodeError:
        return []


@router.post("/{session_id}/skip")
async def skip(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(404, "session not found")
    turns = engine.active_turns(db, session_id)
    if not turns:
        raise HTTPException(400, "no open question")
    turn = turns[-1]
    turn.skipped = True
    turn.answer = "(skipped)"
    turn.score = 0.0
    turn.answered_at = datetime.now(timezone.utc)
    db.commit()
    next_payload = None
    if session.current_index + 1 < session.total_questions:
        session.current_index += 1
        db.commit()
        question = await engine.generate_question(session, [t.question for t in turns])
        new_turn = InterviewTurn(
            session_id=session.id,
            idx=session.current_index,
            tech_slug=question.get("tech", session.techs.split(",")[0]),
            question=question["question"],
            hints_json=json.dumps(question.get("hints", [])),
        )
        db.add(new_turn)
        db.commit()
        next_payload = {
            "turn_id": new_turn.id,
            "index": session.current_index,
            "tech": new_turn.tech_slug,
            "question": new_turn.question,
            "hints": question.get("hints", []),
        }
    else:
        all_turns = engine.active_turns(db, session_id)
        score, report = await engine.build_report(session, all_turns)
        engine.finish(db, session, score, report)
        db.commit()
    return {"next": next_payload, "finished": session.status == "finished"}


@router.post("/{session_id}/finish")
async def finish(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(404, "session not found")
    if session.status == "finished":
        return {"score": session.score, "report": session.report_md}
    turns = engine.active_turns(db, session_id)
    if not turns:
        raise HTTPException(400, "nothing to report yet")
    score, report = await engine.build_report(session, turns)
    engine.finish(db, session, score, report)
    db.commit()
    return {"score": score, "report": report}


@router.get("")
def history(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(InterviewSession).order_by(InterviewSession.started_at.desc()).limit(50))
    return [
        {
            "id": s.id,
            "techs": s.techs.split(","),
            "difficulty": s.difficulty,
            "format": s.format,
            "total": s.total_questions,
            "status": s.status,
            "score": s.score,
            "startedAt": s.started_at.isoformat(),
        }
        for s in rows
    ]
