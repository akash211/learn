"""Content loading, validation and full-text indexing.

The filesystem under content/tech/ is the source of truth. Everything the API serves about
learning material comes from here; the database only holds personal state.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import settings


class ContentError(RuntimeError):
    pass


@dataclass
class Chapter:
    id: str
    title: str
    file: str
    minutes: int
    level: str
    body: str = ""


@dataclass
class Question:
    id: str
    topic: str
    difficulty: str
    question: str
    answer: str
    tags: list[str] = field(default_factory=list)
    period: str | None = None
    type: str | None = None


@dataclass
class Scenario:
    id: str
    title: str
    technologies: list[str]
    difficulty: str
    prompt: str
    approach: str
    red_flags: list[str] = field(default_factory=list)


@dataclass
class QuickRev:
    concepts: list[dict] = field(default_factory=list)
    traps: list[str] = field(default_factory=list)
    advanced: list[str] = field(default_factory=list)
    comparisons: list[dict] = field(default_factory=list)
    commands: list[dict] = field(default_factory=list)


@dataclass
class Tech:
    slug: str
    title: str
    category: str
    summary: str
    level: str
    intro: dict[str, Any]
    relations: list[dict[str, Any]]
    chapters: list[Chapter]
    basic: list[Question]
    recent: list[Question]
    scenarios: list[Scenario]
    quickrev: QuickRev
    path: Path

    def chapter(self, chapter_id: str) -> Chapter | None:
        return next((c for c in self.chapters if c.id == chapter_id), None)


class ContentStore:
    def __init__(self) -> None:
        self.categories: dict[str, str] = {}
        self.techs: dict[str, Tech] = {}
        self.errors: list[str] = []
        self.planned: dict[str, int] = {}

    # ---------------------------------------------------------------- loading
    def load(self) -> None:
        self.categories = self._load_categories()
        self.techs = {}
        self.errors = []
        root = settings.content_dir / "tech"
        if not root.exists():
            self.errors.append(f"content directory missing: {root}")
            return
        for folder in sorted(p for p in root.iterdir() if p.is_dir()):
            try:
                tech = self._load_tech(folder)
                self.techs[tech.slug] = tech
            except Exception as exc:  # keep the rest of the library usable
                self.errors.append(f"{folder.name}: {exc}")

        # Relations pointing at unauthored technologies are dropped from the graph, but the
        # slugs are kept so the authoring backlog is visible instead of silently lost.
        self.planned = {}
        for tech in self.techs.values():
            for rel in tech.relations:
                if rel.get("to") not in self.techs:
                    self.planned[rel["to"]] = self.planned.get(rel["to"], 0) + 1
            tech.relations = [r for r in tech.relations if r.get("to") in self.techs]

    def _load_categories(self) -> dict[str, str]:
        path = settings.content_dir / "categories.yaml"
        if not path.exists():
            return {}
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or []
        return {item["key"]: item["title"] for item in data}

    def _load_tech(self, folder: Path) -> Tech:
        meta_path = folder / "tech.yaml"
        if not meta_path.exists():
            raise ContentError("tech.yaml missing")
        meta = yaml.safe_load(meta_path.read_text(encoding="utf-8")) or {}
        slug = meta.get("slug") or folder.name
        for key in ("title", "category", "summary", "intro", "chapters"):
            if key not in meta:
                raise ContentError(f"tech.yaml missing key '{key}'")

        chapters: list[Chapter] = []
        for raw in meta["chapters"]:
            body = ""
            chapter_path = folder / raw["file"]
            if chapter_path.exists():
                body = chapter_path.read_text(encoding="utf-8")
            chapters.append(
                Chapter(
                    id=raw["id"],
                    title=raw["title"],
                    file=raw["file"],
                    minutes=int(raw.get("minutes", 10)),
                    level=raw.get("level", "core"),
                    body=body,
                )
            )

        basic = self._load_questions(folder / meta.get("questions", {}).get("basic", "questions/basic.yaml"))
        recent = self._load_questions(folder / meta.get("questions", {}).get("recent", "questions/recent.yaml"))

        scenarios: list[Scenario] = []
        scn_path = folder / meta.get("scenarios", "scenarios.yaml")
        if scn_path.exists():
            for raw in yaml.safe_load(scn_path.read_text(encoding="utf-8")) or []:
                scenarios.append(
                    Scenario(
                        id=raw["id"],
                        title=raw["title"],
                        technologies=raw.get("technologies", [slug]),
                        difficulty=raw.get("difficulty", "advanced"),
                        prompt=raw["prompt"],
                        approach=raw.get("approach", ""),
                        red_flags=raw.get("red_flags", []),
                    )
                )

        qr = QuickRev()
        qr_path = folder / meta.get("quickrev", "quickrev.yaml")
        if qr_path.exists():
            raw = yaml.safe_load(qr_path.read_text(encoding="utf-8")) or {}
            qr = QuickRev(
                concepts=raw.get("concepts", []),
                traps=raw.get("traps", []),
                advanced=raw.get("advanced", []),
                comparisons=raw.get("comparisons", []),
                commands=raw.get("commands", []),
            )

        return Tech(
            slug=slug,
            title=meta["title"],
            category=meta["category"],
            summary=meta.get("summary", ""),
            level=meta.get("level", "core"),
            intro=meta["intro"],
            relations=meta.get("relations", []),
            chapters=chapters,
            basic=basic,
            recent=recent,
            scenarios=scenarios,
            quickrev=qr,
            path=folder,
        )

    def _load_questions(self, path: Path) -> list[Question]:
        if not path.exists():
            return []
        out: list[Question] = []
        seen: set[str] = set()
        for raw in yaml.safe_load(path.read_text(encoding="utf-8")) or []:
            qid = raw["id"]
            if qid in seen:
                raise ContentError(f"duplicate question id {qid}")
            seen.add(qid)
            out.append(
                Question(
                    id=qid,
                    topic=raw.get("topic", ""),
                    difficulty=raw.get("difficulty", "intermediate"),
                    question=raw["question"],
                    answer=raw["answer"],
                    tags=raw.get("tags", []),
                    period=raw.get("period"),
                    type=raw.get("type"),
                )
            )
        return out

    # ---------------------------------------------------------------- helpers
    def list_techs(self) -> list[Tech]:
        return sorted(self.techs.values(), key=lambda t: t.title.lower())

    def graph(self) -> dict[str, Any]:
        nodes = [
            {
                "id": t.slug,
                "label": t.title,
                "category": t.category,
                "categoryTitle": self.categories.get(t.category, t.category),
            }
            for t in self.techs.values()
        ]
        links = [
            {"source": t.slug, "target": r["to"], "type": r.get("type", "related"), "note": r.get("note", "")}
            for t in self.techs.values()
            for r in t.relations
        ]
        # de-duplicate mirrored relations
        seen: set[tuple[str, str]] = set()
        unique = []
        for link in links:
            key = tuple(sorted((link["source"], link["target"])))
            if key in seen:
                continue
            seen.add(key)
            unique.append(link)
        return {"nodes": nodes, "links": unique}


store = ContentStore()


# ------------------------------------------------------------------ FTS index
_FRONT = re.compile(r"^---.*?---", re.S)
_CODE = re.compile(r"```.*?```", re.S)


def _plain(md: str) -> str:
    text = _FRONT.sub("", md)
    text = _CODE.sub(" ", text)
    text = re.sub(r"[#>*_`|]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def rebuild_search_index(conn) -> int:
    """Rebuild the SQLite FTS index from the content tree."""
    conn.exec_driver_sql("DROP TABLE IF EXISTS search_fts")
    conn.exec_driver_sql(
        "CREATE VIRTUAL TABLE search_fts USING fts5("
        "kind, tech, ref, title, body, tokenize='porter unicode61')"
    )
    rows: list[tuple[str, str, str, str, str]] = []
    for tech in store.techs.values():
        rows.append(("tech", tech.slug, tech.slug, tech.title, _plain(tech.summary + " " + json.dumps(tech.intro))))
        for chapter in tech.chapters:
            rows.append(("chapter", tech.slug, chapter.id, chapter.title, _plain(chapter.body)))
        for q in tech.basic + tech.recent:
            rows.append(("question", tech.slug, q.id, q.question, _plain(q.answer)))
        for s in tech.scenarios:
            rows.append(("scenario", tech.slug, s.id, s.title, _plain(s.prompt + " " + s.approach)))
        for concept in tech.quickrev.concepts:
            rows.append(("concept", tech.slug, concept.get("title", ""), concept.get("title", ""), _plain(str(concept.get("detail", "")))))
    conn.exec_driver_sql(
        "INSERT INTO search_fts (kind, tech, ref, title, body) VALUES (?, ?, ?, ?, ?)", rows
    )
    conn.commit()
    return len(rows)


if __name__ == "__main__":  # validation entry point: python -m backend.app.content
    store.load()
    print(f"categories: {len(store.categories)}")
    for tech in store.list_techs():
        print(
            f"{tech.slug:22} chapters={len(tech.chapters):2} basic={len(tech.basic):3} "
            f"recent={len(tech.recent):3} scenarios={len(tech.scenarios):2} "
            f"quickrev={len(tech.quickrev.concepts):2}"
        )
    if store.errors:
        print("\nERRORS:")
        for err in store.errors:
            print(" -", err)
        raise SystemExit(1)
