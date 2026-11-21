import { useEffect, useState } from "react";
import { api, type Bootstrap } from "../api";
import { Badge, Button, Card, SectionTitle, Spinner } from "../components/ui";

export default function Settings() {
  const [status, setStatus] = useState<{ configured: boolean; model: string } | null>(null);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadResult, setReloadResult] = useState<string | null>(null);

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => undefined);
    api.bootstrap().then(setData).catch(() => undefined);
  }, []);

  const reload = async () => {
    setReloading(true);
    try {
      const res = await fetch("/api/content/reload", { method: "POST" }).then((r) => r.json());
      setReloadResult(`${res.techs} technologies re-indexed, ${res.search_rows} search rows${res.errors?.length ? `, ${res.errors.length} errors` : ""}`);
      api.bootstrap().then(setData).catch(() => undefined);
    } catch (e) {
      setReloadResult(e instanceof Error ? e.message : "reload failed");
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Runtime configuration. Secrets live in .env on the server, never here.</p>
      </div>

      <Card className="space-y-3 p-5">
        <SectionTitle eyebrow="Model provider" title="AI" />
        {!status ? (
          <Spinner />
        ) : (
          <div className="space-y-2 text-[13.5px]">
            <div className="flex items-center gap-2">
              <Badge tone={status.configured ? "good" : "warn"}>{status.configured ? "configured" : "not configured"}</Badge>
              <span className="text-muted">chat model: {status.model}</span>
            </div>
            <p className="text-muted">
              Any OpenAI-compatible endpoint works. Set <code className="rounded bg-elevated px-1">AI_BASE_URL</code>,{" "}
              <code className="rounded bg-elevated px-1">AI_API_KEY</code> and the per-task model names in{" "}
              <code className="rounded bg-elevated px-1">.env</code>, then restart the service.
            </p>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <SectionTitle eyebrow="Library" title="Content" />
        <p className="text-[13.5px] text-muted">
          Content is read from <code className="rounded bg-elevated px-1">content/tech/</code>. Add a folder, reload, and
          it appears — no code changes.
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={reload} disabled={reloading}>
            {reloading ? <Spinner /> : "Reload content & rebuild search"}
          </Button>
          {reloadResult && <span className="text-[12px] text-muted">{reloadResult}</span>}
        </div>
        {data && (
          <div className="text-[13px] text-muted">
            {data.techs.length} technologies loaded · {data.stats.total_chapters} chapters ·{" "}
            {data.techs.reduce((n, t) => n + t.questions, 0)} questions
            {data.content_errors.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-amber-500">
                {data.content_errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card className="space-y-2 p-5">
        <SectionTitle eyebrow="This machine" title="Runtime" />
        <ul className="space-y-1 text-[13px] text-muted">
          <li>Backend: FastAPI on :8099 · SQLite in <code className="rounded bg-elevated px-1">data/learn.db</code></li>
          <li>Sandbox: Docker, no network, 256 MB / 0.5 CPU / 10 s per run</li>
          <li>Frontend: React + Vite, built into <code className="rounded bg-elevated px-1">frontend/dist</code></li>
          <li>Access: Tailscale only — reverse proxy and Cloudflare are managed outside the app</li>
        </ul>
      </Card>
    </div>
  );
}
