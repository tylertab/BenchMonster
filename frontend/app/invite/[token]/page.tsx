"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button, ErrorNote } from "@/components/ui";
import { api, type Role } from "@/lib/api";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { me, setMe } = useAuth();
  const router = useRouter();
  const [inv, setInv] = useState<{ org_name: string; email: string; role: Role } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invitation(token).then(setInv, (e) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    try {
      setMe(await api.acceptInvite(token));
      router.replace("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-10 max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Join an organization</h1>
      <ErrorNote error={error} />
      {inv && (
        <>
          <p className="text-sm text-ink-2">
            <strong className="text-ink">{inv.org_name}</strong> invited <strong className="text-ink">{inv.email}</strong> to join as{" "}
            {inv.role === "owner" ? "an owner" : "an admin"}.
          </p>
          {me ? (
            me.user.email.toLowerCase() === inv.email.toLowerCase() ? (
              <Button onClick={accept} disabled={busy} className="w-full">
                {busy ? "Joining…" : `Join ${inv.org_name}`}
              </Button>
            ) : (
              <p className="text-sm text-ink-2">
                You&apos;re signed in as {me.user.email}. Sign out and sign in as {inv.email} to accept.
              </p>
            )
          ) : (
            <div className="flex gap-2">
              <Link href={`/signup?invite=${token}`} className="flex-1 rounded-md bg-accent px-3 py-2 text-center text-sm font-medium text-white">
                Create account
              </Link>
              <Link href={`/login?invite=${token}`} className="flex-1 rounded-md border border-line px-3 py-2 text-center text-sm font-medium">
                I have an account
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
