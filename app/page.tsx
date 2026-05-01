"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import UnityCanvas, { UnityCanvasHandle } from "@/components/UnityCanvas";

// Mirrors the SseFrame union in app/api/agent/route.ts.
type SseFrame =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };

// AgentState values the C# BridgeReceiver knows how to handle.
type AgentState =
  | "idle"
  | "thinking"
  | "searching"
  | "reading"
  | "answering"
  | "done"
  | "error";

/**
 * Map the human-readable status `label` from the SSE feed to the discrete
 * AgentState the Unity character expects. Order matters here — the longest /
 * most-specific prefix needs to match before its shorter sibling.
 *
 * The labels come from app/api/agent/route.ts: "Thinking...",
 * "Searching the web for \"X\"...", "Searching the web...",
 * "Reading results...", "Answering...", "Done.".
 *
 * Anything that doesn't match falls through to thinking with the raw label
 * as the detail, so unknown statuses still produce *some* visible reaction.
 */
function frameToUnityState(label: string): { state: AgentState; detail: string } {
  const search = label.match(/^Searching the web for "(.+)"/);
  if (search) return { state: "searching", detail: search[1] };
  if (label.startsWith("Searching the web")) return { state: "searching", detail: "" };
  if (label.startsWith("Reading"))            return { state: "reading",   detail: "" };
  if (label.startsWith("Answering"))          return { state: "answering", detail: "" };
  if (label.startsWith("Thinking"))           return { state: "thinking",  detail: "" };
  if (label.startsWith("Done"))               return { state: "done",      detail: "" };
  return { state: "thinking", detail: label };
}

function sendUnity(
  unity: UnityCanvasHandle | null,
  state: AgentState,
  detail = ""
) {
  unity?.sendMessage(
    "BridgeReceiver",
    "SetAgentState",
    JSON.stringify({ state, detail })
  );
}

export default function HomePage() {
  const unity = useRef<UnityCanvasHandle>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [unityReady, setUnityReady] = useState(false);
  const [unityError, setUnityError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const answerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the answer panel as text streams in.
  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

  const run = useCallback(async (message: string) => {
    setRunning(true);
    setErrorMsg(null);
    setAnswer("");
    setPanelOpen(true);
    sendUnity(unity.current, "thinking");

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
        sendUnity(unity.current, "idle");
      } else {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setErrorMsg(msg);
        sendUnity(unity.current, "error", msg);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, []);

  function applyFrame(frame: SseFrame) {
    switch (frame.type) {
      case "status": {
        const { state, detail } = frameToUnityState(frame.label);
        sendUnity(unity.current, state, detail);
        break;
      }
      case "text":
        setAnswer((prev) => prev + frame.delta);
        break;
      case "done":
        sendUnity(unity.current, "done");
        break;
      case "error":
        setErrorMsg(frame.message);
        sendUnity(unity.current, "error", frame.message);
        break;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || running || !unityReady) return;
    setInput("");
    await run(trimmed);
  }

  function onStop() {
    abortRef.current?.abort();
  }

  return (
    <main className="flex min-h-[100dvh] flex-col bg-slate-950 text-slate-100">
      {/* Unity scene — fills the available vertical space above the panels */}
      <section className="relative flex-1 min-h-0">
        <UnityCanvas
          ref={unity}
          buildPath="/unity/Build"
          buildName="sprite-agent"
          compression="unityweb"
          onReady={() => setUnityReady(true)}
          onError={(m) => setUnityError(m)}
        />
        {unityError && (
          <div className="absolute inset-x-4 top-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
            Unity failed to start: {unityError}
          </div>
        )}
      </section>

      {/* Answer panel — slides up when answer is non-empty; tap header to toggle */}
      {(answer || errorMsg) && (
        <section className="shrink-0 border-t border-white/5 bg-slate-900/95">
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-xs uppercase tracking-wide text-slate-400 hover:bg-slate-900"
          >
            <span>{errorMsg ? "error" : "answer"}</span>
            <span aria-hidden>{panelOpen ? "▾" : "▴"}</span>
          </button>
          {panelOpen && (
            <div
              ref={answerRef}
              className="max-h-[40dvh] overflow-y-auto px-4 pb-3 text-[15px] leading-relaxed"
              aria-live="polite"
            >
              {errorMsg ? (
                <p className="text-red-300">{errorMsg}</p>
              ) : (
                <p className="whitespace-pre-wrap text-slate-100">{answer}</p>
              )}
            </div>
          )}
        </section>
      )}

      {/* Input bar — sticks to bottom, accommodates iOS safe area + keyboard */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 w-full border-t border-white/5 bg-slate-950 px-4 pt-3"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
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
              disabled={input.trim().length === 0 || !unityReady}
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
