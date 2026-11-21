import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Chapter as ChapterData } from "../api";
import { Badge, Button, Markdown, Empty } from "../components/ui";
import { AIDrawer, ImproveAnswer } from "../components/AIDrawer";
import clsx from "clsx";

export default function Chapter() {
  const { slug = "", id = "" } = useParams();
  const [data, setData] = useState<ChapterData | null>(null);
  const [done, setDone] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    (async () => {
      try {
        const d = await api.chapter(slug, id);
        setData(d);
        setDone(d.chapter.completed);
        api.visit(slug, id).catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(JSON.stringify(e)));
      }
    })();
  }, [slug, id]);

  if (error) return <Empty title="Chapter not found" hint={error} />;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const toggle = async () => {
    const next = !done;
    setDone(next);
    await api.setChapter(slug, id, next);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_250px]">
      <article className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <Link to={`/tech/${slug}`} className="hover:text-ink">
            {data.tech.title}
          </Link>
          <span>/</span>
          <span>{data.chapter.minutes} min read</span>
          {data.chapter.level === "advanced" && <Badge>advanced</Badge>}
        </div>

        <Markdown>{data.chapter.body}</Markdown>

        <div className="mt-8 rounded-xl border border-line bg-surface p-4">
          <ImproveAnswer tech={slug} question={`Chapter: ${data.chapter.title}`} />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button variant={done ? "outline" : "primary"} onClick={toggle}>
            {done ? "Completed ✓" : "Mark as complete"}
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await api.addBookmark({ kind: "chapter", tech: slug, ref: id, label: data.chapter.title });
              setBookmarked(true);
            }}
            disabled={bookmarked}
          >
            {bookmarked ? "Bookmarked" : "Bookmark chapter"}
          </Button>
          <div className="ml-auto flex gap-2">
            {data.prev && (
              <Link to={`/tech/${slug}/chapter/${data.prev.id}`}>
                <Button variant="outline" size="sm">
                  ← Previous
                </Button>
              </Link>
            )}
            {data.next && (
              <Link to={`/tech/${slug}/chapter/${data.next.id}`}>
                <Button size="sm">Next →</Button>
              </Link>
            )}
          </div>
        </div>
      </article>

      <aside className="hidden lg:block">
        <div className="sticky top-16 space-y-3">
          <Button variant="outline" className="w-full" onClick={() => setAiOpen(true)}>
            Ask AI about this chapter
          </Button>
          <div className="rounded-xl border border-line bg-surface p-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Navigation</p>
            <div className="mt-2 space-y-1 text-[13px]">
              {data.prev && (
                <Link to={`/tech/${slug}/chapter/${data.prev.id}`} className="block text-muted hover:text-ink">
                  ↑ {data.prev.title}
                </Link>
              )}
              {data.next && (
                <Link to={`/tech/${slug}/chapter/${data.next.id}`} className="block text-muted hover:text-ink">
                  ↓ {data.next.title}
                </Link>
              )}
            </div>
          </div>
        </div>
      </aside>

      <button
        onClick={() => setAiOpen(true)}
        className={clsx(
          "fixed bottom-5 right-5 z-30 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-canvas shadow-lg lg:hidden",
        )}
      >
        Ask AI
      </button>

      <AIDrawer open={aiOpen} onClose={() => setAiOpen(false)} tech={slug} chapter={id} />
    </div>
  );
}
