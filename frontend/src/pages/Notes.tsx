import { useEffect, useState } from "react";
import { api, type Note } from "../api";
import { Button, Card, Empty, Markdown, SectionTitle } from "../components/ui";
import { NoteEditor } from "../components/SearchPalette";

export default function Notes() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const load = () => api.notes().then(setNotes).catch(() => setNotes([]));

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
        <p className="mt-1 text-sm text-muted">Everything you write here is Markdown and searchable.</p>
      </div>

      <NoteEditor onSaved={load} />

      <div>
        <SectionTitle eyebrow={`${notes.length} notes`} title="All notes" />
        {notes.length === 0 ? (
          <Empty title="No notes yet" hint="The editor above saves straight to SQLite." />
        ) : (
          <div className="space-y-3">
            {notes.map((n) => (
              <Card key={n.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{n.title}</p>
                    <p className="text-[11.5px] text-muted">
                      {n.tech ?? "general"} · {new Date(n.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(editing === n.id ? null : n.id);
                        setDraft(n.body);
                      }}
                    >
                      {editing === n.id ? "Cancel" : "Edit"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        await api.deleteNote(n.id);
                        setNotes((cur) => cur.filter((x) => x.id !== n.id));
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {editing === n.id ? (
                  <div className="mt-3">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={8}
                      className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[13px] outline-none focus:border-accent"
                    />
                    <Button
                      size="sm"
                      className="mt-2"
                      onClick={async () => {
                        await api.updateNote(n.id, { body: draft });
                        setEditing(null);
                        load();
                      }}
                    >
                      Save
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2">
                    <Markdown className="text-[14px]">{n.body}</Markdown>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
