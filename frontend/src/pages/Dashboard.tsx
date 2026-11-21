import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Bootstrap, type InterviewSummary, type RevisionData } from "../api";
import { Card, Ring, SectionTitle, Badge, Button, Empty } from "../components/ui";

export default function Dashboard() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [rev, setRev] = useState<RevisionData | null>(null);
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [b, r, i] = await Promise.all([api.bootstrap(), api.revisions(), api.interviewHistory()]);
        setData(b);
        setRev(r);
        setInterviews(i.slice(0, 3));
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to load");
      }
    })();
  }, []);

  if (error) return <Empty title="Could not reach the API" hint={error} />;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const stats = data.stats;
  const pct = stats.total_chapters ? Math.round((100 * stats.chapters_completed) / stats.total_chapters) : 0;
  const cont = stats.continue;
  const contTech = data.techs.find((t) => t.slug === cont?.tech);

  const categories = Object.entries(data.categories);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Personal learning</p>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">
            {stats.techs_total} technologies · {stats.total_chapters} chapters · {stats.interviews_completed} mock
            interview{stats.interviews_completed === 1 ? "" : "s"} completed
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/revision">
            <Button variant="outline">Quick revision</Button>
          </Link>
          <Link to="/interview">
            <Button>Start mock interview</Button>
          </Link>
        </div>
      </div>

      {data.content_errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-amber-500">Some content folders failed to load</p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {data.content_errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">Chapters</p>
              <p className="mt-1 text-2xl font-semibold">
                {stats.chapters_completed}
                <span className="text-base font-normal text-muted"> / {stats.total_chapters}</span>
              </p>
            </div>
            <Ring percent={pct} />
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Due for revision</p>
          <p className="mt-1 text-2xl font-semibold">{rev?.counts.due ?? 0}</p>
          <Link to="/queue" className="mt-1 inline-block text-[13px] text-accent hover:underline">
            Open queue →
          </Link>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Bookmarks</p>
          <p className="mt-1 text-2xl font-semibold">{stats.bookmarks}</p>
          <Link to="/bookmarks" className="mt-1 inline-block text-[13px] text-accent hover:underline">
            Saved items →
          </Link>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Technologies started</p>
          <p className="mt-1 text-2xl font-semibold">
            {stats.techs_started}
            <span className="text-base font-normal text-muted"> / {stats.techs_total}</span>
          </p>
          <Link to="/techs" className="mt-1 inline-block text-[13px] text-accent hover:underline">
            Browse library →
          </Link>
        </Card>
      </div>

      {cont && contTech && (
        <Card className="flex flex-wrap items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-muted">Continue where you left off</p>
            <p className="mt-1 text-[15px] font-medium">{contTech.title}</p>
            <p className="text-[13px] text-muted">
              {cont.chapter ? `Chapter: ${cont.chapter}` : "No chapter opened yet"}
            </p>
          </div>
          <Link to={cont.chapter ? `/tech/${contTech.slug}/chapter/${cont.chapter}` : `/tech/${contTech.slug}`}>
            <Button>Resume</Button>
          </Link>
        </Card>
      )}

      <div>
        <SectionTitle eyebrow="Library" title="Categories" action={<Link to="/techs" className="text-sm text-accent hover:underline">All technologies</Link>} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map(([key, title]) => {
            const items = data.techs.filter((t) => t.category === key);
            if (items.length === 0) return null;
            return (
              <Card key={key} className="p-4">
                <p className="text-[13px] font-medium">{title}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {items.map((t) => (
                    <Link
                      key={t.slug}
                      to={`/tech/${t.slug}`}
                      className="rounded-md border border-line px-2 py-1 text-[12px] text-muted hover:border-accent/40 hover:text-ink"
                    >
                      {t.title}
                    </Link>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle eyebrow="Retention" title="Due today" />
          {rev && rev.due.length > 0 ? (
            <div className="space-y-2">
              {rev.due.slice(0, 5).map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                  <Badge tone="warn">{item.kind}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
                  <Link to="/queue" className="text-xs text-accent">
                    review
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Nothing due" hint="Grade a few questions and the scheduler fills this up." />
          )}
        </div>

        <div>
          <SectionTitle eyebrow="Interviews" title="Recent mock interviews" />
          {interviews.length > 0 ? (
            <div className="space-y-2">
              {interviews.map((iv) => (
                <Link
                  key={iv.id}
                  to={`/history?interview=${iv.id}`}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 hover:border-accent/40"
                >
                  <span className="text-[13px]">{iv.techs.join(" + ")}</span>
                  <span className="ml-auto text-[13px] font-medium">{iv.score ? `${iv.score.toFixed(0)}/100` : iv.status}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="No interviews yet"
              hint="Configure one and get an honest report."
              action={
                <Link to="/interview">
                  <Button size="sm">Start now</Button>
                </Link>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
