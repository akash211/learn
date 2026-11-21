import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import { api } from "../api";
import { Button, Card, Spinner } from "../components/ui";

type Node = { id: string; label: string; category: string; categoryTitle: string };
type Link = { source: string; target: string; type: string; note?: string };

const PALETTE = ["#8ea6ff", "#7dd3a0", "#f2b06a", "#e08bd0", "#6ad1e3", "#c9a2ff", "#e3d06a", "#8fd6b4"];

export default function TechMap() {
  const [graph, setGraph] = useState<{ nodes: Node[]; links: Link[] } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [size, setSize] = useState({ width: 900, height: 560 });
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.graph().then((g) => setGraph(g as { nodes: Node[]; links: Link[] })).catch(() => setGraph(null));
  }, []);

  useEffect(() => {
    const measure = () => {
      if (wrap.current) setSize({ width: wrap.current.clientWidth, height: Math.max(460, window.innerHeight - 260) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const categories = useMemo(() => {
    const set = new Map<string, string>();
    graph?.nodes.forEach((n) => set.set(n.category, n.categoryTitle));
    return [...set.entries()];
  }, [graph]);

  const colorFor = (category: string) => {
    const idx = categories.findIndex(([key]) => key === category);
    return PALETTE[(idx + PALETTE.length) % PALETTE.length];
  };

  // spread the layout out so labels stay readable
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    g.d3Force("charge")?.strength(-340);
    g.d3Force("link")?.distance(140);
    g.d3ReheatSimulation?.();
  }, [graph, filter]);

  if (!graph) return <Spinner />;

  const nodes = filter === "all" ? graph.nodes : graph.nodes.filter((n) => n.category === filter);
  const ids = new Set(nodes.map((n) => n.id));
  const links = graph.links.filter((l) => ids.has(l.source) && ids.has(l.target));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Technology map</h1>
          <p className="mt-1 text-sm text-muted">
            {nodes.length} technologies, {links.length} relationships. Click a node to open it.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant={filter === "all" ? "primary" : "outline"} size="sm" onClick={() => setFilter("all")}>
            All
          </Button>
          {categories.map(([key, title]) => (
            <Button key={key} variant={filter === key ? "primary" : "outline"} size="sm" onClick={() => setFilter(key)}>
              {title}
            </Button>
          ))}
        </div>
      </div>

      <Card className="overflow-hidden" >
        <div ref={wrap} className="w-full">
          <ForceGraph2D
            ref={fg}
            graphData={{ nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) }}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            nodeLabel={(n) => (n as Node).label}
            nodeRelSize={5}
            linkColor={() => "rgba(140,150,170,0.35)"}
            linkWidth={1}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={0.9}
            cooldownTicks={120}
            onNodeClick={(n) => navigate(`/tech/${(n as Node).id}`)}
            nodeCanvasObject={(node, ctx, scale) => {
              const n = node as Node & { x: number; y: number };
              const r = 5;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = colorFor(n.category);
              ctx.fill();
              const label = n.label;
              const fontSize = Math.max(11, 13 / scale);
              ctx.font = `600 ${fontSize}px Inter, sans-serif`;
              ctx.textAlign = "center";
              const y = n.y + r + 12 / scale;
              const w = ctx.measureText(label).width;
              ctx.fillStyle = "rgba(12,16,22,0.72)";
              ctx.fillRect(n.x - w / 2 - 3, y - fontSize, w + 6, fontSize + 3);
              ctx.fillStyle = "rgba(226,232,242,0.95)";
              ctx.fillText(label, n.x, y);
            }}
          />
        </div>
      </Card>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-muted">
        {categories.map(([key, title]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorFor(key) }} />
            {title}
          </span>
        ))}
      </div>
    </div>
  );
}
