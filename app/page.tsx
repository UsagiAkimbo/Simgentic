"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import UnityCanvas, {
  UnityCanvasHandle,
  UnityUiEvent,
} from "@/components/UnityCanvas";

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

// One conversation turn. Mirrors the Turn type in app/api/agent/route.ts.
type Turn = { role: "user" | "assistant"; content: string };

// A file attached to the next message. Mirrors Attachment in
// app/api/agent/route.ts.
type Attachment =
  | { kind: "image"; name: string; mediaType: string; dataBase64: string }
  | { kind: "text"; name: string; text: string };

// Default model — must be a key of ALLOWED_MODELS in app/api/agent/route.ts.
const DEFAULT_MODEL = "claude-sonnet-4-5";

// Friendly names for the toast when a model is picked from the Unity panel.
const MODEL_LABELS: Record<string, string> = {
  "claude-3-opus-20240229": "Claude 3 Opus",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
};

// Attachment guardrails. Keep in sync with the route's own caps.
const MAX_ATTACHMENTS = 10;
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB per text file
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "py", "cs", "html",
  "css", "xml", "yaml", "yml", "toml", "ini", "log", "sql", "sh", "ps1",
]);
const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

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

// Sprint D Phase 6: switch the in-scene camera between the Sims top-down
// overview ("default") and the face-on conversation framing ("focused").
// The Unity-side handler accepts a plain string and falls back to default
// for anything unrecognized, so this is safe to call even on builds that
// haven't yet shipped the CameraController wiring.
type CameraMode = "default" | "focused";
function sendCameraMode(unity: UnityCanvasHandle | null, mode: CameraMode) {
  unity?.sendMessage("BridgeReceiver", "SetCameraMode", mode);
}

// Sprint E: push authoritative UI state (selected model + thinking toggle)
// into the Unity overlay so its highlights stay in sync with React state.
function sendUiState(
  unity: UnityCanvasHandle | null,
  model: string,
  thinking: boolean
) {
  unity?.sendMessage(
    "BridgeReceiver",
    "SetUiState",
    JSON.stringify({ model, thinking: thinking ? "on" : "off" })
  );
}

