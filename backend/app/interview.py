"""Mock interview engine: question generation, answer evaluation, final report.

State lives in SQLite (InterviewSession / InterviewTurn) so a reload never loses a session.
The model is asked for JSON; parsers are tolerant because providers wrap JSON in prose or
code fences often enough to matter.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import ai
from .config import settings
from .models import InterviewSession, InterviewTurn
from .content import store

INTERVIEWER_SYSTEM = (
    "You are a demanding but fair senior technical interviewer at a product company, "
    "interviewing a lead data engineer with 14 years of experience. "
    "Ask one question at a time. Judge substance, not keywords. Never reveal the ideal answer "
    "before the candidate has answered. Never invent company names or fake interview reports."
)

DIFFICULTY_GUIDE = {
    "beginner": "fundamentals and definitions, one step above trivia",
    "intermediate": "applied understanding, trade-offs and everyday production work",
    "advanced": "internals, failure modes, performance at scale, design decisions",
    "expert": "architectural judgement, ambiguity, cost/latency trade-offs, leadership of hard incidents",
}

FORMAT_GUIDE = {
    "conceptual": "conceptual depth questions",
    "coding": "hands-on coding or SQL-writing questions the candidate answers in prose or code",
    "scenario": "production scenarios and incident triage",
    "system_design": "architecture and system design with explicit constraints",
    "mixed": "a realistic mix of conceptual, scenario and design questions",
}


def _extract_json(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    if not text.startswith("{"):
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    return json.loads(text)


async def generate_question(session: InterviewSession, asked: list[str]) -> dict:
    techs = [t for t in session.techs.split(",") if t in store.techs]
    available = []
    for slug in techs:
        tech = store.techs[slug]
        available.append(
            f"- {tech.title} ({slug}): chapters = "
            + "; ".join(c.title for c in tech.chapters[:10])
        )
    asked_block = "\n".join(f"- {q}" for q in asked[-8:]) or "- (none yet)"
    prompt = f"""Design question {session.current_index + 1} of {session.total_questions} for this interview.

Technologies in scope:
{chr(10).join(available)}

Difficulty: {session.difficulty} — {DIFFICULTY_GUIDE.get(session.difficulty, "")}
Format: {session.format} — {FORMAT_GUIDE.get(session.format, "")}

Questions already asked — the next question must cover a DIFFERENT topic and a different
chapter, never a reworded version of any of these:
{asked_block}

Return ONLY JSON with this shape:
{{"tech": "<slug from the list>", "topic": "<short topic label>",
  "question": "<the question, 1-3 sentences, specific>",
  "hints": ["<small clue>", "<points at the concept>", "<strong direction, still not the answer>"],
  "must_cover": ["<3-6 key points a strong answer contains>"]}}"""
    raw = await ai.complete(
        [{"role": "system", "content": INTERVIEWER_SYSTEM}, {"role": "user", "content": prompt}],
        model=settings.ai_model_interview,
        temperature=0.8,
        max_tokens=900,
    )
    data = _extract_json(raw)
    data.setdefault("tech", techs[0] if techs else "")
    # models often return the display title instead of the slug
    slug = str(data.get("tech", "")).strip()
    if slug not in store.techs:
        match = next((t for t in store.techs if store.techs[t].title.lower() == slug.lower()), None)
        data["tech"] = match or (techs[0] if techs else slug.lower())
    data.setdefault("hints", [])
    data.setdefault("must_cover", [])
    return data


async def evaluate_answer(turn: InterviewTurn, answer: str) -> dict:
    prompt = f"""Evaluate this interview answer honestly and strictly.

Question: {turn.question}

Candidate answer:
{answer}

