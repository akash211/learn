import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Bootstrap, type QuickRev } from "../api";
import { Button, Card, Empty, Markdown, SectionTitle, Spinner, Badge } from "../components/ui";
import clsx from "clsx";

type Grade = "correct" | "partial" | "correct_hint" | "wrong";

export default function QuickRevision() {
  const { slug } = useParams();
  return slug ? <Session slug={slug} /> : <Picker />;
}

function Picker() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.bootstrap().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const toggle = (s: string) =>
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Quick revision</h1>
        <p className="mt-1 text-sm text-muted">
          A 10–15 minute pass over one technology, or a combined pass across related ones.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {data.techs.map((t) => (
          <button
            key={t.slug}
            onClick={() => toggle(t.slug)}
            className={clsx(
              "rounded-full border px-3 py-1.5 text-[13px] transition",
              selected.includes(t.slug)
                ? "border-accent/60 bg-accentsoft text-accent"
                : "border-line text-muted hover:text-ink",
            )}
          >
            {t.title}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <Button disabled={selected.length === 0} onClick={() => navigate(`/revision/${selected.join(",")}`)}>
          Start session ({selected.length || 0} selected)
        </Button>
        {selected.length > 0 && (
          <Button variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {data.techs.slice(0, 4).map((t) => (
          <Card key={t.slug} className="p-4">
            <p className="text-[14px] font-medium">{t.title}</p>
            <p className="mt-1 text-[12px] text-muted">{t.summary}</p>
            <Link to={`/revision/${t.slug}`} className="mt-2 inline-block text-[13px] text-accent hover:underline">
              Revise {t.title} →
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Session({ slug }: { slug: string }) {
  const slugs = slug.split(",");
  const [packs, setPacks] = useState<QuickRev[] | null>(null);
  const [step, setStep] = useState(0);
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    (async () => {
      const loaded = await Promise.all(slugs.map((s) => api.quickrev(s).catch(() => null)));
      setPacks(loaded.filter(Boolean) as QuickRev[]);
    })();
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const concepts = useMemo(
    () => (packs ?? []).flatMap((p) => p.concepts.map((c) => ({ ...c, tech: p.tech.slug }))),
    [packs],
  );
  const traps = useMemo(() => (packs ?? []).flatMap((p) => p.traps.map((t) => ({ text: t, tech: p.tech.slug }))), [packs]);
  const comparisons = useMemo(
    () => (packs ?? []).flatMap((p) => p.comparisons.map((c) => ({ ...c, tech: p.tech.slug }))),
    [packs],
  );
  const commands = useMemo(() => (packs ?? []).flatMap((p) => p.commands.map((c) => ({ ...c, tech: p.tech.slug }))), [packs]);

  const steps = ["Concepts", "Traps", "Comparisons", "Commands", "Self-assessment"];

  const grade = async (key: string, tech: string, label: string, result: Grade) => {
    setGrades((g) => ({ ...g, [key]: result }));
    await api.gradeItem({ kind: "concept", item_id: key, tech, label, result });
  };

  if (!packs) return <Spinner />;
  if (packs.length === 0) return <Empty title="Nothing to revise" hint="Pick a technology with a quickrev.yaml" />;

  const done = Object.keys(grades).length;
  const total = concepts.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Revision · {packs.map((p) => p.tech.title).join(" + ")}
          </h1>
          <p className="text-[13px] text-muted">
            {total} concepts · {traps.length} traps · {comparisons.length} comparisons · {commands.length} commands
          </p>
        </div>
        <Link to="/revision">
          <Button variant="ghost" size="sm">
            Change selection
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {steps.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            className={clsx(
              "rounded-full border px-3 py-1 text-[12px]",
              step === i ? "border-accent/60 bg-accentsoft text-accent" : "border-line text-muted hover:text-ink",
            )}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-2">
          {concepts.map((c, i) => {
            const key = `${c.tech}-${c.title}`;
            const state = grades[key];
            return (
              <Card key={key} className="p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-[11px] text-muted">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium">{c.title}</p>
                    <p className="mt-0.5 text-[13px] text-muted">{c.detail}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-wide text-muted">{c.tech}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => grade(key, c.tech, c.title, "correct")}
                      className={clsx("rounded px-2 py-1 text-[11px]", state === "correct" ? "bg-emerald-500/15 text-emerald-500" : "text-muted hover:text-ink")}
                    >
                      know it
                    </button>
                    <button
                      onClick={() => grade(key, c.tech, c.title, "partial")}
                      className={clsx("rounded px-2 py-1 text-[11px]", state === "partial" ? "bg-amber-500/15 text-amber-500" : "text-muted hover:text-ink")}
                    >
                      shaky
                    </button>
                    <button
                      onClick={() => grade(key, c.tech, c.title, "wrong")}
                      className={clsx("rounded px-2 py-1 text-[11px]", state === "wrong" ? "bg-red-500/15 text-red-500" : "text-muted hover:text-ink")}
                    >
                      new
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2">
          {traps.map((t) => (
            <Card key={t.text} className="p-3">
              <Badge tone="warn">trap</Badge>
              <p className="mt-1.5 text-[13.5px]">{t.text}</p>
            </Card>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-2">
          {comparisons.map((c) => (
            <Card key={`${c.a}-${c.b}`} className="p-3">
              <p className="text-[13.5px]">
                <span className="font-medium">{c.a}</span> <span className="text-muted">vs</span>{" "}
                <span className="font-medium">{c.b}</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">{c.difference}</p>
            </Card>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-2">
          {commands.map((c) => (
            <Card key={`${c.tech}-${c.label}`} className="p-3">
              <p className="text-[12px] uppercase tracking-wide text-muted">{c.label}</p>
              <pre className="mt-1 overflow-x-auto rounded-md bg-elevated px-3 py-2 font-mono text-[12.5px]">{c.code}</pre>
            </Card>
          ))}
        </div>
      )}

      {step === 4 && (
        <Card className="p-5">
          <SectionTitle eyebrow="Self-assessment" title="Where are you?" />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line p-3">
              <p className="text-2xl font-semibold">{concepts.filter((c) => grades[`${c.tech}-${c.title}`] === "correct").length}</p>
              <p className="text-[12px] text-muted">known</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-2xl font-semibold">{concepts.filter((c) => grades[`${c.tech}-${c.title}`] === "partial").length}</p>
              <p className="text-[12px] text-muted">shaky</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-2xl font-semibold">{concepts.filter((c) => grades[`${c.tech}-${c.title}`] === "wrong").length}</p>
              <p className="text-[12px] text-muted">new to you</p>
            </div>
          </div>
          <p className="mt-3 text-[13px] text-muted">
            {done} of {total} concepts graded — the scheduler uses these to decide what comes back first.
          </p>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => setFinished(true)}>Finish session</Button>
            <Link to="/queue">
              <Button variant="outline">Open revision queue</Button>
            </Link>
          </div>
          {finished && (
            <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-[13px]">
              Session saved. Weak items are queued for tomorrow, strong ones pushed further out.
            </div>
          )}
          <div className="mt-6">
            <p className="text-[12px] uppercase tracking-wide text-muted">Advanced points worth remembering</p>
            <Markdown className="mt-1 text-[13.5px]">
              {(packs ?? []).flatMap((p) => p.advanced.map((a) => `- ${a}`)).join("\n")}
            </Markdown>
          </div>
        </Card>
      )}
    </div>
  );
}
