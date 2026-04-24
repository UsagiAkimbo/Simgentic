"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Login failed.");
        return;
      }
      // Go home (or wherever we were redirected from).
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/") ? from : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-2xl bg-slate-900/60 p-6 shadow-xl ring-1 ring-white/10"
      >
        <div className="text-center">
          <div className="text-5xl" aria-hidden>
            🧑‍💻
          </div>
          <h1 className="mt-2 text-xl font-semibold">Sprite Agent</h1>
          <p className="mt-1 text-sm text-slate-400">
            Enter the shared password to continue.
          </p>
        </div>

        <label className="block text-sm">
          <span className="text-slate-300">Password</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-3 text-base outline-none ring-0 focus:border-sky-400"
          />
        </label>

        {error && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="h-12 w-full rounded-lg bg-sky-500 text-base font-medium text-slate-950 transition enabled:hover:bg-sky-400 disabled:opacity-50"
        >
          {submitting ? "Checking..." : "Enter"}
        </button>
      </form>
    </main>
  );
}
