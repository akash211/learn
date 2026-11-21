# Packaging, Environments and Performance Tuning

Two topics that meet in production: getting the right code with the right dependencies onto a
machine, and making it fast enough once it is there. Both reward doing the boring thing
correctly.

## Environments

A virtual environment is a directory with its own `site-packages` and a `pyvenv.cfg` pointing at
a base interpreter. It isolates dependencies, nothing more — it is not a security boundary and it
does not pin the interpreter patch version.

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

`uv` has become the pragmatic default for local work and CI: `uv venv`, `uv pip install`,
`uv sync`, `uv run pytest`. It resolves and installs an order of magnitude faster than pip in
typical projects and produces a cross-platform lockfile. pip + `requirements.txt` still works and
is still everywhere; the important part is that the lock is committed.

Rules:

- Never install into the system interpreter. Debian and Ubuntu mark it
  `externally-managed-environment` for good reason.
- Pin the interpreter in one place (`.python-version`, `requires-python`, and the Docker base
  image) and keep them consistent. Drift between 3.11 and 3.12 is a real source of "works in CI".
- Rebuild the environment from the lock, not from memory. `pip freeze` on a dirty env records
  whatever happened to be installed last week.

## pyproject.toml

One file, standardised by PEP 621, understood by every modern tool:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "myapp"
version = "0.4.1"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27,<1",
    "pydantic>=2.6,<3",
]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff", "mypy"]

[project.scripts]
myapp = "myapp.cli:main"

[tool.ruff]
line-length = 100

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Notes that save time:

- `dependencies` are *constraints*, not pins. Pin in the lockfile; keep ranges in the manifest.
- `[project.scripts]` generates console entry points. Prefer them over a `__main__.py` shell
  script because they work identically on every OS.
- A `src/` layout (`src/myapp/`) prevents accidentally importing the working directory instead
  of the installed package — a class of bug that only appears in CI.
- Build backends: `hatchling` and `setuptools` are the safe choices; `poetry-core` if you use
  Poetry; `flit-core` for pure-Python single packages.
- `python -m build` produces an sdist and a wheel; `twine check dist/*` validates the metadata.

Wheels matter. A pure-Python package installs anywhere; anything with C extensions needs a wheel
per platform, or the installer compiles from source and needs a toolchain. That is why
`pandas==2.2.2` installs in seconds from a manylinux wheel and minutes from an sdist — and why
pinning a version with no wheel for your platform turns a deploy into a build incident.

## Dependency hygiene

- Pin application dependencies exactly (lockfile), and libraries with ranges.
- Keep `dev` extras out of the runtime image; they pull in compilers and test frameworks.
- Audit for duplicate major versions of the same library — two `pydantic` majors in one
  environment produce bizarre `isinstance` failures.
- For security, `pip-audit` (or `uv pip audit`) in CI against the lock.
- A private index needs `--index-url` plus `--extra-index-url` ordering awareness; supply-chain
  attacks exploit dependency confusion, so scope internal packages to an explicit index.

## Performance tuning: order of operations

1. **Measure.** Define the metric (p95 latency, wall time, memory) and get a baseline. No
   optimisation without a number.
2. **Fix the algorithm.** O(n²) → O(n log n) beats every micro-optimisation. Most "Python is
   slow" reports are a nested loop doing membership tests.
3. **Reduce work.** Cache, batch, avoid recomputation, stream instead of materialising.
4. **Move work to C.** Vectorised NumPy/pandas, `re` compiled patterns, `str.join`,
   `json` in C, `orjson`, `msgpack`.
5. **Parallelise.** Threads for I/O, processes for CPU (see the concurrency chapter).
6. **Micro-optimise** only inside a measured hot loop.

## What actually helps in hot Python

```python
# 1. Local binding in a tight loop
append = out.append
for row in rows:
    append(transform(row))

# 2. str.join, never += in a loop over unknown length
text = "".join(parts)

# 3. Compiled regex, not re.match in a loop
PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
if PATTERN.match(value): ...

# 4. Dict/set membership instead of list scans
allowed = {"a", "b", "c"}

# 5. Batch I/O: executemany, bulk inserts, one request instead of N
cursor.executemany("INSERT INTO t VALUES (%s, %s)", rows)

# 6. Generators to avoid materialising intermediate lists
total = sum(r.amount for r in rows if r.active)
```

What does not help: `for` → `while` rewrites, `map`/`filter` vs comprehensions (within noise),
sprinkling `try/except` for speed, or `gc.disable()` without measurement. List comprehensions
are faster than `append` loops because the loop runs in C — that is the one idiom-level win
worth defaulting to.

String concatenation deserves a note: CPython has an in-place optimisation for `s += x` when
the refcount is 1, so some loops appear linear. Do not rely on it — it is fragile and fails
inside functions holding other references, at which point the loop becomes O(n²).

## Vectorisation and when to leave Python

If a numeric loop over 10 million rows is the bottleneck, the answer is usually NumPy, not
tuning. Rewrite the loop as array operations and expect one to two orders of magnitude. If the
logic is branchy and cannot vectorise, options in increasing cost:

| Option | Gain | Cost |
|---|---|---|
| NumPy/pandas vectorisation | Often 10–100x | Rewrite as array ops; memory |
| `array`/`memoryview` | 2–5x on numeric | Manual loops still Python |
| `functools.cache` on pure functions | Depends on hit rate | Memory; invalidation |
| Cython / mypyc | 2–10x | Build step, typing discipline |
| Numba `@njit` | 10–100x on numeric loops | Compile time, limited Python support |
| Rust via PyO3 / C extension | 10–100x | Engineering cost, distribution |

Only the first two are worth reaching for on a normal schedule. Everything below the line is a
project, justified by a profile and a business constraint.

## Startup time

CLI tools and Lambda functions care about import time, not throughput.

```bash
python -X importtime -c "import myapp"     # per-module import cost
python -X importtime -m myapp --help 2>&1 | sort -k2 -n | tail -20
```

Common fixes: defer heavy imports into functions (`pandas`, `boto3`, `torch`), avoid importing a
package's top-level `__init__` that pulls everything, and use lazy module attributes
(`__getattr__` in a module, PEP 562). Lambda cold starts are dominated by import time plus
interpreter startup; a 200 MB layer is a design decision with a latency cost.

## Common mistakes

- Committing `requirements.txt` without pins, then wondering why CI resolved differently.
- Installing with `sudo pip` and shadowing the system interpreter.
- Building an sdist in Docker on every deploy because no wheel exists for the platform.
- Optimising the 5% that shows up in a profile but is not on the critical path.
- Adding a C-extension dependency for a 2x win in code that runs once per request.
- Assuming `sys.getsizeof` measures a container's contents.

## Production notes

Reproducible builds come from three things: a pinned interpreter, a committed lockfile, and a
build that installs only from the lock. Everything else is a preference.

For performance work, keep a benchmark script in the repo (`pytest-benchmark` or a plain
`timeit` harness) so a regression is caught by CI rather than by a customer. And record the
baseline in the commit message — "3.1 s → 0.4 s on the 1M-row fixture" is a reviewable claim;
"faster" is not.
