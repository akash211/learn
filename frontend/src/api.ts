/** Typed API client. Everything the UI needs goes through here. */

export type TechCard = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  categoryTitle?: string;
  level: string;
  chapters: number;
  questions: number;
  scenarios: number;
};

export type Bootstrap = {
  app: string;
  categories: Record<string, string>;
  techs: TechCard[];
  stats: {
    total_chapters: number;
    chapters_completed: number;
    techs_started: number;
    techs_total: number;
    bookmarks: number;
    due_revisions: number;
    interviews_completed: number;
    continue: { tech: string | null; chapter: string | null } | null;
  };
  content_errors: string[];
};

export type ChapterMeta = { id: string; title: string; minutes: number; level: string; completed: boolean };

export type TechDetail = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  categoryTitle: string;
  level: string;
  intro: {
    what?: string;
    why?: string;
    problems?: string[];
    where_used?: string[];
    ecosystem?: string;
    alternatives?: { name: string; note: string }[];
    related?: string[];
  };
  relations: { to: string; type: string; note: string; title: string }[];
  chapters: ChapterMeta[];
  lastChapter: string | null;
  counts: { basic: number; recent: number; scenarios: number; quickrev: number };
};

export type Chapter = {
  tech: { slug: string; title: string };
  chapter: { id: string; title: string; minutes: number; level: string; body: string; completed: boolean };
  prev: { id: string; title: string } | null;
  next: { id: string; title: string } | null;
};

export type Question = {
  id: string;
  kind: "basic" | "recent";
  topic: string;
  difficulty: string;
  question: string;
  answer: string;
  tags: string[];
  period?: string | null;
  type?: string | null;
  state?: { seen: number; correct: number; wrong: number; difficult: boolean } | null;
};

export type Scenario = {
  id: string;
  title: string;
  difficulty: string;
  technologies: string[];
  prompt: string;
  approach: string;
  red_flags: string[];
};

export type QuickRev = {
  tech: { slug: string; title: string };
  concepts: { title: string; detail: string }[];
  traps: string[];
  advanced: string[];
  comparisons: { a: string; b: string; difference: string }[];
  commands: { label: string; code: string }[];
};

export type SearchHit = {
  kind: string;
  tech: string;
  techTitle: string;
  ref: string;
  title: string;
  snippet: string;
};

export type Bookmark = {
  id: number;
  kind: string;
  tech: string;
  techTitle: string;
  ref: string;
  label: string;
  note: string | null;
  createdAt: string;
};

export type Note = {
  id: number;
  title: string;
  body: string;
  tech: string | null;
  chapter: string | null;
  ref: string | null;
  source: string;
  updatedAt: string;
};

export type RevisionData = {
  due: {
    id: number;
    kind: string;
    itemId: string;
    tech: string;
    label: string;
    intervalDays: number;
    ease: number;
    lapses: number;
  }[];
  upcoming: { id: number; label: string; tech: string; dueAt: string; intervalDays: number }[];
  counts: { due: number; upcoming: number; tracked: number };
};

export type InterviewSummary = {
  id: number;
  techs: string[];
  difficulty: string;
  format: string;
  total: number;
  status: string;
  score: number | null;
  startedAt: string;
};

export type InterviewTurn = {
  id: number;
  idx: number;
  tech: string;
  question: string;
  answer: string | null;
  feedback: string | null;
  score: number | null;
  hintsUsed: number;
  skipped: boolean;
};

export type InterviewDetail = InterviewSummary & {
  report: string | null;
  turns: InterviewTurn[];
};

