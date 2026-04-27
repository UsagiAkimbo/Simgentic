"use client";

import { useCallback, useRef, useState } from "react";
import UnityCanvas, { UnityCanvasHandle } from "@/components/UnityCanvas";

const STATES = [
  "idle",
  "thinking",
  "searching",
  "reading",
  "answering",
  "done",
  "error",
] as const;

type AgentState = (typeof STATES)[number];

export default function UnityTestPage() {
  const unity = useRef<UnityCanvasHandle>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const send = useCallback((state: AgentState, detail = "") => {
    const payload = JSON.stringify({ state, detail });
    unity.current?.sendMessage("BridgeReceiver", "SetAgentState", payload);
    setLastSent(`${state}${detail ? ` — "${detail}"` : ""}`);
  }, []);

  return (
    <main className="flex min-h-[100dvh] flex-col">
      <div className="flex-1 min-h-0">
        <UnityCanvas
          ref={unity}
          buildPath="/unity/Build"
          buildName="sprite-agent"
          compression="unityweb"
          onReady={() => setReady(true)}
          onError={(m) => setError(m)}
        />
      </div>

      <div
        className="shrink-0 border-t border-white/5 bg-slate-900/80 px-4 pt-4"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs text-slate-400">
            {error
              ? "Unity failed to start — see message below."
              : ready
                ? "Bridge ready. Tap a state to send it to Unity."
                : "Waiting for Unity to boot..."}
          </p>
          {lastSent && (
            <p className="text-xs text-sky-400">sent: {lastSent}</p>
          )}
        </div>

        {error && (
          <p className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                send(s, s === "searching" ? "weather in Phoenix" : "")
              }
              disabled={!ready}
              className="h-11 min-w-[96px] rounded-full bg-sky-500 px-4 text-sm font-medium text-slate-950 transition active:bg-sky-400 disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        <p className="mt-3 text-[11px] leading-snug text-slate-500">
          Each tap calls <code>unityInstance.SendMessage(&quot;BridgeReceiver&quot;, &quot;SetAgentState&quot;, json)</code>
          . If the cube (or character) visibly changes, the bridge works and we move to Sprint B.
        </p>
      </div>
    </main>
  );
}
