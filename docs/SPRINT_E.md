# Sprint E — Cowork overlay: radial menu, panels, model picker, attachments

**Goal:** wire the Cowork-style UI authored in the Unity scene (radial menu + PlusPanel / ModelPanel / EnviromentPanel) so interactions flow Unity → JS, and make the first features real: model selection, the adaptive-thinking toggle, and File / Folder / Image attachments. Everything else emits a typed event and shows a "Coming soon" toast — the plumbing is in place for future sprints (specialty agents and style environments across the five categories: Personal, Social, Professional, Entrepreneurial, Industrial).

**Design principle:** the scene stays pure layout. `UIOverlayController.cs` adds Button components and click handlers **at runtime** by finding children by name. Re-authoring art in the Editor can never silently drop a handler, and `unity-bridge/` remains the single source of truth.

---

## What was added

| File | Change |
| --- | --- |
| `unity-bridge/UIOverlayController.cs` | NEW. Wires radial spokes + panel icons, manages one-panel-at-a-time visibility, model highlight, thinking Toggle; emits UI events via `JS_OnUiEvent`. |
| `unity-bridge/SpriteAgentBridge.jslib` | Added `JS_OnUiEvent` → forwards parsed JSON to `window.spriteAgent.onUiEvent`. |
| `unity-bridge/BridgeReceiver.cs` | Added `SetUiState(json)` (JS → Unity authoritative model/thinking state) + auto-found `overlayController` reference. |
| `components/UnityCanvas.tsx` | New `onUiEvent` prop; registers/unregisters `window.spriteAgent.onUiEvent`. |
| `app/page.tsx` | UI event router; model + thinking state; hidden file/folder/image pickers; attachment chips; toast; pushes `SetUiState` to Unity on boot and on change. |
| `app/api/agent/route.ts` | Accepts `model` (allowlist), `thinking` (extended thinking, supported models only), `attachments` (text + image blocks, server-side caps). |

## Event protocol (Unity → JS)

`{ "action": "...", "value": "..." }` via `JS_OnUiEvent`:

| Action | Source | Host behavior |
| --- | --- | --- |
| `model.select` | ModelPanel icons | Sets request model; toast |
| `thinking.toggle` | ModelPanel Toggle | Sets extended-thinking flag |
| `add.file` / `add.folder` / `add.image` | PlusPanel | Opens hidden file picker; files become attachment chips, sent with next message |
| `conversation.new` | RadialMenu_New | Clears history (same as the + button) |
| `camera.toggle` | RadialMenu_Hand | Flips default/focused camera framing |
| `panel.toggle` | any spoke | No-op host-side (informational) |
| `connector.open`, `skill.open`, `plugin.open`, `env.*` | PlusPanel / EnviromentPanel | "Coming soon" toast — future sprints |

Radial spokes: Brain → ModelPanel, File → PlusPanel, Desk → EnviromentPanel, New → new conversation, Hand → camera toggle.

JS → Unity: `SendMessage("BridgeReceiver", "SetUiState", '{"model":"claude-sonnet-4-5","thinking":"on"}')` keeps Unity highlights in sync (uses `SetIsOnWithoutNotify` — no echo loop).

## Model lineup

Defined in THREE places that must stay in sync (each file says so in a comment):

- `ModelIconToId` in `unity-bridge/UIOverlayController.cs` (icon name → id)
- `MODEL_LABELS` in `app/page.tsx` (id → toast label)
- `ALLOWED_MODELS` in `app/api/agent/route.ts` (id → `{thinking}` allowlist; unknown ids fall back to the default instead of erroring)

⚠️ `claude-3-opus-20240229` is a legacy model and may be retired from the API — if it errors, swap the 3_Opus icon's entry for a current model in all three places.

## Unity Editor setup (one-time)

1. Open `Sprint_B_Stage.unity`.
2. Select **OverlayCanvas** → Add Component → **UIOverlayController**. (It adds a GraphicRaycaster itself if missing; EventSystem already exists in the scene.)
3. Hierarchy names must match the constants in UIOverlayController.cs — they already do as of today. If you rename icons, update the dictionaries.
4. Optional: drag OverlayCanvas into BridgeReceiver's **Overlay Controller** slot (auto-found at Awake otherwise).
5. Panels are force-hidden at Awake; leave them visible in the Editor for authoring.

## Rebuild checklist

All current `unity-bridge/` files were copied to `D:\Unity Projects\Simgentic` on 2026-06-10 (Assets/Scripts + Assets/Plugins/WebGL). On every future rebuild: **copy ALL of unity-bridge/, not just changed files** (see SPRINT_D Phase 1 for why).

1. Editor setup above, then File → Build Profiles → Web → Build.
2. Copy build output to `public/unity/Build/` (names `sprite-agent.*`, `.unityweb` compression).
3. Hard reload `/`.

## Test checklist

- Tap each radial spoke: Brain/File/Desk open their panel (one at a time); New clears the conversation; Hand moves the camera.
- Pick a model → toast shows the name, icon highlights, DevTools Network shows `model` in the `/api/agent` payload.
- Toggle thinking → payload has `thinking: true`; status bubble shows "Thinking...".
- PlusPanel File/Folder/Picture → OS picker opens; chips appear; send a message asking about the attached file.
- Connector/Skill/Plugin and all EnviromentPanel icons → "Coming soon" toast.
- Type in the input — still no focus theft (JS shim + C# fix both present).

## Not in this sprint

Connector/skill/plugin functionality, all EnviromentPanel features (Project, Dispatch, Live Artifacts, Memory, Progress, Scheduled, Customize, Context), persistence, and the specialty-agent/environment system itself. The event vocabulary above is the foundation those will build on.
