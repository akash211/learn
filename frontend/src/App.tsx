import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import clsx from "clsx";
import { SearchPalette } from "./components/SearchPalette";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/techs", label: "Technologies" },
  { to: "/revision", label: "Quick revision" },
  { to: "/interview", label: "Mock interview" },
  { to: "/playground", label: "Playground" },
  { to: "/map", label: "Technology map" },
  { to: "/queue", label: "Revision queue" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/notes", label: "Notes" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("learn.theme", dark ? "dark" : "light");
  }, [dark]);

  // scroll to top on navigation
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex min-h-full">
      <aside
        className={clsx(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface/60 px-3 py-4 md:flex",
          collapsed ? "w-[68px]" : "w-[248px]",
        )}
      >
        <div className="mb-6 flex items-center justify-between px-1">
          <NavLink to="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-canvas">L</span>
            {!collapsed && <span className="text-[15px] font-semibold tracking-tight">Learn</span>}
          </NavLink>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="rounded p-1 text-muted hover:bg-elevated hover:text-ink"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                clsx(
                  "relative flex items-center rounded-lg px-2.5 py-2 text-[13.5px] transition",
                  isActive
                    ? "bg-accentsoft font-medium text-accent before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-accent"
                    : "text-muted hover:bg-elevated hover:text-ink",
                  collapsed && "justify-center",
                )
              }
              title={collapsed ? item.label : undefined}
            >
              {collapsed ? item.label.slice(0, 2) : item.label}
            </NavLink>
          ))}
        </nav>

        <button
          onClick={() => setDark((v) => !v)}
          className="mt-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted hover:bg-elevated hover:text-ink"
        >
          {collapsed ? (dark ? "☾" : "☀") : dark ? "☾  Dark theme" : "☀  Light theme"}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-canvas/85 px-4 py-2.5 backdrop-blur">
          <button
            onClick={() => setPalette(true)}
            className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-left text-[13px] text-muted hover:border-accent/40 md:max-w-lg"
          >
            <span>Search</span>
            <span className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px]">⌘K</span>
          </button>
          <div className="ml-auto flex items-center gap-1 md:hidden">
            {NAV.slice(0, 6).map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.end}
                className={({ isActive }) =>
                  clsx("rounded px-2 py-1 text-[11px]", isActive ? "text-accent" : "text-muted")
                }
              >
                {i.label.split(" ")[0]}
              </NavLink>
            ))}
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>

      <SearchPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
