"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type UnityInstance = {
  SendMessage: (gameObject: string, method: string, arg?: string | number) => void;
  Quit: () => Promise<void>;
  SetFullscreen?: (full: 0 | 1) => void;
};

type CreateUnityInstance = (
  canvas: HTMLCanvasElement,
  config: Record<string, unknown>,
  onProgress?: (progress: number) => void
) => Promise<UnityInstance>;

/**
 * A UI interaction forwarded from the Unity overlay (radial menu, panels,
 * model picker). Mirrors the JSON emitted by UIOverlayController.Emit in
 * unity-bridge/UIOverlayController.cs via JS_OnUiEvent in the jslib.
 */
export type UnityUiEvent = {
  action: string;
  value?: string;
};

declare global {
  interface Window {
    createUnityInstance?: CreateUnityInstance;
    spriteAgent?: {
      onUnityReady?: () => void;
      onUiEvent?: (event: UnityUiEvent) => void;
    };
  }
}

export type UnityCanvasHandle = {
  /** Send a message to a GameObject's method. Arg is sent as a string. */
  sendMessage: (gameObject: string, method: string, arg?: string | number) => void;
};

/**
 * Which compression was selected in Unity's Player Settings → Publishing Settings.
 * Must match the actual suffix on the files in /Build/. With Decompression Fallback
 * enabled, the loader decompresses in-browser if the server doesn't set
 * Content-Encoding, so these URLs work on plain static hosting like Vercel.
 */
type Compression = "gzip" | "brotli" | "unityweb" | "none";

const COMPRESSION_SUFFIX: Record<Compression, string> = {
  gzip: ".gz",
  brotli: ".br",
  unityweb: ".unityweb", // older / fallback Unity naming; payload is still gzip
  none: "",
};

type Props = {
  /** URL prefix to the Unity build directory, e.g. "/unity/Build". */
  buildPath: string;
  /** Build file prefix (the "Name" you entered in Unity's Build Settings). */
  buildName: string;
  /** Compression used in the Unity WebGL build. Default: gzip. */
  compression?: Compression;
  /** Called once Unity fires JS_OnUnityReady (scene is live and listening). */
  onReady?: () => void;
  /** Called whenever the Unity overlay UI emits an interaction event. */
  onUiEvent?: (event: UnityUiEvent) => void;
  /** Called if the loader fails to boot. */
  onError?: (msg: string) => void;
  /** Called with 0..1 during the loader's download/init phase. */
  onProgress?: (p: number) => void;
  /** Optional className for the outer wrapper. */
  className?: string;
};

/**
 * Mounts a Unity WebGL build inside a React tree. Parent calls
 * `ref.current.sendMessage(...)` to forward events to Unity; Unity calls
 * `JS_OnUnityReady` (declared in SpriteAgentBridge.jslib) once its scene is up.
 */