Return ONLY JSON:
{{"verdict": "correct|partial|incorrect",
  "score": <0-10 float>,
  "why": "<one or two sentences, direct>",
  "strengths": ["..."],
  "gaps": ["..."],
  "inaccuracies": ["..."],
  "follow_up": "<one probing follow-up question, or empty string>"}}"""
    raw = await ai.complete(
        [{"role": "system", "content": INTERVIEWER_SYSTEM}, {"role": "user", "content": prompt}],
        model=settings.ai_model_eval,
        temperature=0.2,
        max_tokens=900,
    )
    data = _extract_json(raw)
    data["score"] = float(data.get("score", 0))
    return data


async def build_report(session: InterviewSession, turns: list[InterviewTurn]) -> tuple[float, str]:
    transcript = []
    for t in turns:
        transcript.append(
            f"Q{t.idx + 1} [{t.tech_slug}] {t.question}\nAnswer: {t.answer or '(skipped)'}\n"
            f"Score: {t.score}\nFeedback: {t.feedback or '-'}\nHints used: {t.hints_used}"
        )
    prompt = f"""Write the final report for this {session.difficulty} {session.format} interview.

Transcript:
{chr(10).join(transcript)}

Return ONLY JSON:
{{"overall_score": <0-100 number>,
  "verdict": "<one line, e.g. 'Strong senior signal, weak on streaming internals'>",
  "by_technology": [{{"tech": "<slug>", "score": <0-100>, "note": "<short>"}}],
  "strengths": ["..."],
  "gaps": ["..."],
  "misconceptions": ["..."],
  "revision_plan": [{{"topic": "<what to revise>", "why": "<evidence from answers>"}}],
  "one_line_summary": "<for the history list>"}}"""
    raw = await ai.complete(
        [{"role": "system", "content": INTERVIEWER_SYSTEM}, {"role": "user", "content": prompt}],
        model=settings.ai_model_eval,
        temperature=0.3,
        max_tokens=1500,
    )
    data = _extract_json(raw)
    # The model's own total drifts; per-question grades are the auditable signal.
    graded = [t.score for t in turns if t.score is not None and not t.skipped]
    if graded:
        score = round(10.0 * sum(graded) / len(graded), 1)
    else:
        score = float(data.get("overall_score", 0))
    score = max(0.0, min(100.0, score))
    data["overall_score"] = score
    md = _report_markdown(data, session, turns)
    return score, md


def _report_markdown(data: dict, session: InterviewSession, turns: list[InterviewTurn]) -> str:
    lines = [
        f"# Mock interview report",
        "",
        f"**Overall score:** {data.get('overall_score', 0):.0f}/100  ",
        f"**Verdict:** {data.get('verdict', '—')}  ",
        f"**Format:** {session.format} · {session.difficulty} · {session.total_questions} questions",
        "",
        "## Performance by technology",
    ]
    for row in data.get("by_technology", []):
        lines.append(f"- **{row.get('tech', '?')}** — {row.get('score', 0)}/100. {row.get('note', '')}")
    for title, key in (("What worked", "strengths"), ("Gaps", "gaps"), ("Misconceptions", "misconceptions")):
        items = data.get(key) or []
        if items:
            lines += ["", f"## {title}"] + [f"- {i}" for i in items]
    plan = data.get("revision_plan") or []
    if plan:
        lines += ["", "## Revision plan"] + [f"- **{p.get('topic', '')}** — {p.get('why', '')}" for p in plan]
    lines += ["", "## Question by question"]
    for t in turns:
        lines += [
            "",
            f"### Q{t.idx + 1} · {t.tech_slug} · {t.score if t.score is not None else '—'}/10"
            + (f" · {t.hints_used} hint(s)" if t.hints_used else ""),
            f"**Question:** {t.question}",
            "",
            f"**Your answer:** {t.answer or '_(skipped)_'}",
            "",
            f"**Feedback:** {t.feedback or '—'}",
        ]
    return "\n".join(lines)


def active_turns(db: Session, session_id: int) -> list[InterviewTurn]:
    return list(db.scalars(select(InterviewTurn).where(InterviewTurn.session_id == session_id).order_by(InterviewTurn.idx)))


def finish(db: Session, session: InterviewSession, score: float, report_md: str) -> None:
    session.status = "finished"
    session.score = score
    session.report_md = report_md
    session.finished_at = datetime.now(timezone.utc)
    db.flush()
