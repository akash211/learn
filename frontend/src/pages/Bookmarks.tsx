import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Bookmark } from "../api";
import { Badge, Button, Card, Empty, SectionTitle } from "../components/ui";

export default function Bookmarks() {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [difficult, setDifficult] = useState<{ id: string; tech: string; techTitle: string; question: string; wrong: number }[]>([]);

  const load = async () => {
    setItems(await api.bookmarks());
    setDifficult((await api.difficultQuestions()) as never);
  };

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bookmarks</h1>
        <p className="mt-1 text-sm text-muted">Chapters, questions and scenarios you flagged for a second pass.</p>
      </div>

      <div>
        <SectionTitle eyebrow={`${items.length} saved`} title="Saved items" />
        {items.length === 0 ? (
          <Empty title="Nothing bookmarked yet" hint="Use the bookmark control on a chapter or question." />
        ) : (
          <div className="space-y-2">
            {items.map((b) => (
              <Card key={b.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge>{b.kind}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px]">{b.label || b.ref}</p>
                  <p className="text-[11.5px] text-muted">{b.techTitle}</p>
                </div>
                <Link
                  to={b.kind === "chapter" ? `/tech/${b.tech}/chapter/${b.ref}` : `/tech/${b.tech}`}
                  className="text-[13px] text-accent hover:underline"
                >
                  Open
                </Link>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    await api.removeBookmark(b.id);
                    setItems((cur) => cur.filter((x) => x.id !== b.id));
                  }}
                >
                  Remove
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle eyebrow="Weak spots" title="Questions marked difficult" />
        {difficult.length === 0 ? (
          <Empty title="No difficult questions flagged" hint="Grade yourself on a question to flag it." />
        ) : (
          <div className="space-y-2">
            {difficult.map((d) => (
              <Card key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                <Badge tone="warn">{d.wrong}x missed</Badge>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{d.question}</span>
                <Link to={`/tech/${d.tech}?tab=basics&q=${d.id}`} className="text-[13px] text-accent hover:underline">
                  {d.techTitle}
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