const UnityCanvas = forwardRef<UnityCanvasHandle, Props>(function UnityCanvas(
  {
    buildPath,
    buildName,
    compression = "gzip",
    onReady,
    onUiEvent,
    onError,
    onProgress,
    className,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const instanceRef = useRef<UnityInstance | null>(null);
  const [progress, setProgress] = useState(0);
  const [booted, setBooted] = useState(false);

  // Capture parent callbacks in refs so the boot effect can call the latest
  // versions WITHOUT listing them as effect dependencies. Without this, every
  // parent re-render (e.g. setState fired from a button click) hands us new
  // function identities, the effect tears Unity down via the cleanup, and any
  // visible scene change is wiped before the next frame renders. This is the
  // canonical Unity-WebGL-in-React footgun.
  const onReadyRef = useRef(onReady);
  const onUiEventRef = useRef(onUiEvent);
  const onErrorRef = useRef(onError);
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onReadyRef.current = onReady;
    onUiEventRef.current = onUiEvent;
    onErrorRef.current = onError;
    onProgressRef.current = onProgress;
  }, [onReady, onUiEvent, onError, onProgress]);

  useImperativeHandle(
    ref,
    () => ({
      sendMessage: (go, method, arg) => {
        const inst = instanceRef.current;
        if (!inst) {
          console.warn("[UnityCanvas] sendMessage called before instance ready");
          return;
        }
        inst.SendMessage(go, method, arg);
      },
    }),
    []
  );

  // Defense-in-depth against Unity's focus-stealing.
  //
  // The proper fix lives in C#: BridgeReceiver.Start() calls
  //   WebGLInput.captureAllKeyboardInput = false;
  // which disables Unity's default behavior of yanking focus back to the
  // canvas whenever another DOM element receives it.
  //
  // We keep this JS shim as INSURANCE against the C# fix going missing — for
  // example, when a fresh Unity build is shipped from a Unity project that
  // hasn't been re-synced with this repo's unity-bridge/ scripts. Without
  // either layer in place, every <input> field in the surrounding page
  // becomes un-typeable: focus is granted, then immediately stolen, with no
  // onChange ever firing. The cost of this shim (one event listener per
  // keyboard event in capture phase, plus a focus() override on the canvas)
  // is negligible compared to a silent regression of the input field.
  useEffect(() => {
    const isFormField = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };

    const passKeysThroughToFormFields = (e: KeyboardEvent) => {
      if (isFormField(document.activeElement)) {
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", passKeysThroughToFormFields, { capture: true });
    window.addEventListener("keyup", passKeysThroughToFormFields, { capture: true });
    window.addEventListener("keypress", passKeysThroughToFormFields, { capture: true });

    const canvas = document.getElementById("unity-canvas") as HTMLCanvasElement | null;
    let restoreFocus: (() => void) | null = null;
    if (canvas) {
      const originalFocus = canvas.focus.bind(canvas);
      canvas.focus = function patchedFocus(options?: FocusOptions) {
        if (isFormField(document.activeElement)) return;
        return originalFocus(options);
      };
      restoreFocus = () => {
        canvas.focus = originalFocus;
      };
    }

    return () => {
      window.removeEventListener("keydown", passKeysThroughToFormFields, { capture: true });
      window.removeEventListener("keyup", passKeysThroughToFormFields, { capture: true });
      window.removeEventListener("keypress", passKeysThroughToFormFields, { capture: true });
      restoreFocus?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Expose the ready hook before the loader runs, so the jslib plugin
    // can call it as soon as BridgeReceiver.Start() executes.
    window.spriteAgent = window.spriteAgent ?? {};
    window.spriteAgent.onUnityReady = () => {
      if (cancelled) return;
      setBooted(true);
      onReadyRef.current?.();
    };
    window.spriteAgent.onUiEvent = (event) => {
      if (cancelled) return;
      onUiEventRef.current?.(event);
    };

    const loaderSrc = `${buildPath}/${buildName}.loader.js`;

    const ensureLoaderScript = () =>
      new Promise<void>((resolve, reject) => {
        if (window.createUnityInstance) return resolve();
        const existing = document.querySelector<HTMLScriptElement>(
          `script[data-unity-loader="${loaderSrc}"]`
        );
        if (existing) {
          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener(
            "error",
            () => reject(new Error(`Failed to load ${loaderSrc}`)),
            { once: true }
          );
          return;
        }
        const script = document.createElement("script");
        script.src = loaderSrc;
        script.async = true;
        script.dataset.unityLoader = loaderSrc;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${loaderSrc}`));
        document.head.appendChild(script);
      });

    const bootstrap = async () => {
      try {
        await ensureLoaderScript();
        if (cancelled || !canvasRef.current) return;
        if (!window.createUnityInstance) {
          throw new Error("createUnityInstance is not defined after loader script loaded.");
        }

        const suffix = COMPRESSION_SUFFIX[compression];
        const config = {
          dataUrl: `${buildPath}/${buildName}.data${suffix}`,
          frameworkUrl: `${buildPath}/${buildName}.framework.js${suffix}`,
          codeUrl: `${buildPath}/${buildName}.wasm${suffix}`,
          streamingAssetsUrl: `${buildPath}/StreamingAssets`,
          companyName: "Simgentic",
          productName: "Sprite Agent",
          productVersion: "0.2.0",
        };

        const instance = await window.createUnityInstance(
          canvasRef.current,
          config,
          (p) => {
            if (cancelled) return;
            setProgress(p);
            onProgressRef.current?.(p);
          }
        );

        if (cancelled) {
          await instance.Quit().catch(() => void 0);
          return;
        }
        instanceRef.current = instance;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown Unity bootstrap error.";
        onErrorRef.current?.(msg);
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      if (window.spriteAgent) {
        window.spriteAgent.onUnityReady = undefined;
        window.spriteAgent.onUiEvent = undefined;
      }
      const inst = instanceRef.current;
      instanceRef.current = null;
      if (inst) void inst.Quit().catch(() => void 0);
    };
    // Intentionally only depend on the build identity. Callbacks are read via
    // refs above so parent re-renders don't trigger a destroy/reboot cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildPath, buildName, compression]);

  return (
    <div className={`relative h-full w-full ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        id="unity-canvas"
        className="block h-full w-full"
        style={{ touchAction: "none", background: "#0b1020" }}
      />
      {!booted && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-slate-950/95 text-slate-200">
          <div className="mb-1 text-6xl" aria-hidden>
            🧑‍💻
          </div>
          <div className="mb-4 text-sm uppercase tracking-wide text-slate-400">
            Booting sprite...
          </div>
          <div className="h-2 w-56 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-sky-500 transition-[width] duration-150"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-slate-500">
            {Math.round(progress * 100)}%
          </div>
        </div>
      )}
    </div>
  );
});

export default UnityCanvas;
