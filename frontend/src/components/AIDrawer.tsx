import { useEffect, useRef, useState } from "react";
import { streamPost, api } from "../api";
import { Markdown, Button, Spinner } from "./ui";
import clsx from "clsx";

type Msg = { role: "user" | "assistant"; content: string };

/**
 * Contextual AI panel. Mounted next to the reading view so the model always knows which
 * technology and chapter you are in.
 */
export function AIDrawer({
  open,
  onClose,
  tech,
  chapter,
  seed,
}: {
  open: boolean;
  onClose: () => void;
  tech?: string;
  chapter?: string;
  seed?: string;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState(seed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (seed) setInput(seed);
  }, [seed]);

  // reset conversation when the reader moves to another chapter
  useEffect(() => {
    setMessages([]);
    setSessionId(null);
    setError(null);
  }, [tech, chapter]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message }, { role: "assistant", content: "" }]);
    try {
      await streamPost(
        "/api/ai/chat/stream",
        { session_id: sessionId, tech, chapter, message },
        (delta) =>
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1].content + delta };
            return copy;
          }),
        (meta) => {
          if (typeof meta.session_id === "number") setSessionId(meta.session_id);
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };

  const prompts = [
    "Explain this chapter with a production example.",
    "What would an interviewer push on here?",
    "Compare this with the closest alternative.",
    "Give me a harder follow-up question.",
  ];

  return (
    <aside
      className={clsx(
        "fixed inset-y-0 right-0 z-40 flex w-full max-w-[26rem] flex-col border-l border-line bg-surface shadow-2xl transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <p className="text-sm font-semibold">AI tutor</p>
          <p className="text-[11px] text-muted">
            {chapter ? "chapter context loaded" : tech ? "technology context" : "general"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted">Ask anything about what you are reading.</p>
            {prompts.map((p) => (
              <button
                key={p}
                onClick={() => send(p)}
                className="block w-full rounded-lg border border-line px-3 py-2 text-left text-[13px] text-muted hover:border-accent/40 hover:text-ink"
              >
                {p}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "pl-8" : ""}>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
              {m.role === "user" ? "you" : "tutor"}
            </p>
            {m.role === "user" ? (
              <p className="rounded-lg bg-elevated px-3 py-2 text-sm">{m.content}</p>
            ) : m.content ? (
              <Markdown className="text-[14px]">{m.content}</Markdown>
            ) : (
              <Spinner />
            )}
          </div>
        ))}
        {error && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500">{error}</p>}
        <div ref={bottom} />
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            placeholder="Ask a question… (Enter to send)"
            className="max-h-40 flex-1 resize-none rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {busy ? <Spinner /> : "Send"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Answers stream in. Saved to History so you can reuse them.
        </p>
      </form>
    </aside>
  );
}

/** Inline "improve my answer" widget used on question pages. */
export function ImproveAnswer({ tech, question }: { tech: string; question: string }) {
  const [answer, setAnswer] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setOutput("");
    setError(null);
    try {
      await streamPost("/api/ai/improve", { tech, question, my_answer: answer }, (d) => setOutput((o) => o + d));
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold">Improve my answer</p>
      <p className="mt-1 text-[13px] text-muted">
        Write what you would actually say. You get a verdict, the gaps, and a tighter version.
      </p>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={4}
        placeholder="Your answer…"
        className="mt-3 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={run} disabled={busy || !answer.trim()}>
          {busy ? <Spinner /> : "Evaluate"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await api.createNote({ title: `Saved answer — ${question.slice(0, 60)}`, body: answer, tech, source: "manual" });
            setAnswer("");
          }}
          disabled={!answer.trim()}
        >
          Save as note
        </Button>
      </div>
      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      {output && (
        <div className="mt-4 border-t border-line pt-3">
          <Markdown>{output}</Markdown>
        </div>
      )}
    </div>
  );
}
