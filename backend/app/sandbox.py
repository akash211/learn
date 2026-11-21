"""Isolated code execution.

Python and Bash run in a throwaway container: no network, no host mounts, read-only root
filesystem, memory/CPU caps and a hard timeout. SQL runs in-process on DuckDB against a
separate playground database, which cannot touch learn.db.
"""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import duckdb

from .config import settings

MAX_OUTPUT = 8000


@dataclass
class ExecResult:
    ok: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int


def docker_available() -> bool:
    return shutil.which("docker") is not None


def _trim(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT] + f"\n… output truncated ({len(text)} bytes)"


async def _run_container(image: str, argv: list[str], code_file: Path, workdir: str) -> ExecResult:
    loop = asyncio.get_running_loop()
    started = loop.time()
    proc = await asyncio.create_subprocess_exec(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--memory",
        settings.sandbox_memory,
        "--cpus",
        settings.sandbox_cpus,
        "--pids-limit",
        "128",
        "--read-only",
        "--tmpfs",
        "/tmp:size=32m",
        "-v",
        f"{code_file}:{workdir}/main:ro",
        "-w",
        workdir,
        image,
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=settings.sandbox_timeout_s + 15)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ExecResult(False, "", f"Execution timed out after {settings.sandbox_timeout_s}s", 124, 0)
    duration = int((loop.time() - started) * 1000)
    return ExecResult(
        ok=proc.returncode == 0,
        stdout=_trim(out.decode("utf-8", "replace")),
        stderr=_trim(err.decode("utf-8", "replace")),
        exit_code=proc.returncode or 0,
        duration_ms=duration,
    )


async def run_python(code: str) -> ExecResult:
    if not docker_available():
        return ExecResult(False, "", "Docker is not available on this host, so code execution is disabled.", 127, 0)
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="learn-py-") as tmp:
        path = Path(tmp) / "snippet.py"
        path.write_text(code, encoding="utf-8")
        path.chmod(0o644)
        return await _run_container(
            settings.sandbox_python_image,
            ["timeout", str(settings.sandbox_timeout_s), "python", "-I", "-u", "/workspace/main"],
            path,
            "/workspace",
        )


async def run_bash(code: str) -> ExecResult:
    if not docker_available():
        return ExecResult(False, "", "Docker is not available on this host, so code execution is disabled.", 127, 0)
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="learn-sh-") as tmp:
        path = Path(tmp) / "script.sh"
        path.write_text(code, encoding="utf-8")
        path.chmod(0o644)
        return await _run_container(
            settings.sandbox_bash_image,
            ["timeout", str(settings.sandbox_timeout_s), "sh", "/workspace/main"],
            path,
            "/workspace",
        )


def _playground_db() -> duckdb.DuckDBPyConnection:
    """Read/write connection to the sandbox database, with demo tables on first use."""
    settings.duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(settings.duckdb_path))
    tables = {row[0] for row in con.execute("SHOW TABLES").fetchall()}
    if "customers" not in tables:
        con.execute(
            """
            CREATE TABLE customers AS SELECT * FROM (VALUES
                (1, 'Acme Corp',  'enterprise', DATE '2023-01-14'),
                (2, 'Globex',     'mid-market', DATE '2023-03-02'),
                (3, 'Initech',    'smb',        DATE '2023-05-21'),
                (4, 'Umbrella',   'enterprise', DATE '2024-02-08'),
                (5, 'Soylent',    'smb',        DATE '2024-07-30')
            ) AS t(customer_id, name, segment, signed_on)
            """
        )
        con.execute(
            """
            CREATE TABLE orders AS SELECT * FROM (VALUES
                (1, 1, DATE '2024-01-05', 1200.00, 'closed'),
                (2, 1, DATE '2024-02-11',  860.50, 'closed'),
                (3, 2, DATE '2024-02-14',  430.00, 'refunded'),
                (4, 3, DATE '2024-03-01',  275.25, 'closed'),
                (5, 2, DATE '2024-03-19', 1980.00, 'closed'),
                (6, 4, DATE '2024-04-02', 3120.75, 'closed'),
                (7, 5, DATE '2024-04-22',  190.00, 'open'),
                (8, 3, DATE '2024-05-09',  540.40, 'closed')
            ) AS t(order_id, customer_id, order_date, amount, status)
            """
        )
    return con


def run_sql(sql: str, limit_rows: int = 200) -> dict:
    """Execute one statement against the DuckDB playground database."""
    con = _playground_db()
    try:
        cur = con.execute(sql)
        if cur.description is None:
            return {"ok": True, "columns": [], "rows": [], "row_count": 0, "message": "Statement executed."}
        columns = [d[0] for d in cur.description]
        rows = cur.fetchmany(limit_rows)
        clean = [[_jsonable(v) for v in row] for row in rows]
        return {"ok": True, "columns": columns, "rows": clean, "row_count": len(clean)}
    except Exception as exc:  # surface the engine error verbatim
        return {"ok": False, "error": str(exc), "columns": [], "rows": [], "row_count": 0}
    finally:
        con.close()


def _jsonable(value):
    if value is None or isinstance(value, (int, float, str, bool)):
        return value
    return str(value)
