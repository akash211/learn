import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Card, Spinner, Badge } from "../components/ui";
import clsx from "clsx";

type Mode = "python" | "sql" | "bash";

const SAMPLES: Record<Mode, string> = {
  python: `# Sandboxed: no network, 256 MB RAM, 10s timeout.
from collections import Counter

words = "the quick brown fox jumps over the lazy dog the fox".split()
counts = Counter(words)
print(counts.most_common(3))

# generators keep memory flat on large inputs
def squares(n):
    for i in range(n):
        yield i * i

print(sum(squares(1_000_000)))`,
  sql: `-- DuckDB playground. Tables: customers, orders
SELECT c.segment, COUNT(*) AS orders, ROUND(SUM(o.amount), 2) AS revenue
FROM orders o
JOIN customers c USING (customer_id)
WHERE o.status = 'closed'
GROUP BY c.segment
ORDER BY revenue DESC;`,
  bash: `# Sandboxed alpine container, no network, read-only root.
echo "kernel: $(uname -m)"
for i in 1 2 3; do
  echo "iteration $i"
done
df -h /tmp | tail -1`,
};

export default function Playground() {
  const [mode, setMode] = useState<Mode>("python");
  const [code, setCode] = useState(SAMPLES.python);
  const [output, setOutput] = useState<string>("");
  const [table, setTable] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<{ name: string; columns: string[]; rows: number }[]>([]);

  useEffect(() => {
    if (mode === "sql") api.playgroundDatasets().then((d) => setDatasets(d.tables)).catch(() => undefined);
  }, [mode]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setCode(SAMPLES[m]);
    setOutput("");
    setTable(null);
    setMeta(null);
  };

  const run = async () => {
    setBusy(true);
    setOutput("");
    setTable(null);
    const started = performance.now();
    try {
      if (mode === "sql") {
        const res = await api.runSql(code);
        if (res.ok) {
          setTable({ columns: res.columns, rows: res.rows });
          setMeta(`${res.row_count} rows · ${(performance.now() - started).toFixed(0)} ms`);
        } else {
          setOutput(res.error ?? "query failed");
          setMeta("error");
        }
      } else {
        const res = mode === "python" ? await api.runPython(code) : await api.runBash(code);
        setOutput([res.stdout, res.stderr].filter(Boolean).join("\n") || "(no output)");
        setMeta(`${res.ok ? "ok" : "exit"} · ${res.durationMs} ms`);
      }
    } catch (e) {
      setOutput(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="mt-1 text-sm text-muted">
          Python and Bash run in throwaway containers with no network. SQL runs on DuckDB.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {(["python", "sql", "bash"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={clsx(
              "rounded-full border px-3 py-1.5 text-[13px] capitalize",
              mode === m ? "border-accent/60 bg-accentsoft text-accent" : "border-line text-muted hover:text-ink",
            )}
          >
            {m}
          </button>
        ))}
        {mode === "sql" && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {datasets.map((d) => (
              <span key={d.name} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted">
                {d.name}({d.columns.join(", ")})
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[12px] uppercase tracking-wide text-muted">{mode}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCode("")}>
                Clear
              </Button>
              <Button size="sm" onClick={run} disabled={busy || !code.trim()}>
                {busy ? <Spinner /> : "Run"}
              </Button>
            </div>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            spellCheck={false}
            rows={18}
            className="w-full resize-y bg-canvas px-3 py-2 font-mono text-[13px] leading-relaxed outline-none"
          />
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[12px] uppercase tracking-wide text-muted">Output</span>
            {meta && <span className="text-[11px] text-muted">{meta}</span>}
          </div>
          <div className="max-h-[28rem] overflow-auto p-3">
            {table ? (
              table.columns.length === 0 ? (
                <p className="text-[13px] text-muted">Statement executed.</p>
              ) : (
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      {table.columns.map((c) => (
                        <th key={c} className="border border-line bg-elevated px-2 py-1 text-left font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j} className="border border-line px-2 py-1">
                            {cell === null ? <span className="text-muted">NULL</span> : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : output ? (
              <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed">{output}</pre>
            ) : (
              <p className="text-[13px] text-muted">Run something — ⌘↵ works too.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <Badge tone="accent">isolation</Badge>
        <span>no network</span>
        <span>·</span>
        <span>256 MB / 0.5 CPU</span>
        <span>·</span>
        <span>10s timeout</span>
        <span>·</span>
        <span>read-only root, tmpfs /tmp</span>
      </div>
    </div>
  );
}
