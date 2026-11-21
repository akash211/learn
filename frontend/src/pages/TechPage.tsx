import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type ChapterMeta, type Question, type Scenario, type TechDetail, type QuickRev } from "../api";
import { Badge, Button, Card, Empty, Markdown, SectionTitle, Spinner } from "../components/ui";
import { QACard } from "../components/QACard";
import { AIDrawer } from "../components/AIDrawer";
import clsx from "clsx";

const TABS = [
  ["intro", "Introduction"],
  ["course", "Crash course"],
  ["basics", "Interview questions"],
  ["recent", "Recent questions"],
  ["scenarios", "Scenarios"],
  ["quickrev", "Quick revision"],
] as const;

type TabKey = (typeof TABS)[number][0];

export default function TechPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey) || "intro";
  const [tech, setTech] = useState<TechDetail | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [quickrev, setQuickrev] = useState<QuickRev | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setTech(null);
    setQuestions([]);
    setScenarios([]);
    setQuickrev(null);
    setError(null);
    (async () => {
      try {
        const detail = await api.tech(slug);
        setTech(detail);
        await api.visit(slug, detail.lastChapter ?? undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to load");
      }
    })();
  }, [slug]);

  useEffect(() => {
    if (!tech) return;
    if ((tab === "basics" || tab === "recent") && questions.length === 0) {
      api.questions(slug, "all").then(setQuestions).catch(() => setQuestions([]));
    }
    if (tab === "scenarios" && scenarios.length === 0) {
      api.scenarios(slug).then(setScenarios).catch(() => setScenarios([]));
    }
    if (tab === "quickrev" && !quickrev) {
      api.quickrev(slug).then(setQuickrev).catch(() => setQuickrev(null));
    }
  }, [tab, tech, slug, questions.length, scenarios.length, quickrev]);

  const shown = useMemo(() => {
    const kind = tab === "recent" ? "recent" : "basic";
    return questions
      .filter((q) => q.kind === kind)
      .filter((q) => !filter || `${q.question} ${q.topic}`.toLowerCase().includes(filter.toLowerCase()));
  }, [questions, tab, filter]);

  if (error) return <Empty title="Technology not found" hint={error} />;
  if (!tech) return <p className="text-sm text-muted">Loading…</p>;

  const completed = tech.chapters.filter((c) => c.completed).length;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/techs" className="text-[13px] text-muted hover:text-ink">
            Technologies
          </Link>
          <span className="text-muted">/</span>
          <span className="text-[13px] text-muted">{tech.categoryTitle}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{tech.title}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{tech.summary}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAiOpen(true)}>
              Ask AI
            </Button>
            <Link to={`/revision/${slug}`}>
              <Button variant="outline">Quick revision</Button>
            </Link>
            <Link
              to={`/tech/${slug}/chapter/${tech.chapters[0]?.id ?? ""}`}
              className={tech.chapters.length ? "" : "pointer-events-none opacity-40"}
            >
              <Button>Start reading</Button>
            </Link>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <span>
            {completed} of {tech.chapters.length} chapters complete
          </span>
          <span>·</span>
          <span>{tech.counts.basic} foundation questions</span>
          <span>·</span>
          <span>{tech.counts.recent} recent-pattern questions</span>
          <span>·</span>
          <span>{tech.counts.scenarios} scenarios</span>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-line pb-px">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setParams({ tab: key })}
            className={clsx(
              "whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition",
              tab === key ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "intro" && <Intro tech={tech} />}

      {tab === "course" && (
        <div className="space-y-3">
          <SectionTitle
            eyebrow={`${tech.chapters.length} chapters`}
            title="Crash course"
            action={<span className="text-[12px] text-muted">{completed} complete</span>}
          />
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {tech.chapters.map((c, i) => (
              <ChapterRow key={c.id} tech={slug} chapter={c} index={i} />
            ))}
          </div>
        </div>
      )}

      {(tab === "basics" || tab === "recent") && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle
              eyebrow={tab === "recent" ? "Last 1–2 years of interview patterns" : "Foundational"}
              title={tab === "recent" ? "Recent interview questions" : "Interview questions"}
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter questions…"
              className="w-52 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>
          {shown.length === 0 ? (
            <Empty title="Nothing here yet" hint="Content for this tab has not been written." />
          ) : (
            <div className="space-y-2">
              {shown.map((q) => (
                <QACard key={q.id} question={q} tech={slug} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "scenarios" && (
        <div className="space-y-3">
          <SectionTitle eyebrow="Practical judgement" title="Engineering scenarios" />
          {scenarios.length === 0 ? (
            <Empty title="No scenarios yet" />
          ) : (
            scenarios.map((s) => <ScenarioCard key={s.id} scenario={s} />)
          )}
        </div>
      )}

      {tab === "quickrev" && (
        <div className="space-y-3">
          <SectionTitle
            eyebrow="10–15 minutes"
            title="Quick revision pack"
            action={
              <Link to={`/revision/${slug}`}>
                <Button size="sm">Open revision mode</Button>
              </Link>
            }
          />
          {!quickrev ? (
            <Spinner />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="p-4">
                <p className="text-[13px] font-semibold">Top concepts</p>
                <ul className="mt-2 space-y-2 text-[13px]">
                  {quickrev.concepts.slice(0, 8).map((c) => (
                    <li key={c.title}>
                      <span className="font-medium">{c.title}</span> — <span className="text-muted">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card className="p-4">
                <p className="text-[13px] font-semibold">Traps and comparisons</p>
                <ul className="mt-2 space-y-2 text-[13px] text-muted">
                  {quickrev.traps.slice(0, 4).map((t) => (
                    <li key={t}>• {t}</li>
                  ))}
                  {quickrev.comparisons.slice(0, 3).map((c) => (
                    <li key={`${c.a}-${c.b}`}>
                      • <span className="text-ink">{c.a} vs {c.b}</span> — {c.difference}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}
        </div>
      )}

      <AIDrawer open={aiOpen} onClose={() => setAiOpen(false)} tech={slug} />
    </div>
  );
}

function ChapterRow({ tech, chapter, index }: { tech: string; chapter: ChapterMeta; index: number }) {
  const [done, setDone] = useState(chapter.completed);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={async () => {
          const next = !done;
          setDone(next);
          await api.setChapter(tech, chapter.id, next);
        }}
        className={clsx(
          "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]",
          done ? "border-accent bg-accent text-canvas" : "border-line text-transparent hover:border-accent",
        )}
        title={done ? "Mark incomplete" : "Mark complete"}
      >
        ✓
      </button>
      <Link to={`/tech/${tech}/chapter/${chapter.id}`} className="min-w-0 flex-1">
        <p className={clsx("truncate text-[14px]", done && "text-muted line-through decoration-line")}>
          <span className="mr-2 text-[12px] text-muted">{String(index + 1).padStart(2, "0")}</span>
          {chapter.title}
        </p>
      </Link>
      <span className="text-[11px] text-muted">{chapter.minutes} min</span>
      {chapter.level === "advanced" && <Badge>advanced</Badge>}
    </div>
  );
}

function Intro({ tech }: { tech: TechDetail }) {
  const i = tech.intro;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
      <div className="space-y-6">
        {i.what && (
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">What it is</h3>
            <Markdown className="mt-2">{i.what}</Markdown>
          </section>
        )}
        {i.why && (
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Why it exists</h3>
            <Markdown className="mt-2">{i.why}</Markdown>
          </section>
        )}
        {!!i.problems?.length && (
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Problems it solves</h3>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {i.problems.map((p) => (
                <li key={p} className="flex gap-2">
                  <span className="text-accent">→</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!i.where_used?.length && (
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Where it is used</h3>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {i.where_used.map((p) => (
                <li key={p} className="flex gap-2">
                  <span className="text-muted">•</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {i.ecosystem && (
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">How it fits</h3>
            <Markdown className="mt-2">{i.ecosystem}</Markdown>
          </section>
        )}
      </div>
      <aside className="space-y-4">
        {!!i.alternatives?.length && (
          <Card className="p-4">
            <p className="text-[13px] font-semibold">Alternatives</p>
            <ul className="mt-2 space-y-2 text-[13px]">
              {i.alternatives.map((a) => (
                <li key={a.name}>
                  <span className="font-medium">{a.name}</span>
                  <span className="block text-muted">{a.note}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {!!tech.relations.length && (
          <Card className="p-4">
            <p className="text-[13px] font-semibold">Related</p>
            <ul className="mt-2 space-y-2 text-[13px]">
              {tech.relations.map((r) => (
                <li key={r.to}>
                  <Link to={`/tech/${r.to}`} className="font-medium text-accent hover:underline">
                    {r.title}
                  </Link>
                  <span className="ml-1 text-[11px] uppercase tracking-wide text-muted">{r.type}</span>
                  {r.note && <span className="block text-muted">{r.note}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </aside>
    </div>
  );
}

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className={clsx("mt-0.5 text-xs transition", open && "rotate-90")}>▸</span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">{scenario.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge>{scenario.difficulty}</Badge>
            {scenario.technologies.map((t) => (
              <span key={t} className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase text-muted">
                {t}
              </span>
            ))}
          </div>
        </div>
      </button>
      {open && (
        <div className="fadeup space-y-3 border-t border-line px-4 py-4">
          <Markdown>{scenario.prompt}</Markdown>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">A strong answer covers</p>
            <Markdown>{scenario.approach}</Markdown>
          </div>
          {scenario.red_flags.length > 0 && (
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Red flags</p>
              <ul className="mt-1 space-y-1 text-[13px] text-muted">
                {scenario.red_flags.map((f) => (
                  <li key={f}>• {f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
