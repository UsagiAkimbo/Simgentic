"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type SseFrame =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };

const IDLE_LABEL = "Give me a task.";

export default function HomePage() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>(IDLE_LABEL);
  const [answer, setAnswer] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the result area as the answer grows.
  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

  const run = useCallback(async (message: string) => {
    setRunning(true);
    setErrorMsg(null);
    setAnswer("");
    setStatus("Thinking...");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Parse `data: {json}\n\n` SSE frames out of the stream.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let frame: SseFrame;
            try {
              frame = JSON.parse(payload) as SseFrame;
            } catch {
              continue;
            }
            applyFrame(frame);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        setStatus(IDLE_LABEL);
      } else {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setErrorMsg(msg);
        setStatus("Something broke.");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, []);

  function applyFrame(frame: SseFrame) {
    switch (frame.type) {
      case "status":
        setStatus(frame.label);
        break;
      case "text":
        setAnswer((prev) => prev + frame.delta);
        break;
      case "done":
        setStatus("Done.");
        break;
      case "error":
        setErrorMsg(frame.message);
        setStatus("Something broke.");
        break;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || running) return;
    setInput("");
    await run(trimmed);
  }

  function onStop() {
    abortRef.current?.abort();
  }

  const isBusy = running && status !== "Done.";

  return (
    <main className="flex min-h-[100dvh] flex-col">
      {/* Sprite + bubble area */}
      <section className="flex flex-1 flex-col items-center px-4 pt-8">
        <ThoughtBubble status={status} busy={isBusy} />
        <div className="mt-2 select-none text-7xl sprite-bob" aria-label="agent sprite">
          🧑‍💻
        </div>

        {/* Result area */}
        <div
          ref={answerRef}
          className="mt-6 w-full max-w-xl flex-1 overflow-y-auto rounded-2xl bg-slate-900/60 p-4 text-[15px] leading-relaxed text-slate-100 ring-1 ring-white/10"
          aria-live="polite"
        >
          {errorMsg ? (
            <p className="text-red-300">{errorMsg}</p>
          ) : answer ? (
            <p className="whitespace-pre-wrap">{answer}</p>
          ) : (
            <p className="text-slate-500">
              Answers will appear here as the sprite works.
            </p>
          )}
        </div>
      </section>

      {/* Input */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 w-full bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent px-4 pt-4"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="mx-auto flex max-w-xl items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the sprite to do something..."
            autoComplete="off"
            enterKeyHint="send"
            disabled={running}
            className="h-12 flex-1 rounded-full border border-white/10 bg-slate-900 px-5 text-base text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400 disabled:opacity-60"
          />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              className="h-12 min-w-[56px] rounded-full bg-red-500 px-4 text-base font-medium text-slate-950 active:bg-red-400"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={input.trim().length === 0}
              className="h-12 min-w-[56px] rounded-full bg-sky-500 px-4 text-base font-medium text-slate-950 active:bg-sky-400 disabled:opacity-50"
            >
              Go
            </button>
          )}
        </div>
      </form>
    </main>
  );
}

function ThoughtBubble({ status, busy }: { status: string; busy: boolean }) {
  return (
    <div className="relative max-w-[85%]">
      <div className="rounded-2xl bg-white px-5 py-3 text-[15px] font-medium text-slate-900 shadow-lg">
        <span>{status}</span>
        {busy && (
          <span className="ml-1 inline-flex gap-[2px] align-middle">
            <span className="dot">·</span>
            <span className="dot">·</span>
            <span className="dot">·</span>
          </span>
        )}
      </div>
      {/* Bubble tail */}
      <div className="absolute left-1/2 -bottom-1 h-3 w-3 -translate-x-1/2 rotate-45 bg-white" />
      <div className="absolute left-1/2 -bottom-3 h-2 w-2 -translate-x-1/2 rotate-45 rounded-sm bg-white opacity-60" />
    </div>
  );
}
