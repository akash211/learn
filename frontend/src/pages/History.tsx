import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type InterviewDetail, type InterviewSummary } from "../api";
import { Badge, Button, Card, Empty, Markdown, SectionTitle, Spinner } from "../components/ui";

export default function History() {
  const [params, setParams] = useSearchParams();
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [sessions, setSessions] = useState<{ id: number; title: string; tech: string | null; updatedAt: string }[]>([]);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [chat, setChat] = useState<{ title: string; messages: { role: string; content: string }[] } | null>(null);

  const interviewId = params.get("interview");

  useEffect(() => {
    api.interviewHistory().then(setInterviews).catch(() => undefined);
    api.aiSessions().then(setSessions).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!interviewId) {
      setDetail(null);
      return;
    }
    api.interviewDetail(Number(interviewId)).then(setDetail).catch(() => setDetail(null));
  }, [interviewId]);

  const openSession = async (id: number) => {
    const s = await api.aiSession(id);
    setChat({ title: s.title, messages: s.messages });
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="mt-1 text-sm text-muted">Interview reports and AI discussions, kept so you can compare over time.</p>
      </div>

      {detail && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12px] uppercase tracking-wide text-muted">Interview report</p>
              <h2 className="text-lg font-semibold">{detail.techs.join(" + ")}</h2>
            </div>
            <div className="flex items-center gap-2">
              {detail.score !== null && <Badge tone="accent">{detail.score.toFixed(0)}/100</Badge>}
              <Button variant="ghost" size="sm" onClick={() => setParams({})}>
                Close
              </Button>
            </div>
          </div>
          <div className="mt-4">
            {detail.report ? <Markdown>{detail.report}</Markdown> : <p className="text-sm text-muted">This interview has no report yet.</p>}
          </div>
        </Card>
      )}

      <div>
        <SectionTitle eyebrow={`${interviews.length} sessions`} title="Mock interviews" />
        {interviews.length === 0 ? (
          <Empty title="No interviews recorded" />
        ) : (
          <div className="space-y-2">
            {interviews.map((iv) => (
              <button
                key={iv.id}
                onClick={() => setParams({ interview: String(iv.id) })}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-left hover:border-accent/40"
              >
                <span className="text-[13px]">{iv.techs.join(" + ")}</span>
                <Badge>{iv.difficulty}</Badge>
                <span className="text-[11px] text-muted">{new Date(iv.startedAt).toLocaleDateString()}</span>
                <span className="ml-auto text-[13px] font-medium">
                  {iv.score !== null ? `${iv.score.toFixed(0)}/100` : iv.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle eyebrow={`${sessions.length} threads`} title="AI discussions" />
        {sessions.length === 0 ? (
          <Empty title="No AI discussions yet" hint="Open the AI tutor while reading and ask something." />
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px]">{s.title}</p>
                  <p className="text-[11px] text-muted">
                    {s.tech ?? "general"} · {new Date(s.updatedAt).toLocaleString()}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => openSession(s.id)}>
                  Open
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    await api.deleteAiSession(s.id);
                    setSessions((cur) => cur.filter((x) => x.id !== s.id));
                    setChat(null);
                  }}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {chat && (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-semibold">{chat.title}</h3>
            <Button variant="ghost" size="sm" onClick={() => setChat(null)}>
              Close
            </Button>
          </div>
          <div className="mt-3 space-y-4">
            {chat.messages.map((m, i) => (
              <div key={i}>
                <p className="text-[11px] uppercase tracking-wide text-muted">{m.role}</p>
                {m.role === "user" ? (
                  <p className="mt-1 rounded-lg bg-elevated px-3 py-2 text-[13.5px]">{m.content}</p>
                ) : (
                  <Markdown className="mt-1 text-[14px]">{m.content}</Markdown>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
