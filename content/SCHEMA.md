# Content schema

Learning material is data, not code. Adding a technology means adding a folder — the backend
discovers it at startup and re-indexes search.

## Folder layout

```
content/
├─ categories.yaml
└─ tech/<slug>/
   ├─ tech.yaml
   ├─ chapters/01-topic.md …
   ├─ questions/basic.yaml
   ├─ questions/recent.yaml
   ├─ scenarios.yaml
   └─ quickrev.yaml
```

`<slug>` is lowercase, hyphenated (`python`, `sql`, `microsoft-fabric`).

## `tech.yaml`

```yaml
slug: python
title: Python
category: programming          # key from categories.yaml
summary: One sentence used on cards and search results.
level: core                    # core | advanced
relations:                     # drives the technology map
  - to: pyspark
    type: foundation           # foundation | uses | part-of | alternative | complements
    note: PySpark's Python API sits on top of these concepts.
intro:
  what: |
    Short paragraphs, Markdown allowed.
  why: |
    Why the technology exists.
  problems:
    - Problem it solves, one line each.
  where_used:
    - Where it shows up in practice.
  ecosystem: |
    How it fits with neighbours.
  alternatives:
    - name: R
      note: Preferred for classical statistics.
  related: [pyspark, pandas, sql]
chapters:
  - id: data-structures
    title: Data Structures
    file: chapters/01-data-structures.md
    minutes: 12
    level: core                # core | advanced
questions:
  basic: questions/basic.yaml
  recent: questions/recent.yaml
scenarios: scenarios.yaml
quickrev: quickrev.yaml
```

## Chapters (`chapters/*.md`)

Plain Markdown. Start with `# Chapter title`, then `##` sections. Rules:

- Teach, don't list. Every section earns its place.
- Use tables for comparisons, fenced code blocks with a language tag, and short
  "Common mistakes" / "Production notes" subsections.
- Number files so reading order is obvious (`01-…`, `02-…`).
- Keep a chapter to roughly 700–1400 words: dense but readable in 5–15 minutes.

## Questions (`questions/basic.yaml`, `questions/recent.yaml`)

```yaml
- id: py-basic-001              # <tech>-<basic|recent>-NNN, unique
  topic: data structures
  difficulty: beginner          # beginner | intermediate | advanced
  question: What is the difference between a list and a tuple?
  answer: |
    Markdown answer. Depth that shows understanding, not a dictionary definition.
  tags: [immutability, hashing]
```

`recent.yaml` entries add:

```yaml
  period: "2024–2026"
  type: representative          # representative | verified-report
```

Never invent company-specific interview reports. `representative` means "a question shaped
like what appears in current interviews", which is honest.

## Scenarios (`scenarios.yaml`)

```yaml
- id: py-scn-001
  title: Debug a memory-growing ingestion job
  technologies: [python, airflow]
  difficulty: advanced
  prompt: |
    Situation the interviewer would describe.
  approach: |
    What a strong answer covers, in order.
  red_flags:
    - Answer that starts with "restart the service".
```

## Quick revision (`quickrev.yaml`)

```yaml
concepts:                       # 12–20 highest-value ideas
  - title: GIL
    detail: One or two sentences.
traps:                          # 5–8 misconceptions
  - Claiming threads speed up CPU-bound work in CPython.
advanced:                       # 5–8 things worth remembering at senior level
  - Generators keep state in the frame; that is why they cannot be pickled.
comparisons:                    # 5–8 head-to-heads
  - a: list
    b: tuple
    difference: Mutable vs immutable; tuples are hashable and cheaper.
commands:                       # 5–10 commands/snippets worth memorising
  - label: Run tests quietly
    code: pytest -q
```

## Validation

`python -m backend.app.content` validates every technology folder: required keys, unique
question ids, chapter files exist, relations point at known slugs. Startup refuses to index an
invalid folder and reports the exact path.
