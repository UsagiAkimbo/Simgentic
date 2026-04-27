# Sprint A — Unity ↔ Next.js bridge

**Goal:** prove that a Unity WebGL build can run inside the existing Next.js app on a phone browser and receive typed state events from JavaScript. Do this with a single cube that tints a different color per agent state — *before* importing any character art. If the cube changes color on tap, every subsequent sprint is just content.

**Stack:** Unity 6 LTS (6000.0.x), 3D, WebGL target, in-world bubble (that comes in Sprint B).

---

## 1. Create the Unity project

1. Unity Hub → New project → **Universal 3D** (URP) → Unity 6 LTS.
2. Project name: `SpriteAgent`. Location: wherever you keep Unity projects (NOT inside `C:\Projects\Agent` — the Unity project lives separately from the Next.js repo).
3. After it opens, `File → Build Profiles → Web` → **Switch Platform**. Confirm the platform icon in the build profiles window is now Web.

## 2. Add the bridge scripts

From this repo, copy:

| From | To (inside the Unity project) |
| --- | --- |
| `unity-bridge/BridgeReceiver.cs` | `Assets/Scripts/BridgeReceiver.cs` |
| `unity-bridge/SpriteAgentBridge.jslib` | `Assets/Plugins/WebGL/SpriteAgentBridge.jslib` |

Create the `Scripts` and `Plugins/WebGL` folders if they don't exist.

## 3. Build the test scene

In Unity:

1. `File → New Scene → Basic (Built-in)` → save as `Assets/Scenes/Sprint_A_Test.unity`.
2. `GameObject → Create Empty` → rename to `BridgeReceiver` (exact spelling matters — JS calls this name).
3. Drag `BridgeReceiver.cs` onto it.
4. `GameObject → 3D Object → Cube` → rename to `TestCube`. Move it to `(0, 1, 0)` so it sits in front of the camera.
5. Select `BridgeReceiver` → in the Inspector, drag `TestCube` into the `Test Cube Renderer` slot (optional — the script will also find it by name at Awake).
6. `File → Save`.

## 4. Configure WebGL player settings

`File → Build Profiles → Web → Player Settings`:

