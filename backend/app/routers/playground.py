"""Code execution endpoints (isolated)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .. import sandbox

router = APIRouter(prefix="/api/playground", tags=["playground"])


class CodeIn(BaseModel):
    code: str


@router.get("/datasets")
def datasets() -> dict:
    con = sandbox._playground_db()
    try:
        tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
        out = []
        for table in tables:
            cols = con.execute(f"DESCRIBE {table}").fetchall()
            count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            out.append({"name": table, "columns": [c[0] for c in cols], "rows": count})
        return {"tables": out}
    finally:
        con.close()


@router.post("/python")
async def run_python(body: CodeIn) -> dict:
    result = await sandbox.run_python(body.code)
    return {
        "ok": result.ok,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        "durationMs": result.duration_ms,
    }


@router.post("/bash")
async def run_bash(body: CodeIn) -> dict:
    result = await sandbox.run_bash(body.code)
    return {
        "ok": result.ok,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
        "durationMs": result.duration_ms,
    }


class SqlIn(BaseModel):
    sql: str


@router.post("/sql")
def run_sql(body: SqlIn) -> dict:
    return sandbox.run_sql(body.sql)
