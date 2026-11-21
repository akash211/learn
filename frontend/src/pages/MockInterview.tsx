import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Bootstrap, type InterviewSummary, type NextQuestion } from "../api";
import { Badge, Button, Card, Empty, Markdown, SectionTitle, Spinner } from "../components/ui";
import clsx from "clsx";

type EvalResult = { verdict: string; score: number; feedback: string; followUp: string };

export default function MockInterview() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [history, setHistory] = useState<InterviewSummary[]>([]);
  const [techs, setTechs] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("intermediate");
  const [format, setFormat] = useState("mixed");
  const [count, setCount] = useState(6);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [current, setCurrent] = useState<NextQuestion | null>(null);
  const [total, setTotal] = useState(0);
  const [answer, setAnswer] = useState("");
  const [evaluation, setEvaluation] = useState<EvalResult | null>(null);
  const [hint, setHint] = useState<{ text: string; level: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.bootstrap().then(setData).catch(() => setData(null));
    api.interviewHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [current, evaluation, hint]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.interviewStart({ techs, difficulty, format, questions: count });
      setSessionId(res.session_id);
      setTotal(res.total);
      setCurrent({ ...res, index: 0 });
      setEvaluation(null);
      setReport(null);
      setHint(null);
      setAnswer("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not start");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!sessionId || !answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.interviewAnswer(sessionId, answer);
      setEvaluation(res.evaluation);
      setAnswer("");
      if (res.next) {
        setCurrent({ ...res.next });
        setHint(null);
      } else {
        const detail = await api.interviewDetail(sessionId);
        setReport(detail.report);
        setCurrent(null);
        api.interviewHistory().then(setHistory).catch(() => undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "evaluation failed");
    } finally {
      setBusy(false);
    }
  };

  const askHint = async () => {
    if (!sessionId) return;
    const level = (hint?.level ?? 0) + 1;
    const res = await api.interviewHint(sessionId, Math.min(level, 3));
    setHint({ text: res.hint, level: res.level });
  };

  const skip = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await api.interviewSkip(sessionId);
      if (res.next) {
        setCurrent({ ...res.next });
        setHint(null);
        setEvaluation(null);
      } else {
        const detail = await api.interviewDetail(sessionId);
        setReport(detail.report);
        setCurrent(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const finishEarly = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await api.interviewFinish(sessionId);
      setReport(res.report);
      setCurrent(null);
      api.interviewHistory().then(setHistory).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  // ---------------------------------------------------------------- report view
  if (report) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Interview report</h1>
          <Button
            variant="outline"
            onClick={() => {
              setSessionId(null);
              setReport(null);
              setEvaluation(null);
            }}
          >
            New interview
          </Button>
        </div>
        <Card className="p-6">
          <Markdown>{report}</Markdown>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------- live session
  if (sessionId && current) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[12px] uppercase tracking-wide text-muted">
              Question {(current.index ?? 0) + 1} of {total}
            </p>
            <h1 className="text-lg font-semibold">{current.tech}</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={finishEarly} disabled={busy}>
              End &amp; report
            </Button>
          </div>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${(((current.index ?? 0) + 1) / total) * 100}%` }}
          />
        </div>

        <Card className="p-5">
          <p className="text-[15px] leading-relaxed">{current.question}</p>
        </Card>

        {hint && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px]">
            <span className="font-medium text-amber-500">Hint {hint.level}/3: </span>
            {hint.text}
          </div>
        )}

        {!evaluation ? (
          <>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={7}
              placeholder="Answer as you would in a real interview. Be specific — vague answers are marked down."
              className="w-full resize-y rounded-xl border border-line bg-surface px-4 py-3 text-[14px] outline-none focus:border-accent"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={submit} disabled={busy || !answer.trim()}>
                {busy ? <Spinner /> : "Submit answer"}
              </Button>
              <Button variant="outline" onClick={askHint} disabled={busy || (hint?.level ?? 0) >= 3}>
                {hint ? "Another hint" : "Give me a hint"}
              </Button>
              <Button variant="ghost" onClick={skip} disabled={busy}>
                Skip
              </Button>
              <span className="ml-auto text-[11px] text-muted">
                {answer.trim().split(/\s+/).filter(Boolean).length} words
              </span>
            </div>
          </>
        ) : (
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Badge tone={evaluation.verdict === "correct" ? "good" : evaluation.verdict === "partial" ? "warn" : "neutral"}>
                {evaluation.verdict}
              </Badge>
              <span className="text-[13px] font-medium">{evaluation.score}/10</span>
            </div>
            <Markdown className="mt-2 text-[14px]">{evaluation.feedback}</Markdown>
            {current && (
              <Button className="mt-3" onClick={() => setEvaluation(null)}>
                Next question
              </Button>
            )}
          </Card>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}
        <div ref={bottom} />
      </div>
    );
  }

  // ---------------------------------------------------------------- configuration
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mock interview</h1>
        <p className="mt-1 text-sm text-muted">
          One question at a time, graded honestly, with hints that cost you points.
        </p>
      </div>

      <Card className="space-y-5 p-5">
        <div>
          <p className="mb-2 text-[13px] font-medium">Technologies</p>
          <div className="flex flex-wrap gap-2">
            {data.techs.map((t) => (
              <button
                key={t.slug}
                onClick={() =>
                  setTechs((cur) => (cur.includes(t.slug) ? cur.filter((x) => x !== t.slug) : [...cur, t.slug]))
                }
                className={clsx(
                  "rounded-full border px-3 py-1.5 text-[13px] transition",
                  techs.includes(t.slug)
                    ? "border-accent/60 bg-accentsoft text-accent"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                {t.title}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[12px] uppercase tracking-wide text-muted">Difficulty</span>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {["beginner", "intermediate", "advanced", "expert"].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] uppercase tracking-wide text-muted">Format</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {["mixed", "conceptual", "coding", "scenario", "system_design"].map((f) => (
                <option key={f} value={f}>
                  {f.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] uppercase tracking-wide text-muted">Questions</span>
            <input
              type="number"
              min={1}
              max={15}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={start} disabled={busy || techs.length === 0}>
            {busy ? <Spinner /> : "Start interview"}
          </Button>
          {techs.length === 0 && <span className="text-[12px] text-muted">Select at least one technology</span>}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </Card>

      <div>
        <SectionTitle eyebrow="Progress" title="Past interviews" />
        {history.length === 0 ? (
          <Empty title="No interviews yet" hint="Your first report will appear here." />
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <Link
                key={h.id}
                to={`/history?interview=${h.id}`}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 hover:border-accent/40"
              >
                <span className="text-[13px]">{h.techs.join(" + ")}</span>
                <Badge>{h.difficulty}</Badge>
                <span className="ml-auto text-[13px] font-medium">
                  {h.score !== null ? `${h.score.toFixed(0)}/100` : h.status}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
