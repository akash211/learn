import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import clsx from "clsx";

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
}) {
  return (
    <Tag className={clsx("rounded-xl border border-line bg-surface", className)}>{children}</Tag>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  className,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-accent text-canvas hover:opacity-90",
    ghost: "text-muted hover:text-ink hover:bg-elevated",
    outline: "border border-line text-ink hover:bg-elevated",
    danger: "text-red-500 hover:bg-red-500/10",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-40 disabled:pointer-events-none",
        size === "sm" ? "px-2.5 py-1.5 text-[13px]" : "px-3.5 py-2 text-sm",
        styles,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "good" | "warn" }) {
  const tones = {
    neutral: "border-line text-muted",
    accent: "border-accent/40 text-accent bg-accentsoft",
    good: "border-emerald-500/40 text-emerald-500",
    warn: "border-amber-500/40 text-amber-500",
  }[tone];
  return (
    <span className={clsx("rounded-md border px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase", tones)}>
      {children}
    </span>
  );
}

export function Ring({ percent, size = 44, label }: { percent: number; size?: number; label?: string }) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" className="text-line" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="currentColor"
          className="text-accent"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c - (c * Math.min(100, percent)) / 100}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[10px] font-semibold">{label ?? `${percent}%`}</span>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx("inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent", className)}
    />
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface/40 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Markdown renderer with copy-to-clipboard on fenced code blocks. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx("md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ children: kids, href }) => (
            <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
              {kids}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="codeblock">
      <button
        onClick={copy}
        className="copy-btn absolute right-2 top-2 z-10 rounded-md border border-line bg-elevated px-2 py-1 text-[11px] text-muted hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="text-xs font-medium uppercase tracking-wider text-muted">{eyebrow}</p>}
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      {action}
    </div>
  );
}
