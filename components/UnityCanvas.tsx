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

declare global {
  interface Window {
    createUnityInstance?: CreateUnityInstance;
    spriteAgent?: {
      onUnityReady?: () => void;
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
  const onErrorRef = useRef(onError);
  const onProgressRef = useRef(onProgress);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onProgressRef.current = onProgress;
  }, [onReady, onError, onProgress]);

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
      if (window.spriteAgent) window.spriteAgent.onUnityReady = undefined;
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
