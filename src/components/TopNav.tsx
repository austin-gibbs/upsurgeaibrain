"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid,
  Plus,
  LogOut,
  AudioLines,
  User,
  Search,
  Bell,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/components/ui";

const NAV = [
  { href: "/", label: "Workspaces", icon: LayoutGrid },
  { href: "/setup", label: "New workspace", icon: Plus },
] as const;

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[240px] flex-col border-r border-ink-200/50 bg-white/80 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-soft">
          <AudioLines className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div>
          <span className="text-sm font-semibold tracking-tight text-ink-900">
            UpSurge
          </span>
          <p className="text-[10px] font-medium uppercase tracking-wider text-ink-400">
            AI Voice
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/"
              ? pathname === "/"
              : pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                active
                  ? "bg-ink-100 text-ink-900 shadow-soft"
                  : "text-ink-500 hover:bg-ink-50 hover:text-ink-700"
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
                  active
                    ? "bg-white text-brand-600 shadow-pill"
                    : "bg-ink-100/80 text-ink-500"
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-ink-100 p-3">
        <button
          type="button"
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-500 transition-colors hover:bg-ink-50 hover:text-ink-700"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-100/80">
            <LogOut className="h-4 w-4" strokeWidth={1.75} />
          </span>
          Sign out
        </button>
      </div>
    </aside>
  );
}

function TopBar() {
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-ink-200/40 bg-ink-50/80 px-6 backdrop-blur-xl">
      <div>
        <p className="text-xs font-medium text-ink-400">{date}</p>
        <p className="text-sm font-semibold text-ink-800">{greeting}</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-ink-500 shadow-soft transition-colors hover:text-ink-700"
          aria-label="Search"
        >
          <Search className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white text-ink-500 shadow-soft transition-colors hover:text-ink-700"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <div className="ml-1 flex items-center gap-2.5 rounded-2xl bg-white px-3 py-1.5 shadow-soft">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-xs font-bold text-white">
            <User className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="hidden sm:block">
            <p className="text-xs font-semibold text-ink-800">Operator</p>
            <p className="text-[10px] text-ink-400">Platform admin</p>
          </div>
        </div>
      </div>
    </header>
  );
}

export function TopNav() {
  return <Sidebar />;
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page-gradient">
      <Sidebar />
      <div className="pl-[240px]">
        <TopBar />
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
