"use client";

import { useEffect, useState } from "react";
import { PageShell } from "@/components/TopNav";
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageGreeting,
  SectionHeader,
} from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
};

function profileInitials(profile: Profile | null): string {
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

export default function SettingsPage() {
  const supabase = createClient();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load profile");
        return data as Profile;
      })
      .then((data) => {
        if (cancelled) return;
        setProfile(data);
        setFullName(data.full_name ?? "");
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileSaving(true);
    setProfileSuccess(null);
    setProfileError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          full_name: fullName.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update profile");
      setProfile(data as Profile);
      setFullName(data.full_name ?? "");
      setProfileSuccess("Profile updated.");
    } catch (e: unknown) {
      setProfileError(e instanceof Error ? e.message : "Failed to update profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function updatePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordSaving(true);
    setPasswordSuccess(null);
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      setPasswordSaving(false);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      setPasswordSaving(false);
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSuccess("Password updated successfully.");
    } catch (e: unknown) {
      setPasswordError(
        e instanceof Error ? e.message : "Failed to update password"
      );
    } finally {
      setPasswordSaving(false);
    }
  }

  async function sendResetEmail() {
    if (!profile?.email) return;
    setPasswordSaving(true);
    setPasswordSuccess(null);
    setPasswordError(null);
    try {
      const origin =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
        window.location.origin;
      const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
        redirectTo: `${origin}/auth/callback?next=/auth/reset-password`,
      });
      if (error) throw error;
      setPasswordSuccess("Password reset email sent. Check your inbox.");
    } catch (e: unknown) {
      setPasswordError(
        e instanceof Error ? e.message : "Failed to send reset email"
      );
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <PageShell nav={{ active: "settings", crumb: "Settings" }}>
      <PageGreeting
        title="Account settings"
        subtitle="Manage your profile and sign-in security."
      />

      {loading && (
        <Card className="p-6">
          <p className="text-sm text-ink-500">Loading your account…</p>
        </Card>
      )}

      {loadError && (
        <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
          {loadError}
        </div>
      )}

      {!loading && !loadError && profile && (
        <div className="space-y-6">
          <Card className="p-6">
            <SectionHeader
              title="Profile"
              description="Your name appears in the sidebar and across the app."
            />
            <div className="mb-6 flex items-center gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-gradient text-sm font-semibold text-white">
                {profileInitials(profile)}
              </span>
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  {profile.full_name?.trim() || profile.email}
                </div>
                <div className="text-sm text-ink-500">{profile.email}</div>
                {profile.is_admin && (
                  <div className="mt-1.5">
                    <Badge tone="blue">Platform admin</Badge>
                  </div>
                )}
              </div>
            </div>

            <form onSubmit={saveProfile} className="max-w-md space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" value={profile.email} disabled readOnly />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>

              {profileError && (
                <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                  {profileError}
                </div>
              )}
              {profileSuccess && (
                <div className="rounded-xl bg-accent-mint-bg px-4 py-3 text-sm text-accent-mint-fg">
                  {profileSuccess}
                </div>
              )}

              <Button type="submit" disabled={profileSaving}>
                {profileSaving ? "Saving…" : "Save profile"}
              </Button>
            </form>
          </Card>

          <Card className="p-6">
            <SectionHeader
              title="Security"
              description="Update your password or request a reset link by email."
            />

            <form onSubmit={updatePassword} className="max-w-md space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword">Confirm new password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={8}
                />
              </div>

              {passwordError && (
                <div className="rounded-xl bg-accent-rose-bg px-4 py-3 text-sm text-accent-rose-fg">
                  {passwordError}
                </div>
              )}
              {passwordSuccess && (
                <div className="rounded-xl bg-accent-mint-bg px-4 py-3 text-sm text-accent-mint-fg">
                  {passwordSuccess}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={passwordSaving || !newPassword}>
                  {passwordSaving ? "Updating…" : "Update password"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={passwordSaving}
                  onClick={sendResetEmail}
                >
                  Email reset link
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
