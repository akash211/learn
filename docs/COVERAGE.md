# Content coverage

54 technologies, grouped. A module is "done" when it has `tech.yaml`, 8–10 chapters, ≥22 basic
questions, ≥10 recent-pattern questions, ≥6 scenarios and a quick-revision pack, and passes
`python -m backend.app.content` plus the independent validator.

## Status

| # | Module | Slug | Category | Status |
|---|---|---|---|---|
| 1 | Python | `python` | programming | done |
| 2 | SQL | `sql` | programming | done |
| 3 | Bash & Shell Scripting | `bash` | programming | batch A |
| 4 | R for Data Analysis | `r` | programming | batch A |
| 5 | Rust | `rust` | programming | batch A |
| 6 | DSA with Python | `dsa-python` | programming | batch A (36 questions, solutions) |
| 7 | Git & GitHub | `git` | version-control-apis | batch A |
| 8 | REST APIs | `rest-apis` | version-control-apis | batch C |
| 9 | CI/CD | `cicd` | cloud-infrastructure | batch A |
| 10 | Linux Server Administration | `linux` | cloud-infrastructure | batch A |
| 11 | Docker | `docker` | cloud-infrastructure | done |
| 12 | Kubernetes | `kubernetes` | cloud-infrastructure | batch C |
| 13 | Ansible | `ansible` | cloud-infrastructure | batch C |
| 14 | Terraform | `terraform` | cloud-infrastructure | batch C |
| 15 | SQLite | `sqlite` | databases | batch A |
| 16 | MongoDB | `mongodb` | databases | batch A |
| 17 | TimescaleDB | `timescaledb` | databases | batch B |
| 18 | SQL Server | `sql-server` | databases | batch A |
| 19 | Azure SQL | `azure-sql` | databases | batch B |
| 20 | Azure Cosmos DB | `cosmos-db` | databases | batch B |
| 21 | Amazon Redshift | `redshift` | databases | batch B |
| 22 | PostgreSQL | `postgresql` | databases | done |
| 23 | MySQL | `mysql` | databases | batch B |
| 24 | DuckDB | `duckdb` | databases | batch B |
| 25 | Snowflake | `snowflake` | data-engineering | batch C |
| 26 | Databricks | `databricks` | data-engineering | batch C |
| 27 | PySpark | `pyspark` | data-engineering | done |
| 28 | Apache Parquet | `parquet` | data-engineering | batch B |
| 29 | Delta Lake | `delta-lake` | data-engineering | batch B |
| 30 | Apache Airflow | `airflow` | data-engineering | done |
| 31 | Microsoft Fabric | `microsoft-fabric` | data-engineering | done |
| 32 | Apache Kafka | `kafka` | data-engineering | batch B |
| 33 | dbt | `dbt` | data-engineering | batch B |
| 34 | LLM Agents | `llm-agents` | ai-llm | batch D |
| 35 | Tool Calling | `tool-calling` | ai-llm | batch D |
| 36 | MCP Servers | `mcp` | ai-llm | batch D |
| 37 | RAG | `rag` | ai-llm | batch D |
| 38 | LangChain | `langchain` | ai-llm | batch D |
| 39 | LangGraph | `langgraph` | ai-llm | batch E |
| 40 | PydanticAI | `pydanticai` | ai-llm | batch E |
| 41 | CrewAI | `crewai` | ai-llm | batch E |
| 42 | FastAPI | `fastapi` | python-ecosystem | batch C |
| 43 | Pytest | `pytest` | python-ecosystem | batch C |
| 44 | Streamlit | `streamlit` | python-ecosystem | batch C |
| 45 | Dash | `dash` | python-ecosystem | batch C |
| 46 | Gradio | `gradio` | python-ecosystem | batch C |
| 47 | Selenium | `selenium` | web-automation | batch D |
| 48 | Playwright | `playwright` | web-automation | batch D |
| 49 | Firecrawl | `firecrawl` | web-automation | batch D |
| 50 | n8n | `n8n` | web-automation | batch D |
| 51 | Tableau | `tableau` | analytics | batch D |
| 52 | Power BI | `power-bi` | analytics | batch D |
| 53 | System Design (Python) | `system-design` | architecture | done — deepening to 10 detailed solutions |
| 54 | (reserve) | — | — | — |

## Batching

Content is authored by parallel subagents against `content/SCHEMA.md`, five batches of ten,
each batch validated (schema, ids, word counts, code fences, answer lengths) and reloaded
before the next starts.

- **A** — bash, r, rust, dsa-python, git, cicd, linux, sqlite, sql-server, mongodb
- **B** — timescaledb, azure-sql, cosmos-db, redshift, mysql, duckdb, parquet, delta-lake, kafka, dbt
- **C** — snowflake, databricks, kubernetes, ansible, terraform, rest-apis, fastapi, pytest, streamlit, dash
- **D** — gradio, selenium, playwright, firecrawl, n8n, tableau, power-bi, llm-agents, tool-calling, mcp
- **E** — rag, langchain, langgraph, pydanticai, crewai + deepening pass on system-design and dsa-python

## Question quality rules

- Basic banks: 22–24 questions per module, answers 100–200 words with code where it helps.
- Recent banks (10–14 per module): labelled `period: 2024–2026`, `type: representative`.
  They follow what current interview loops actually ask; they are never presented as verbatim
  company reports, because nobody can verify those.
- Scenarios: 6 per module, each with a strong-answer outline and red flags.
- Quick revision: 16 concepts, 6 traps, 6 advanced points, 7 comparisons, 8 commands.
- Anything the author could not verify is hedged ("typically", "in Spark 3.5", "preview at time
  of writing") rather than asserted.

## After authoring

1. Prune per feedback — Akash reviews Python first and flags questions to cut or rewrite.
2. Deepen System Design with 10 fully worked solutions and DSA with the full classic set.
3. Add cross-module links (relations) so the technology map is dense, then re-check the map.
