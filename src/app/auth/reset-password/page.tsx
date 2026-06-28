"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Input, Label } from "@/components/ui";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const supabase = createClient();

  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      setHasSession(Boolean(session));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase.auth]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) throw updateError;
      setNotice("Password updated. Redirecting to settings…");
      setTimeout(() => {
        router.replace("/settings");
        router.refresh();
      }, 1200);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0 bg-page-gradient" />
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-accent-mint-icon/10 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-lifted">
            <AudioLines className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            Set a new password
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            Choose a new password for your UpSurge account.
          </p>
        </div>

        <Card className="p-8 shadow-lifted">
          {!ready && (
            <p className="text-sm text-ink-500">Verifying recovery link…</p>
          )}

          {ready && !hasSession && (
            <div className="space-y-4">
              <p className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                This reset link is invalid or has expired. Request a new one from
                the sign-in page.
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => router.replace("/login")}
              >
                Back to sign in
              </Button>
            </div>
          )}

          {ready && hasSession && (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>

              {error && (
                <p className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                  {error}
                </p>
              )}
              {notice && (
                <p className="rounded-xl bg-accent-mint-bg px-4 py-3 text-sm text-accent-mint-fg">
                  {notice}
                </p>
              )}

              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
