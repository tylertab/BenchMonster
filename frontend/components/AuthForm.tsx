"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Role } from "@/lib/api";
import { useAuth } from "./AuthProvider";
import { Button, ErrorNote, Field, inputClass } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const { setMe } = useAuth();
  const invite = params.get("invite");
  const next = params.get("next");
  const [invitation, setInvitation] = useState<{ org_name: string; email: string; role: Role } | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", org_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    if (!invite) return;
    api.invitation(invite).then(
      (inv) => {
        setInvitation(inv);
        setForm((f) => ({ ...f, email: inv.email }));
      },
      (e) => setError(e.message),
    );
  }, [invite]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let me;
      if (mode === "signup") {
        me = await api.signup({
          name: form.name,
          email: form.email,
          password: form.password,
          org_name: invite ? undefined : form.org_name || undefined,
          invite_token: invite ?? undefined,
        });
      } else {
        me = await api.login({ email: form.email, password: form.password });
        if (invite) me = await api.acceptInvite(invite);
      }
      setMe(me);
      router.replace(next && next.startsWith("/") ? next : "/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const other = mode === "login" ? "signup" : "login";
  const otherHref = `/${other}${invite ? `?invite=${invite}` : next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <div className="mx-auto mt-10 max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Sign in" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-ink-2">
        {invitation
          ? `You're invited to join ${invitation.org_name} as ${invitation.role === "owner" ? "an owner" : "an admin"}.`
          : mode === "login"
            ? "Welcome back to BenchMonster."
            : "You'll be the owner of a new organization."}
      </p>
      <form onSubmit={submit} className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-5">
        {mode === "signup" && (
          <Field label="Your name">
            <input required autoComplete="name" className={inputClass} value={form.name} onChange={set("name")} />
          </Field>
        )}
        <Field label="Email">
          <input
            required
            type="email"
            autoComplete="email"
            className={inputClass}
            value={form.email}
            onChange={set("email")}
            readOnly={Boolean(invitation) && mode === "signup"}
          />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "At least 8 characters" : undefined}>
          <input
            required
            type="password"
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className={inputClass}
            value={form.password}
            onChange={set("password")}
          />
        </Field>
        {mode === "signup" && !invite && (
          <Field label="Organization name" hint="Your team's workspace; you can invite others later">
            <input className={inputClass} value={form.org_name} onChange={set("org_name")} placeholder="Acme AI" />
          </Field>
        )}
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "…" : mode === "login" ? (invite ? "Sign in & join" : "Sign in") : invite ? "Create account & join" : "Create account"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-2">
        {mode === "login" ? "New here? " : "Already have an account? "}
        <Link href={otherHref} className="text-accent hover:underline">
          {mode === "login" ? "Create an account" : "Sign in"}
        </Link>
      </p>
    </div>
  );
}
