import { useState } from "react";
import clsx from "clsx";
import { Markdown, Badge, Button } from "./ui";
import { api, type Question } from "../api";

/**
 * Interview question card: the answer stays hidden until asked for, and the reader can grade
 * themselves, which feeds the spaced-repetition queue.
 */
export function QACard({ question, tech, onGraded }: { question: Question; tech: string; onGraded?: () => void }) {
  const [open, setOpen] = useState(false);
  const [graded, setGraded] = useState<string | null>(null);

  const grade = async (result: "correct" | "partial" | "wrong") => {
    setGraded(result);
    await api.questionResult({ question_id: question.id, tech, result });
    onGraded?.();
  };

  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span className={clsx("mt-0.5 text-xs transition", open ? "rotate-90" : "")}>▸</span>
        <span className="flex-1">
          <span className="block text-[15px] font-medium leading-snug">{question.question}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={question.kind === "recent" ? "accent" : "neutral"}>
              {question.kind === "recent" ? `recent${question.period ? ` · ${question.period}` : ""}` : "foundation"}
            </Badge>
            <Badge>{question.difficulty}</Badge>
            {question.topic && <span className="text-[11px] text-muted">{question.topic}</span>}
            {question.state?.difficult && <Badge tone="warn">marked difficult</Badge>}
          </span>
          {question.kind === "recent" && question.type === "representative" && (
            <span className="mt-1 block text-[11px] text-muted italic">
              representative of current interview patterns, not a verbatim company report
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="fadeup border-t border-line px-4 py-4">
          <Markdown>{question.answer}</Markdown>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="text-xs text-muted">How did that go?</span>
            {(["correct", "partial", "wrong"] as const).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={graded === r ? "primary" : "outline"}
                onClick={() => grade(r)}
              >
                {r === "correct" ? "Got it" : r === "partial" ? "Partly" : "Missed"}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
