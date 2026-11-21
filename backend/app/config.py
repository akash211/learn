"""Application settings, loaded from the repo-root .env file."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    app_name: str = "Learn"

    # storage
    db_path: Path = ROOT / "data" / "learn.db"
    content_dir: Path = ROOT / "content"
    frontend_dist: Path = ROOT / "frontend" / "dist"
    duckdb_path: Path = ROOT / "data" / "playground.duckdb"

    # server
    host: str = "0.0.0.0"
    port: int = 8099

    # AI (OpenAI-compatible endpoint; OpenRouter by default)
    ai_base_url: str = "https://openrouter.ai/api/v1"
    ai_api_key: str = ""
    ai_model_chat: str = "deepseek/deepseek-chat"
    ai_model_interview: str = "deepseek/deepseek-chat"
    ai_model_eval: str = "deepseek/deepseek-chat"
    ai_model_content: str = "deepseek/deepseek-chat"
    ai_timeout: float = 120.0
    ai_max_context_chars: int = 9000

    # sandbox
    sandbox_python_image: str = "python:3.12-slim"
    sandbox_bash_image: str = "alpine:3.20"
    sandbox_timeout_s: int = 10
    sandbox_memory: str = "256m"
    sandbox_cpus: str = "0.5"


settings = Settings()