/** Read a File into our Attachment shape, or return an error string. */
async function fileToAttachment(file: File): Promise<Attachment | string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (IMAGE_MEDIA_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      return `${file.name}: image larger than 5 MB.`;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    // dataUrl is "data:<mediaType>;base64,<payload>" — strip the prefix.
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return {
      kind: "image",
      name: file.name,
      mediaType: file.type,
      dataBase64: base64,
    };
  }

  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
    if (file.size > MAX_TEXT_BYTES) {
      return `${file.name}: text file larger than 2 MB.`;
    }
    const text = await file.text();
    return { kind: "text", name: file.name, text };
  }

  return `${file.name}: unsupported type (text and images only for now).`;
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
  const [history, setHistory] = useState<Turn[]>([]);

  // Sprint E: state driven by the Unity overlay UI.
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [thinking, setThinking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const cameraModeRef = useRef<CameraMode>("default");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const answerRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // Keep Unity's overlay highlights in sync whenever model/thinking change
  // (and once at boot, so a reloaded page restores the selection).
  useEffect(() => {
    if (unityReady) sendUiState(unity.current, model, thinking);
  }, [unityReady, model, thinking]);

  // Auto-scroll the answer panel as text streams in.
  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

  const run = useCallback(
    async (message: string) => {
      setRunning(true);
      setErrorMsg(null);
      setAnswer("");
      setPanelOpen(true);
      sendUnity(unity.current, "thinking");

      // Accumulate the streamed answer locally so we can append the (user,
      // assistant) pair to history once the stream finishes. React state
      // updates are async, so we can't read setAnswer's value here directly.
      let accumulated = "";
      let didFinish = false;

      const controller = new AbortController();
      abortRef.current = controller;

      const applyFrame = (frame: SseFrame) => {
        switch (frame.type) {
          case "status": {
            const { state, detail } = frameToUnityState(frame.label);
            sendUnity(unity.current, state, detail);
            break;
          }
          case "text":
            accumulated += frame.delta;
            setAnswer(accumulated);
            break;
          case "done":
            didFinish = true;
            sendUnity(unity.current, "done");
            break;
          case "error":
            setErrorMsg(frame.message);
            sendUnity(unity.current, "error", frame.message);
            break;
        }
      };

      // Attachments are consumed by the message they were added for.
      const outgoingAttachments = attachments;
      setAttachments([]);

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message,
            history,
            model,
            thinking,
            attachments: outgoingAttachments,
          }),
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

        // Only persist completed turns. Partial answers from aborted /
        // errored requests would corrupt context for the next question.
        if (didFinish && accumulated.length > 0) {
          setHistory((prev) => [
            ...prev,
            { role: "user", content: message },
            { role: "assistant", content: accumulated },
          ]);
        }
      }
    },
    [history, model, thinking, attachments]
  );

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

  const onNewConversation = useCallback(() => {
    abortRef.current?.abort();
    setHistory([]);
    setAnswer("");
    setErrorMsg(null);
    setAttachments([]);
    setPanelOpen(false);
    sendUnity(unity.current, "idle");
    // Pull the camera back to the Sims overview — "fresh slate" cue.
    cameraModeRef.current = "default";
    sendCameraMode(unity.current, "default");
  }, []);

  // Files chosen via the hidden inputs (triggered from Unity's PlusPanel).
  const onPickedFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const files = Array.from(list);
      const results = await Promise.all(files.map(fileToAttachment));

      const accepted: Attachment[] = [];
      const rejected: string[] = [];
      for (const r of results) {
        if (typeof r === "string") rejected.push(r);
        else accepted.push(r);
      }

      setAttachments((prev) => {
        const merged = [...prev, ...accepted];
        if (merged.length > MAX_ATTACHMENTS) {
          rejected.push(`Only the first ${MAX_ATTACHMENTS} attachments kept.`);
        }
        return merged.slice(0, MAX_ATTACHMENTS);
      });

      if (rejected.length > 0) showToast(rejected[0]);
      else if (accepted.length > 0) {
        showToast(
          accepted.length === 1
            ? `Attached ${accepted[0].name}`
            : `Attached ${accepted.length} files`
        );
      }
    },
    [showToast]
  );

  // Router for interactions coming out of the Unity overlay UI.
  const onUnityUiEvent = useCallback(
    (event: UnityUiEvent) => {
      const value = event.value ?? "";
      switch (event.action) {
        case "model.select":
          setModel(value);
          showToast(`Model: ${MODEL_LABELS[value] ?? value}`);
          break;
        case "thinking.toggle":
          setThinking(value === "on");
          showToast(value === "on" ? "Adaptive thinking on" : "Adaptive thinking off");
          break;
        case "add.file":
          fileInputRef.current?.click();
          break;
        case "add.folder":
          folderInputRef.current?.click();
          break;
        case "add.image":
          imageInputRef.current?.click();
          break;
        case "conversation.new":
          onNewConversation();
          break;
        case "camera.toggle": {
          const next: CameraMode =
            cameraModeRef.current === "default" ? "focused" : "default";
          cameraModeRef.current = next;
          sendCameraMode(unity.current, next);
          break;
        }
        case "panel.toggle":
          // Unity handles panel visibility itself; nothing to do host-side.
          break;
        default:
          // Everything else (connectors, skills, plugins, EnviromentPanel
          // features) is groundwork for upcoming sprints — the event plumbing
          // works end-to-end, the feature just isn't built yet.
          showToast("Coming soon");
          break;
      }
    },
    [onNewConversation, showToast]
  );

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
          onUiEvent={onUnityUiEvent}
          onError={(m) => setUnityError(m)}
        />
        {toast && (
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <div className="rounded-full bg-slate-900/90 px-4 py-2 text-sm text-slate-100 shadow-lg ring-1 ring-white/10">
              {toast}
            </div>
          </div>
        )}
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

      {/* Hidden pickers — triggered by Unity's PlusPanel (File / Folder / Picture) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void onPickedFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          void onPickedFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void onPickedFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Attachment chips — files queued for the next message */}
      {attachments.length > 0 && (
        <div className="w-full border-t border-white/5 bg-slate-950 px-4 pt-2">
          <div className="mx-auto flex max-w-xl flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <span
                key={`${a.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-200"
              >
                <span aria-hidden>{a.kind === "image" ? "🖼" : "📄"}</span>
                <span className="max-w-[10rem] truncate">{a.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  className="text-slate-400 hover:text-slate-100"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Input bar — sticks to bottom, accommodates iOS safe area + keyboard */}
      <form
        onSubmit={onSubmit}
        className="sticky bottom-0 w-full border-t border-white/5 bg-slate-950 px-4 pt-3"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
      >
        <div className="mx-auto flex max-w-xl items-center gap-2">
          {history.length > 0 && !running && (
            <button
              type="button"
              onClick={onNewConversation}
              aria-label="Start a new conversation"
              title="New conversation"
              className="h-12 w-12 shrink-0 rounded-full border border-white/10 bg-slate-900 text-2xl leading-none text-slate-400 hover:text-slate-200 active:bg-slate-800"
            >
              +
            </button>
          )}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => {
              cameraModeRef.current = "focused";
              sendCameraMode(unity.current, "focused");
            }}
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
