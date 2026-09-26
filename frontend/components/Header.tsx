"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "./AuthProvider";

function Menu({ label, children }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-surface-2" aria-expanded={open}>
        {label} <span aria-hidden className="text-xs text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-56 rounded-md border border-line bg-surface p-1 shadow-lg">{children(() => setOpen(false))}</div>
      )}
    </div>
  );
}

const itemClass = "block w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-surface-2";

export function Header() {
  const { me, setMe } = useAuth();
  const router = useRouter();

  const switchOrg = async (id: number) => {
    setMe(await api.switchOrg(id));
    router.push("/");
  };
  const newOrg = async () => {
    const name = window.prompt("New organization name");
    if (name?.trim()) {
      setMe(await api.createOrg(name.trim()));
      router.push("/");
    }
  };
  const logout = async () => {
    await api.logout();
    setMe(null);
    router.replace("/login");
  };

  return (
    <header className="border-b border-line bg-surface">
      <nav className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm text-white">
            B
          </span>
          BenchMonster
        </Link>
        {me && (
          <>
            <Link href="/" className="text-sm text-ink-2 hover:text-ink">
              Profiles
            </Link>
            <Link href="/runs" className="text-sm text-ink-2 hover:text-ink">
              Runs
            </Link>
            <Link href="/prompts" className="text-sm text-ink-2 hover:text-ink">
              Prompts
            </Link>
            <Link href="/datasets" className="text-sm text-ink-2 hover:text-ink">
              Datasets
            </Link>
            <Link href="/models" className="text-sm text-ink-2 hover:text-ink">
              Models
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <Menu label={<span className="font-medium">{me.org?.name ?? "No organization"}</span>}>
                {(close) => (
                  <>
                    <div className="px-2.5 py-1 text-xs text-muted">Organizations</div>
                    {me.orgs.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className={itemClass}
                        onClick={() => {
                          close();
                          if (o.id !== me.org?.id) switchOrg(o.id);
                        }}
                      >
                        <span className="inline-block w-4">{o.id === me.org?.id ? "✓" : ""}</span>
                        {o.name} <span className="text-xs capitalize text-muted">· {o.role}</span>
                      </button>
                    ))}
                    <hr className="my-1 border-line" />
                    <Link href="/settings" className={itemClass} onClick={close}>
                      Organization settings
                    </Link>
                    <button type="button" className={itemClass} onClick={() => (close(), newOrg())}>
                      + New organization
                    </button>
                  </>
                )}
              </Menu>
              <Menu label={<span className="text-ink-2">{me.user.name}</span>}>
                {(close) => (
                  <>
                    <div className="px-2.5 py-1 text-xs text-muted">{me.user.email}</div>
                    <button type="button" className={itemClass} onClick={() => (close(), logout())}>
                      Sign out
                    </button>
                  </>
                )}
              </Menu>
              <Link href="/profiles/new" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                New profile
              </Link>
            </div>
          </>
        )}
      </nav>
    </header>
  );
}
