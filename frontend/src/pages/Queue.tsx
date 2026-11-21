import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RevisionData } from "../api";
import { Badge, Button, Card, Empty, SectionTitle } from "../components/ui";

const GRADES = [
  ["correct", "knew it"],
  ["correct_hint", "with effort"],
  ["partial", "shaky"],
  ["wrong", "forgot"],
] as const;

export default function Queue() {
  const [data, setData] = useState<RevisionData | null>(null);

  const load = () => api.revisions().then(setData).catch(() => setData(null));

  useEffect(() => {
    load();
  }, []);

  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const grade = async (id: number, result: string) => {
    await api.gradeRevision(id, result);
    await load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revision queue</h1>
        <p className="mt-1 text-sm text-muted">
          {data.counts.tracked} items tracked · {data.counts.due} due now · {data.counts.upcoming} in the next two weeks
        </p>
      </div>

      <div>
        <SectionTitle eyebrow="Today" title="Due now" />
        {data.due.length === 0 ? (
          <Empty
            title="Queue is clear"
            hint="Grade a question or a quick-revision concept and it lands here on a schedule."
            action={
              <Link to="/revision">
                <Button size="sm">Start a revision</Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-2">
            {data.due.map((item) => (
              <Card key={item.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.lapses > 1 ? "warn" : "accent"}>{item.kind}</Badge>
                  <span className="min-w-0 flex-1 text-[13.5px]">{item.label}</span>
                  <span className="text-[11px] text-muted">
                    every {item.intervalDays}d · ease {item.ease}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {GRADES.map(([value, label]) => (
                    <Button key={value} size="sm" variant="outline" onClick={() => grade(item.id, value)}>
                      {label}
                    </Button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle eyebrow="Schedule" title="Coming up" />
        {data.upcoming.length === 0 ? (
          <p className="text-[13px] text-muted">Nothing scheduled yet.</p>
        ) : (
          <div className="space-y-1.5">
            {data.upcoming.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <span className="text-[11px] text-muted">{new Date(u.dueAt).toLocaleDateString()}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{u.label}</span>
                <span className="text-[11px] text-muted">{u.intervalDays}d</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
