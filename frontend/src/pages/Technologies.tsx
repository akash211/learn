import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Bootstrap } from "../api";
import { Card, Badge, Empty } from "../components/ui";

export default function Technologies() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("all");

  useEffect(() => {
    api.bootstrap().then(setData).catch(() => setData(null));
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.techs.filter((t) => {
      const matchesQ = !q || `${t.title} ${t.summary}`.toLowerCase().includes(q.toLowerCase());
      const matchesCat = category === "all" || t.category === category;
      return matchesQ && matchesCat;
    });
  }, [data, q, category]);

  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Technologies</h1>
        <p className="mt-1 text-sm text-muted">
          {data.techs.length} modules · each with a crash course, interview questions and scenarios
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-56 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          onClick={() => setCategory("all")}
          className={`rounded-full border px-3 py-1 text-[12px] ${category === "all" ? "border-accent/50 text-accent" : "border-line text-muted hover:text-ink"}`}
        >
          All
        </button>
        {Object.entries(data.categories).map(([key, title]) => {
          const count = data.techs.filter((t) => t.category === key).length;
          if (!count) return null;
          return (
            <button
              key={key}
              onClick={() => setCategory(key)}
              className={`rounded-full border px-3 py-1 text-[12px] ${category === key ? "border-accent/50 text-accent" : "border-line text-muted hover:text-ink"}`}
            >
              {title}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <Empty title="No technologies match" hint="Clear the filter to see the full library." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((t) => (
            <Link key={t.slug} to={`/tech/${t.slug}`}>
              <Card className="h-full p-4 transition hover:border-accent/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-medium">{t.title}</p>
                    <p className="mt-1 line-clamp-2 text-[13px] text-muted">{t.summary}</p>
                  </div>
                  <Badge tone={t.level === "core" ? "accent" : "neutral"}>{t.level}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
                  <span>{t.chapters} chapters</span>
                  <span>{t.questions} questions</span>
                  <span>{t.scenarios} scenarios</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
