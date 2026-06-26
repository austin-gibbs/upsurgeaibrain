"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LayoutGrid,
  LayoutDashboard,
  Activity,
  Plus,
  LogOut,
  AudioLines,
  Search,
  Bell,
  ChevronDown,
  ChevronRight,
  Sun,
  Moon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/components/ui";

/* ----------------------------- Nav context ----------------------------- */
export type RailAgent = {
  id: string;
  name: string;
  status: string;
  direction: string;
};

export type PageNav = {
  /** Selected workspace; enables the workspace switcher + agent list. */
  workspaceId?: string;
  workspaceName?: string;
  /** e.g. "HighLevel · America/Los_Angeles" */
  workspaceMeta?: string;
  /** Agents in the workspace. If omitted (but workspaceId is set) the rail
   *  fetches them so a freshly created agent shows up automatically. */
  agents?: RailAgent[];
  active?:
    | "dashboard"
    | "operations"
    | "agent"
    | "workspaces"
    | "new-workspace"
    | "new-agent";
  activeAgentId?: string;
  /** Breadcrumb leaf shown after the workspace name. */
  crumb?: string;
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "WS";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function dotClass(status: string): string {
  if (status === "active") return "bg-accent-mint-icon ring-4 ring-accent-mint-bg";
  if (status === "paused") return "bg-accent-amber-icon ring-4 ring-accent-amber-bg";
  return "bg-ink-300 ring-4 ring-ink-100";
}

/* ----------------------------- Theme toggle ----------------------------- */
function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("upsurge-theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      title="Toggle light / dark"
      className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-ink-200/70 bg-surface text-ink-500 transition-colors hover:border-brand-200 hover:text-brand-500"
    >
      {theme === "dark" ? (
        <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      ) : (
        <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} />
      )}
    </button>
  );
}

/* ------------------------------ Rail item ------------------------------ */
function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: typeof LayoutGrid;
  label: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "relative mb-px flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-brand-50 font-semibold text-brand-700 before:absolute before:-left-3 before:bottom-2 before:top-2 before:w-[3px] before:rounded-r-[3px] before:bg-brand-500"
          : "text-ink-600 hover:bg-surface-2 hover:text-ink-900"
      )}
    >
      <Icon
        className={cn("h-[18px] w-[18px] shrink-0", active ? "opacity-100" : "opacity-80")}
        strokeWidth={1.9}
      />
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}

// Resolve the workspace name/meta/agent list for the rail + breadcrumb. If the
// page supplied them we use those; otherwise (e.g. the agent detail page only
// knows the workspace id) we fetch /api/workspaces/[id] so a freshly created
// agent still appears automatically.
function useResolvedNav(nav?: PageNav): PageNav | undefined {
  const [fetched, setFetched] = useState<{
    name: string;
    meta: string;
    agents: RailAgent[];
  } | null>(null);

  const workspaceId = nav?.workspaceId;
  const needsFetch = Boolean(
    workspaceId && (!nav?.workspaceName || !nav?.agents)
  );

  useEffect(() => {
    setFetched(null);
    if (!workspaceId || !needsFetch) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || d.error || !d.workspace) return;
        const ws = d.workspace;
        setFetched({
          name: ws.name,
          meta: `${CRM_LABEL[ws.crm_provider] ?? ws.crm_provider} · ${ws.timezone}`,
          agents: (d.agents ?? []).map((a: RailAgent) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            direction: a.direction,
          })),
        });
      })
      .catch(() => {
        /* rail degrades gracefully */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, needsFetch]);

  if (!nav) return nav;
  return {
    ...nav,
    workspaceName: nav.workspaceName ?? fetched?.name,
    workspaceMeta: nav.workspaceMeta ?? fetched?.meta,
    agents: nav.agents ?? fetched?.agents ?? [],
  };
}

