"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LayoutGrid,
  LayoutDashboard,
  Activity,
  Plus,
  LogOut,
  AudioLines,
  Home,
  Search,
  Bell,
  ChevronDown,
  ChevronRight,
  Sun,
  Moon,
  Settings,
  Shield,
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
    | "home"
    | "workspaces"
    | "new-workspace"
    | "new-agent"
    | "settings"
    | "admin";
  activeAgentId?: string;
  /** Breadcrumb leaf shown after the workspace name. */
  crumb?: string;
};

const CRM_LABEL: Record<string, string> = {
  followupboss: "Follow Up Boss",
  highlevel: "HighLevel",
};

type WorkspaceOption = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: string;
  is_active: boolean;
};

type UserProfile = {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
};

function userInitials(profile: UserProfile | null): string {
  if (!profile) return "…";
  const name = profile.full_name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  const email = profile.email.trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return "U";
}

function userDisplayName(profile: UserProfile | null): string {
  if (!profile) return "Account";
  return profile.full_name?.trim() || profile.email.split("@")[0] || "Account";
}

function userSubtitle(profile: UserProfile | null): string {
  if (!profile) return "Loading…";
  if (profile.is_admin) return "Platform admin";
  return profile.email;
}

function useUserProfile() {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as UserProfile;
      })
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return profile;
}

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

/* -------------------------- Workspace switcher ------------------------- */
function WorkspaceSwitcher({
  workspaceId,
  workspaceName,
  workspaceMeta,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceMeta?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
          setWorkspaces([]);
          return;
        }
        setWorkspaces(d.workspaces ?? []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unable to load workspaces");
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative mx-3 mb-2 mt-1">
      <button
        type="button"
        title="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-[11px] border border-ink-200/60 bg-surface-2 px-3 py-2.5 text-left transition-colors hover:bg-surface hover:shadow-soft"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-violet-bg text-[12px] font-bold text-accent-violet-fg">
          {initials(workspaceName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink-900">
            {workspaceName}
          </span>
          {workspaceMeta && (
            <span className="block truncate text-[11px] text-ink-400">
              {workspaceMeta}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-ink-400 transition-transform",
            open && "rotate-180"
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-ink-200/60 bg-surface shadow-lifted"
        >
          <Link
            href="/"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 border-b border-ink-100 px-3 py-2.5 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-surface-2 hover:text-ink-900"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-sky-bg text-accent-sky-icon">
              <Home className="h-4 w-4" strokeWidth={1.75} />
            </span>
            Home
          </Link>
          <Link
            href="/workspaces"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 border-b border-ink-100 px-3 py-2.5 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-surface-2 hover:text-ink-900"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-violet-bg text-accent-violet-icon">
              <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
            </span>
            Workspaces
          </Link>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {!workspaces && (
              <p className="px-2 py-2 text-[12px] text-ink-400">
                Loading workspaces…
              </p>
            )}
            {error && (
              <p className="px-2 py-2 text-[12px] text-accent-rose-fg">
                Failed to load workspaces.
              </p>
            )}
            {workspaces?.map((workspace) => {
              const active = workspace.id === workspaceId;
              const meta = `${CRM_LABEL[workspace.crm_provider] ?? workspace.crm_provider} · ${workspace.timezone}`;
              return (
                <Link
                  key={workspace.id}
                  href={`/workspaces/${workspace.id}`}
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors",
                    active
                      ? "bg-brand-50 text-brand-700"
                      : "text-ink-600 hover:bg-surface-2 hover:text-ink-900"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold",
                      active
                        ? "bg-white text-brand-700 shadow-pill"
                        : "bg-accent-violet-bg text-accent-violet-fg"
                    )}
                  >
                    {initials(workspace.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">
                      {workspace.name}
                    </span>
                    <span
                      className={cn(
                        "block truncate text-[11px]",
                        active ? "text-brand-500" : "text-ink-400"
                      )}
                    >
                      {meta}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      workspace.is_active ? "bg-accent-mint-icon" : "bg-ink-300"
                    )}
                  />
                </Link>
              );
            })}
            {workspaces && workspaces.length === 0 && !error && (
              <p className="px-2 py-2 text-[12px] text-ink-400">
                No workspaces available.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
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
  const profile = useUserProfile();

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
        <WorkspaceSwitcher
          workspaceId={workspaceId}
          workspaceName={wsName}
          workspaceMeta={wsMeta}
        />
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
              Platform
            </div>
            <NavItem
              href="/"
              icon={Home}
              label="Home"
              active={nav?.active === "home"}
            />
            <NavItem
              href="/workspaces"
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

        <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-400">
          Account
        </div>
        <NavItem
          href="/settings"
          icon={Settings}
          label="Settings"
          active={nav?.active === "settings"}
        />
        {profile?.is_admin && (
          <NavItem
            href="/admin"
            icon={Shield}
            label="Admin console"
            active={nav?.active === "admin"}
          />
        )}
      </div>

      {/* Account footer */}
      <div className="border-t border-ink-200/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <Link
            href="/settings"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg transition-colors hover:bg-surface-2"
          >
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-brand-gradient text-[12px] font-semibold text-white">
              {userInitials(profile)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-ink-800">
                {userDisplayName(profile)}
              </div>
              <div className="truncate text-[11px] text-ink-400">
                {userSubtitle(profile)}
              </div>
            </div>
          </Link>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-ink-200/70 bg-surface text-ink-500 transition-colors hover:text-ink-800 hover:shadow-soft"
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

/* ----------------------------- Mobile nav ------------------------------ */
function MobileNavStrip({ nav }: { nav?: PageNav }) {
  if (!nav?.workspaceId) return null;
  const id = nav.workspaceId;
  const linkClass = (active: boolean) =>
    cn(
      "flex-1 rounded-lg px-3 py-2 text-center text-xs font-medium transition-colors",
      active
        ? "bg-accent-sky-bg text-accent-sky-fg"
        : "text-ink-500 hover:bg-ink-50 hover:text-ink-700"
    );
  return (
    <nav className="flex gap-1 border-b border-ink-200/60 bg-surface px-3 py-2 md:hidden">
      <Link href={`/workspaces/${id}?tab=dashboard`} className={linkClass(nav.active === "dashboard")}>
        Dashboard
      </Link>
      <Link href={`/workspaces/${id}?tab=operations`} className={linkClass(nav.active === "operations")}>
        Operations
      </Link>
      {nav.activeAgentId && (
        <Link href={`/agents/${nav.activeAgentId}`} className={linkClass(nav.active === "agent")}>
          Agent
        </Link>
      )}
    </nav>
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
        <MobileNavStrip nav={resolved} />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