- **Publishing Settings:**
  - Compression Format: **Gzip**
  - Decompression Fallback: **checked** (this means the loader JS decompresses in-browser if the server doesn't set `Content-Encoding`, so Vercel just serves the files as static). This is the important bit for hassle-free deploys.
  - Data caching: **checked** (IndexedDB cache for returning visitors).
  - Name Files As Hashes: **unchecked** (keeps filenames predictable like `sprite-agent.data`).
- **Resolution and Presentation:**
  - Default Canvas Width: `1080`
  - Default Canvas Height: `1920`
  - Run in Background: **checked**
- **Other Settings:**
  - Color Space: Linear.
  - Auto Graphics API: **checked**, WebGL 2.0 only.
  - Strip Engine Code: **checked**, Managed Stripping Level: **Low** (bump to High once the scene is stable and you've verified nothing breaks).

Then in `Build Profiles` itself:

- Build Name (the prefix for output files): **`sprite-agent`** — this must match the `buildName` prop in `components/UnityCanvas.tsx`.

## 5. First build

`Build Profiles → Build`. Choose a fresh output folder on your disk, e.g. `C:\Unity-Builds\sprite-agent\`. First Unity WebGL build of a new project takes 3–10 minutes; subsequent builds are much faster.

When it finishes you should see (note the `.gz` suffixes — that's correct for Gzip builds):

```
C:\Unity-Builds\sprite-agent\
├── Build/
│   ├── sprite-agent.data.gz
│   ├── sprite-agent.framework.js.gz
│   ├── sprite-agent.loader.js          <-- loader is never compressed
│   └── sprite-agent.wasm.gz
├── StreamingAssets/   (may be absent if you don't use it)
├── TemplateData/
└── index.html         (Unity's default host — we ignore this)
```

If you built with "Disabled" compression instead of Gzip, the files have no `.gz` suffix — in that case, pass `compression="none"` to the `UnityCanvas` component in `app/unity-test/page.tsx`. The default is `"gzip"` to match these docs.

## 6. Copy the build into the Next.js repo

Copy the entire `Build/` folder into `C:\Projects\Agent\public\unity\`. Final structure:

```
C:\Projects\Agent\public\unity\
├── Build\
│   ├── sprite-agent.data.gz
│   ├── sprite-agent.framework.js.gz
│   ├── sprite-agent.loader.js
│   └── sprite-agent.wasm.gz
└── README.md
```

Optional: also copy `StreamingAssets/` alongside `Build/` if Unity produced one.

## 7. Test locally

```powershell
cd C:\Projects\Agent
npm run dev
```

Visit http://localhost:3000/unity-test. You'll hit the password gate first — log in, then the test page renders. Expected timeline:

1. Black canvas with loading bar, progress ticks from 0% to 100% over a few seconds.
2. The scene pops in — you see the cube on a dark background.
3. The top strip changes to "Bridge ready. Tap a state to send it to Unity."
4. Tap each state button in turn. The cube should change color instantly for each.

If the cube visibly changes color per state, **Sprint A is done.** Commit, push, and the same URL works on your phone after Vercel redeploys.

## 8. Commit and deploy

```powershell
cd C:\Projects\Agent
git add public/unity components/UnityCanvas.tsx app/unity-test unity-bridge docs/SPRINT_A.md
git commit -m "sprint a: Unity <-> Next bridge"
git push
```

Vercel will auto-build and deploy. The first deploy with Unity files will take longer — the WebGL bundle is significant. Watch the build log; once it finishes, load `https://simgentic.vercel.app/unity-test` on your phone and repeat the test.

---

## Troubleshooting

**"Failed to load /unity/Build/sprite-agent.loader.js"** — files aren't under `public/unity/Build/`. Check the exact paths. Case matters on Vercel; lowercase everything.

**"Unexpected token '<'" + "Unable to parse /unity/Build/sprite-agent.framework.js! The file is corrupt..."** — the loader is requesting a URL without a compression suffix but the files on disk have `.gz`. Two possible fixes: (1) make sure `UnityCanvas` is using the matching `compression` prop (default is `"gzip"` — don't override unless you built with Disabled/Brotli), or (2) if you did build with Disabled compression, pass `compression="none"` to `<UnityCanvas>` on the test page. This error means a 404 HTML page was returned instead of JS.

**Loader loads but freezes at some % progress** — almost always a compression mismatch. Confirm Decompression Fallback is checked in Player Settings, rebuild, recopy.

**"Bridge ready" fires but taps do nothing** — the `BridgeReceiver` GameObject is misnamed. Re-verify spelling, including capitalization. In Unity, select it, make sure its name in the hierarchy panel reads exactly `BridgeReceiver`.

**Cube doesn't change color but Debug.Log in browser devtools shows "[Bridge] state=..."** — the JSON is reaching C# fine but the cube reference is missing. Select `BridgeReceiver`, wire `TestCube` into the `Test Cube Renderer` slot, rebuild.

**Unity canvas looks tiny on phone** — the CSS makes the canvas fill its container, so the parent `<div>` needs a size. On the test page the outer `<main>` is `min-h-[100dvh]`, which should be fine. If it still looks wrong, verify the viewport meta tag is present (it is — `app/layout.tsx`).

**iOS Safari shows a black canvas that never loads** — usually WebGL 2 / WebAssembly memory. In Player Settings, set Auto Graphics API off, add only WebGL 2.0. Also confirm your iOS version is 16+. If still broken, paste the Safari console error.

**Build size over 30 MB** — in Player Settings, bump Managed Stripping to High, enable IL2CPP Code Generation "Faster (smaller) builds," and remove Unity packages you don't use (Package Manager → remove `com.unity.visualscripting`, any XR packages, etc.). A minimal Sprint A build should be 6–12 MB compressed.

---

## What Sprint A does NOT include

- Any character or animations (Sprint B)
- The real agent stream wired to Unity (Sprint C) — the test page uses buttons, not the SSE feed
- The in-world thought bubble (Sprint B)
- Replacing the existing `/` page (Sprint C)

The v1 experience at `/` still works throughout Sprint A. `/unity-test` is a separate, additive route.