export type NextQuestion = {
  turn_id: number;
  index: number;
  tech: string;
  topic?: string;
  question: string;
  hints: string[];
};

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function ensure<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  bootstrap: () => fetch("/api/bootstrap").then((r) => ensure<Bootstrap>(r)),
  techs: () => fetch("/api/techs").then((r) => ensure<TechCard[]>(r)),
  tech: (slug: string) => fetch(`/api/tech/${slug}`).then((r) => ensure<TechDetail>(r)),
  chapter: (slug: string, id: string) => fetch(`/api/tech/${slug}/chapter/${id}`).then((r) => ensure<Chapter>(r)),
  questions: (slug: string, kind: string) =>
    fetch(`/api/tech/${slug}/questions?kind=${kind}`).then((r) => ensure<Question[]>(r)),
  scenarios: (slug: string) => fetch(`/api/tech/${slug}/scenarios`).then((r) => ensure<Scenario[]>(r)),
  quickrev: (slug: string) => fetch(`/api/tech/${slug}/quickrev`).then((r) => ensure<QuickRev>(r)),
  graph: () => fetch("/api/graph").then((r) => ensure<{ nodes: unknown[]; links: unknown[] }>(r)),
  search: (q: string) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => ensure<SearchHit[]>(r)),

  setChapter: (tech: string, chapter: string, completed: boolean) =>
    fetch("/api/progress/chapter", { method: "POST", ...json({ tech, chapter, completed }) }).then((r) =>
      ensure<{ completed: boolean }>(r),
    ),
  visit: (tech: string, chapter?: string) =>
    fetch("/api/progress/visit", { method: "POST", ...json({ tech, chapter }) }).then((r) => ensure<unknown>(r)),
  progress: () =>
    fetch("/api/progress").then((r) =>
      ensure<{ techs: { slug: string; title: string; completed: number; total: number; percent: number }[] }>(r),
    ),

  bookmarks: () => fetch("/api/bookmarks").then((r) => ensure<Bookmark[]>(r)),
  addBookmark: (body: { kind: string; tech: string; ref: string; label: string; note?: string }) =>
    fetch("/api/bookmarks", { method: "POST", ...json(body) }).then((r) => ensure<{ id: number }>(r)),
  removeBookmark: (id: number) => fetch(`/api/bookmarks/${id}`, { method: "DELETE" }).then((r) => ensure<unknown>(r)),

  notes: () => fetch("/api/notes").then((r) => ensure<Note[]>(r)),
  createNote: (body: { title: string; body: string; tech?: string; chapter?: string; ref?: string; source?: string }) =>
    fetch("/api/notes", { method: "POST", ...json(body) }).then((r) => ensure<{ id: number }>(r)),
  updateNote: (id: number, body: { title?: string; body?: string }) =>
    fetch(`/api/notes/${id}`, { method: "PATCH", ...json(body) }).then((r) => ensure<unknown>(r)),
  deleteNote: (id: number) => fetch(`/api/notes/${id}`, { method: "DELETE" }).then((r) => ensure<unknown>(r)),

  questionResult: (body: { question_id: string; tech: string; result: string; difficult?: boolean }) =>
    fetch("/api/questions/result", { method: "POST", ...json(body) }).then((r) => ensure<unknown>(r)),
  difficultQuestions: () => fetch("/api/questions/difficult").then((r) => ensure<SearchHit[]>(r)),

  revisions: () => fetch("/api/revisions").then((r) => ensure<RevisionData>(r)),
  gradeRevision: (id: number, result: string) =>
    fetch(`/api/revisions/${id}/grade`, { method: "POST", ...json({ result }) }).then((r) => ensure<unknown>(r)),
  gradeItem: (body: { kind: string; item_id: string; tech: string; label: string; result: string }) =>
    fetch("/api/revisions/grade-item", { method: "POST", ...json(body) }).then((r) =>
      ensure<{ id: number; intervalDays: number }>(r),
    ),

  aiStatus: () => fetch("/api/ai/status").then((r) => ensure<{ configured: boolean; model: string }>(r)),
  aiSessions: () =>
    fetch("/api/ai/sessions").then((r) =>
      ensure<{ id: number; title: string; tech: string | null; updatedAt: string }[]>(r),
    ),
  aiSession: (id: number) =>
    fetch(`/api/ai/sessions/${id}`).then((r) =>
      ensure<{ id: number; title: string; messages: { role: string; content: string }[] }>(r),
    ),
  deleteAiSession: (id: number) => fetch(`/api/ai/sessions/${id}`, { method: "DELETE" }).then((r) => ensure<unknown>(r)),

  interviewStart: (body: { techs: string[]; difficulty: string; format: string; questions: number }) =>
    fetch("/api/interview/start", { method: "POST", ...json(body) }).then((r) =>
      ensure<{ session_id: number; total: number; index: number; turn_id: number; tech: string; question: string; hints: string[] }>(r),
    ),
  interviewAnswer: (id: number, answer: string) =>
    fetch(`/api/interview/${id}/answer`, { method: "POST", ...json({ answer }) }).then((r) =>
      ensure<{ evaluation: { verdict: string; score: number; feedback: string; followUp: string }; next: NextQuestion | null; finished: boolean }>(r),
    ),
  interviewHint: (id: number, level: number) =>
    fetch(`/api/interview/${id}/hint`, { method: "POST", ...json({ level }) }).then((r) =>
      ensure<{ hint: string; level: number; of: number }>(r),
    ),
  interviewSkip: (id: number) =>
    fetch(`/api/interview/${id}/skip`, { method: "POST" }).then((r) =>
      ensure<{ next: NextQuestion | null; finished: boolean }>(r),
    ),
  interviewFinish: (id: number) =>
    fetch(`/api/interview/${id}/finish`, { method: "POST" }).then((r) =>
      ensure<{ score: number; report: string }>(r),
    ),
  interviewHistory: () => fetch("/api/interview").then((r) => ensure<InterviewSummary[]>(r)),
  interviewDetail: (id: number) => fetch(`/api/interview/${id}`).then((r) => ensure<InterviewDetail>(r)),

  playgroundDatasets: () =>
    fetch("/api/playground/datasets").then((r) => ensure<{ tables: { name: string; columns: string[]; rows: number }[] }>(r)),
  runPython: (code: string) =>
    fetch("/api/playground/python", { method: "POST", ...json({ code }) }).then((r) =>
      ensure<{ ok: boolean; stdout: string; stderr: string; durationMs: number }>(r),
    ),
  runBash: (code: string) =>
    fetch("/api/playground/bash", { method: "POST", ...json({ code }) }).then((r) =>
      ensure<{ ok: boolean; stdout: string; stderr: string; durationMs: number }>(r),
    ),
  runSql: (sql: string) =>
    fetch("/api/playground/sql", { method: "POST", ...json({ sql }) }).then((r) =>
      ensure<{ ok: boolean; columns: string[]; rows: unknown[][]; row_count: number; error?: string; message?: string }>(r),
    ),
};

/** Stream server-sent events from a POST endpoint. */
export async function streamPost(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  onMeta?: (data: Record<string, unknown>) => void,
): Promise<void> {
  const res = await fetch(path, { method: "POST", ...json(body) });
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const data = JSON.parse(payload);
        if (data.error) throw new Error(data.error);
        if (data.delta) onDelta(data.delta as string);
        else if (onMeta) onMeta(data);
      } catch (err) {
        if (err instanceof Error && err.message && !err.message.startsWith("Unexpected")) throw err;
      }
    }
  }
}
