import { useEffect, useState } from "react";
import { api, type SearchHit } from "../api";
import { Markdown } from "./ui";
import { useNavigate } from "react-router-dom";

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) {
      setQ("");
      setHits([]);
    }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        setHits(await api.search(q.trim()));
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, 140);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!open) return null;

  const go = (hit: SearchHit) => {
    onClose();
    if (hit.kind === "chapter") navigate(`/tech/${hit.tech}/chapter/${hit.ref}`);
    else if (hit.kind === "question") navigate(`/tech/${hit.tech}?tab=${hit.ref.includes("recent") ? "recent" : "basics"}&q=${hit.ref}`);
    else if (hit.kind === "scenario") navigate(`/tech/${hit.tech}?tab=scenarios&q=${hit.ref}`);
    else navigate(`/tech/${hit.tech}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search technologies, chapters, questions, scenarios…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none"
        />
        <div className="max-h-[55vh] overflow-y-auto">
          {busy && <p className="px-4 py-3 text-sm text-muted">Searching…</p>}
          {!busy && q && hits.length === 0 && <p className="px-4 py-3 text-sm text-muted">Nothing matched.</p>}
          {hits.map((hit) => (
            <button
              key={`${hit.kind}-${hit.tech}-${hit.ref}`}
              onClick={() => go(hit)}
              className="block w-full border-b border-line/60 px-4 py-3 text-left last:border-0 hover:bg-elevated"
            >
              <div className="flex items-center gap-2">
                <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                  {hit.kind}
                </span>
                <span className="text-[13px] text-muted">{hit.techTitle}</span>
              </div>
              <p className="mt-1 text-sm font-medium">{hit.title}</p>
              <div
                className="mt-1 line-clamp-2 text-[12px] text-muted [&_mark]:bg-accentsoft [&_mark]:text-accent"
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
            </button>
          ))}
          {!q && (
            <div className="px-4 py-3">
              <p className="text-xs text-muted">Try “skew join”, “Direct Lake”, “isolation level”, “generator”.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function NoteEditor({
  tech,
  chapter,
  onSaved,
}: {
  tech?: string;
  chapter?: string;
  onSaved?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note title"
        className="w-full border-b border-line bg-transparent pb-2 text-sm font-medium outline-none"
      />
      <div className="mt-2 flex gap-2 text-xs">
        <button className={preview ? "text-muted" : "text-accent"} onClick={() => setPreview(false)}>
          Write
        </button>
        <button className={preview ? "text-accent" : "text-muted"} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="mt-2 min-h-24 rounded-lg border border-line p-3">
          <Markdown>{body || "_Nothing yet_"}</Markdown>
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Markdown supported"
          className="mt-2 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
        />
      )}
      <button
        onClick={async () => {
          if (!body.trim()) return;
          await api.createNote({ title: title || body.slice(0, 50), body, tech, chapter });
          setTitle("");
          setBody("");
          onSaved?.();
        }}
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-canvas"
      >
        Save note
      </button>
    </div>
  );
}
