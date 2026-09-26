"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, UNAUTHORIZED_EVENT, type Me } from "@/lib/api";

const PUBLIC_PREFIXES = ["/login", "/signup", "/invite/"];
const isPublic = (path: string) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));

type AuthState = { me: Me | null; setMe: (me: Me | null) => void; refresh: () => Promise<void> };
const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(
    () =>
      api
        .me()
        .then(setMe, () => setMe(null))
        .finally(() => setChecked(true)),
    [],
  );

  useEffect(() => {
    api
      .me()
      .then(setMe, () => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  // Any 401 (expired session) drops the user back to login.
  useEffect(() => {
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const publicPage = isPublic(pathname);
  useEffect(() => {
    if (!checked) return;
    if (!me && !publicPage) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (me && (pathname === "/login" || pathname === "/signup")) {
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next?.startsWith("/") ? next : "/");
    }
  }, [checked, me, publicPage, pathname, router]);

  const ready = checked && (publicPage || me);
  return (
    <AuthContext.Provider value={{ me, setMe, refresh }}>
      {/* Keyed by org so switching orgs remounts pages and refetches their data. */}
      {ready ? <Fragment key={me?.org?.id ?? "anon"}>{children}</Fragment> : <p className="py-16 text-center text-sm text-muted">Loading…</p>}
    </AuthContext.Provider>
  );
}