/* -------------------------------- Rail --------------------------------- */
function Rail({ nav }: { nav?: PageNav }) {
  const router = useRouter();
  const supabase = createClient();

  const workspaceId = nav?.workspaceId;

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const wsName = nav?.workspaceName;
  const wsMeta = nav?.workspaceMeta;
  const agents = nav?.agents ?? [];

  return (
    <aside className="sticky top-0 hidden h-screen flex-col border-r border-ink-200/60 bg-surface md:flex">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-[18px] pb-3 pt-4">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-brand-gradient text-white shadow-soft">
          <AudioLines className="h-[18px] w-[18px]" strokeWidth={2.2} />
        </span>
        <div>
          <div className="text-sm font-bold tracking-tight text-ink-900">UpSurge</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-400">
            AI Voice
          </div>
        </div>
      </div>

      {/* Workspace switcher */}
      {workspaceId && wsName ? (
        <Link
          href="/"
          title="Switch workspace"
          className="mx-3 mb-2 mt-1 flex items-center gap-2.5 rounded-[11px] border border-ink-200/60 bg-surface-2 px-3 py-2.5 transition-colors hover:bg-surface hover:shadow-soft"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-violet-bg text-[12px] font-bold text-accent-violet-fg">
            {initials(wsName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-ink-900">
              {wsName}
            </span>
            {wsMeta && (
              <span className="block truncate text-[11px] text-ink-400">{wsMeta}</span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-400" strokeWidth={2} />
        </Link>
      ) : null}

      {/* Nav */}
      <div className="flex-1 overflow-y-auto px-3 py-1.5">
        {workspaceId ? (
          <>
            <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-400">
              Workspace
            </div>
            <NavItem
              href={`/workspaces/${workspaceId}?tab=dashboard`}
              icon={LayoutDashboard}
              label="Dashboard"
              active={nav?.active === "dashboard"}
            />
            <NavItem
              href={`/workspaces/${workspaceId}?tab=operations`}
              icon={Activity}
              label="Operations"
              active={nav?.active === "operations"}
            />

            <div className="flex items-center justify-between px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-400">
              Agents
              <Link
                href={`/workspaces/${workspaceId}/agents/new`}
                title="Add agent"
                className="flex h-5 w-5 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-brand-50 hover:text-brand-600"
              >
                <Plus className="h-[15px] w-[15px]" strokeWidth={2.2} />
              </Link>
            </div>
            <div>
              {agents.length === 0 ? (
                <p className="px-2.5 py-1.5 text-[11px] text-ink-400">No agents yet.</p>
              ) : (
                agents.map((a) => {
                  const active =
                    nav?.active === "agent" && nav?.activeAgentId === a.id;
                  return (
                    <Link
                      key={a.id}
                      href={`/agents/${a.id}`}
                      className={cn(
                        "relative mb-px flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 transition-colors",
                        active
                          ? "bg-brand-50 text-brand-700 before:absolute before:-left-3 before:bottom-2 before:top-2 before:w-[3px] before:rounded-r-[3px] before:bg-brand-500"
                          : "text-ink-600 hover:bg-surface-2 hover:text-ink-900"
                      )}
                    >
                      <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", dotClass(a.status))} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate text-[13px] font-medium">{a.name}</span>
                        <span
                          className={cn(
                            "truncate text-[10.5px] font-medium capitalize",
                            active ? "text-brand-500" : "text-ink-400"
                          )}
                        >
                          {a.direction} · {a.status}
                        </span>
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <>
            <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-400">
              Workspace
            </div>
            <NavItem
              href="/"
              icon={LayoutGrid}
              label="Workspaces"
              active={nav?.active === "workspaces"}
            />
            <NavItem
              href="/setup"
              icon={Plus}
              label="New workspace"
              active={nav?.active === "new-workspace"}
            />
          </>
        )}
      </div>

      {/* Account footer */}
      <div className="border-t border-ink-200/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-brand-gradient text-[12px] font-semibold text-white">
            OP
          </span>
          <div className="flex-1">
            <div className="text-[12.5px] font-semibold text-ink-800">Operator</div>
            <div className="text-[11px] text-ink-400">Platform admin</div>
          </div>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-ink-200/70 bg-surface text-ink-500 transition-colors hover:text-ink-800 hover:shadow-soft"
          >
            <LogOut className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------- Top bar ------------------------------- */
function TopBar({ nav }: { nav?: PageNav }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-ink-200/60 bg-surface/70 px-7 py-3.5 backdrop-blur-md">
      <div className="flex items-center gap-2 text-[13px] text-ink-400">
        <b className="font-semibold text-ink-800">{nav?.workspaceName ?? "UpSurge"}</b>
        {nav?.crumb && (
          <>
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
            <span>{nav.crumb}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <ThemeToggle />
        <button
          type="button"
          aria-label="Search"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-ink-200/70 bg-surface text-ink-500 transition-colors hover:text-ink-800 hover:shadow-soft"
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Notifications"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-ink-200/70 bg-surface text-ink-500 transition-colors hover:text-ink-800 hover:shadow-soft"
        >
          <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

/* ------------------------------ Public API ----------------------------- */
export function TopNav() {
  return <Rail />;
}

export function PageShell({
  children,
  nav,
}: {
  children: React.ReactNode;
  nav?: PageNav;
}) {
  const resolved = useResolvedNav(nav);
  return (
    <div className="grid min-h-screen grid-cols-1 bg-page-gradient md:grid-cols-[264px_1fr]">
      <Rail nav={resolved} />
      <div className="flex min-w-0 flex-col">
        <TopBar nav={resolved} />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
