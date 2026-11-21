"""Provider-agnostic LLM client.

Anything OpenAI-compatible works: OpenRouter, vLLM, Ollama, LM Studio, Groq. Only the base
URL, key and model names in .env change.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import settings


class AIError(RuntimeError):
    pass


def configured() -> bool:
    return bool(settings.ai_api_key)


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://learn.local",
        "X-Title": "Learn",
    }


async def complete(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.4,
    max_tokens: int = 1600,
) -> str:
    """Single non-streamed completion."""
    if not configured():
        raise AIError("AI is not configured: set AI_API_KEY in .env")
    payload: dict[str, Any] = {
        "model": model or settings.ai_model_chat,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=settings.ai_timeout) as client:
        res = await client.post(f"{settings.ai_base_url}/chat/completions", json=payload, headers=_headers())
        if res.status_code >= 400:
            raise AIError(f"provider {res.status_code}: {res.text[:400]}")
        data = res.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise AIError(f"unexpected provider response: {str(data)[:300]}") from exc


async def stream(
    messages: list[dict[str, str]],
    *,
    model: str | None = None,
    temperature: float = 0.4,
    max_tokens: int = 2000,
) -> AsyncIterator[str]:
    """Yield content deltas as they arrive."""
    if not configured():
        raise AIError("AI is not configured: set AI_API_KEY in .env")
    payload = {
        "model": model or settings.ai_model_chat,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=settings.ai_timeout) as client:
        async with client.stream(
            "POST", f"{settings.ai_base_url}/chat/completions", json=payload, headers=_headers()
        ) as res:
            if res.status_code >= 400:
                body = (await res.aread()).decode("utf-8", "replace")[:400]
                raise AIError(f"provider {res.status_code}: {body}")
            async for line in res.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    delta = json.loads(chunk)["choices"][0].get("delta", {}).get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta


# ------------------------------------------------------------------ prompts
SYSTEM_TUTOR = (
    "You are a senior data and AI engineer acting as a technical tutor for one reader: a lead "
    "data engineer with 14 years of experience preparing for senior interviews. Be direct and "
    "technically precise. Prefer concrete examples, real syntax and production trade-offs over "
    "generic summaries. When the reader is vague, correct them. Never invent benchmark numbers, "
    "citations or interview reports. Use Markdown with short sections and fenced code blocks."
)


def chapter_context(tech_title: str, chapter_title: str, body: str) -> str:
    excerpt = body[: settings.ai_max_context_chars]
    return (
        f"The reader is studying '{tech_title}' — chapter '{chapter_title}'. "
        f"Use this chapter as context and answer in its terms:\n\n{excerpt}"
    )


def build_chat_messages(
    history: list[dict[str, str]],
    *,
    context: str | None = None,
    extra_system: str | None = None,
) -> list[dict[str, str]]:
    msgs: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_TUTOR}]
    if extra_system:
        msgs.append({"role": "system", "content": extra_system})
    if context:
        msgs.append({"role": "system", "content": context})
    msgs.extend(history)
    return msgs
