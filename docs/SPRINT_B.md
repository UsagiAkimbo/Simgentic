# Sprint B — Character, Room, Animator, Thought Bubble

**Goal:** trade the proof-of-bridge cube for an actual character that lives in a small room, animates per agent state, and shows what the agent is "thinking" in an in-world speech bubble. By the end of this sprint, watching the test page should *feel* like watching a Sims-style character react to typed state events. The bridge from Sprint A is unchanged — we only add behavior on the Unity side that consumes its `OnStateChanged` event.

**Stack:** unchanged from Sprint A — Unity 6 LTS, URP, WebGL. New additions: Mecanim Animator Controller, TextMeshPro for the bubble. No new packages required; TMP ships with Unity and prompts a one-time "Import TMP Essentials" the first time you create a TMP component.

---

## 1. Pick a character

Three viable paths depending on what you have on hand. Path A is the fastest to a working scene.

**Path A — Mixamo humanoid (recommended for first pass):**

1. Go to mixamo.com, sign in (free Adobe account).
2. Pick a stylized character — for a "Sims" feel, choose something cartoony like `Ch04`, `Y Bot`, or `Mremireh`. Avoid hyper-realistic ones; they read as uncanny on a small phone screen.
3. Download as FBX with Skin: format **FBX For Unity (.fbx)**.
4. Drop the .fbx into `Assets/Characters/` in your Unity project.
5. Click the imported asset → Inspector → **Rig** tab → Animation Type: **Humanoid**, Avatar Definition: **Create From This Model** → Apply.
6. From Mixamo, download these animations *without* Skin (uncheck the Skin option): `Idle`, `Thinking`, `Looking Around` (for searching), `Reading`, `Talking` (for answering), `Victory` (for done), `Disappointed` (for error). Drop them in `Assets/Animations/`.
7. For each animation: Inspector → **Rig**: Humanoid, Avatar: pick the avatar your character generated in step 5 → Apply. Then in the **Animation** tab, check **Loop Time** for Idle (and any other clip that should cycle).

**Path B — your own humanoid mesh:** same flow, but verify your rig matches Unity Humanoid bone mapping (green checkmarks in the Avatar Configuration window).

**Path C — non-humanoid or 2D-ish character:** use the Generic rig type, or skip animation entirely and swap sprites/materials per state. The `CharacterController` script in step 5 below works either way — only the visual response changes.

---

## 2. Build the room

Keep it minimal. The "Sims feel" comes from character + camera + light, not scenery.

1. New scene → `File → New Scene → Basic (Built-in)` → save as `Assets/Scenes/Sprint_B_Stage.unity`. Keep `Sprint_A_Test.unity` around as a fallback if anything goes sideways.
2. `GameObject → 3D Object → Plane` → rename `Floor`. Scale `(2, 1, 2)`.
3. Create `Assets/Materials/FloorMaterial`. Shader: **URP/Lit** (or **URP/Unlit** for max WebGL compatibility). Pick a warm neutral — soft wood, off-white, dusty pink. Apply to the floor.
4. Optional back wall: `3D Object → Cube`, scale `(8, 4, 0.2)`, place behind the character. Same kind of soft material.
5. **Lighting:** select the existing Directional Light. Rotation `(50, -30, 0)`. Color a warm white (RGB ~`255, 244, 214`). Intensity ~1.2. This is the single most "Sims-feel" knob — warm front-side light flatters everything.
6. Drag your character prefab into the scene at `(0, 0, 0)`. Rotate to face the camera.
7. Select the Main Camera. Position `(0, 1.5, -3)`. Rotation `(10, 0, 0)`. **Field of View 35** — a slight telephoto flatters the character and avoids phone fish-eye. **Background type: Solid Color**, pick a soft sky blue or pastel.
8. **Portrait framing check:** in the Game view, set the resolution dropdown to **1080x1920 Portrait**. The character should be centered with head and upper torso visible. Adjust camera Y / Z until it looks right.

---

## 3. Animator Controller

1. Right-click `Assets/Animations/` → Create → **Animator Controller** → name `SimAgentController`.
2. Drag the controller onto your character GameObject. Unity will populate the existing Animator component (added automatically when you imported a humanoid FBX) with this controller.
3. Double-click the controller to open the Animator window.
4. Drag your **Idle** clip into the graph. Right-click it → **Set as Default Layer State**.
5. Drag in the rest: `Thinking`, `Searching`, `Reading`, `Answering`, `Done`, `Error`.
6. **Parameters tab** (left side) → `+` → add an **Int** parameter named `State`. The values map to the C# AgentState enum: `0=Idle, 1=Thinking, 2=Searching, 3=Reading, 4=Answering, 5=Done, 6=Error, 7=Unknown`.
7. **Wire transitions from Any State** to each clip:
   - Right-click `Any State` → Make Transition → click on `Idle`. Select the resulting arrow → Inspector → Conditions: `State Equals 0`. **Uncheck** Has Exit Time. Transition Duration: `0.1s`. Can Transition To Self: **off**.
   - Repeat: Thinking=1, Searching=2, Reading=3, Answering=4, Done=5, Error=6.
   - Skip Unknown — it stays in whatever the prior state was, which is the right default.
8. Save (Ctrl+S inside the Animator window).

---

## 4. Thought bubble

A world-space Canvas parented to the character, billboarded to the camera, with a TextMeshPro element that shows the current `detail` field.

1. With the character selected, `GameObject → Create Empty Child` → rename `ThoughtBubbleAnchor`. Position above the head — `(0, 1.9, 0)` is right for a typical Mixamo character; adjust for your model's height.
2. Right-click `ThoughtBubbleAnchor` → `UI → Canvas`. Render Mode: **World Space**. Width `400`, Height `200`. Scale `(0.005, 0.005, 0.005)` so it reads at a sane size in world units.
3. Right-click the Canvas → `UI → Image` → rename `BubbleBackground`. Source Image: any built-in rounded sprite (`UISprite` works as a starter). Color: white, full alpha. Anchor: stretched to parent. This is the speech-bubble shape. You can swap in a custom 9-slice sprite later for a tail/balloon look.
4. Right-click the Canvas → `UI → Text - TextMeshPro` → rename `BubbleText`. (If prompted, **Import TMP Essentials** — one-time.) Anchor stretched to parent, padding ~`20` px on all sides. Text color: dark slate (`#1a2332`). **Font size 48** — looks tiny in pixels but the canvas-scale-down makes it read large in world space. **Alignment**: center, middle. **Auto Size**: on (long messages shrink to fit). Default text: empty.
5. Drag the entire Canvas's GameObject into a sensible name like `ThoughtBubble` so the bridge wiring step finds it easily. Initially set it inactive (uncheck the box at the top of the Inspector) — it'll only appear when an active state has a message.

---

## 5. Wire the character to the bridge

Drop these two files into `Assets/Scripts/`. They're already in the repo at `unity-bridge/CharacterController.cs` and `unity-bridge/FaceCamera.cs` — copy the same way you did the Sprint A scripts.

`CharacterController.cs` subscribes to `BridgeReceiver.OnStateChanged` (already exposed in Sprint A's script — no edits needed there) and drives the Animator + bubble:

```csharp
using TMPro;
using UnityEngine;

public class CharacterController : MonoBehaviour
{
    [SerializeField] BridgeReceiver bridge;
    [SerializeField] Animator animator;
    [SerializeField] GameObject thoughtBubble;
    [SerializeField] TMP_Text bubbleText;

    static readonly int StateHash = Animator.StringToHash("State");

    void Awake()
    {
        if (bridge == null) bridge = FindObjectOfType<BridgeReceiver>();
        if (animator == null) animator = GetComponent<Animator>();
    }

    void OnEnable()
    {
        if (bridge != null) bridge.OnStateChanged += HandleStateChanged;
    }

    void OnDisable()
    {
        if (bridge != null) bridge.OnStateChanged -= HandleStateChanged;
    }

    void HandleStateChanged(BridgeReceiver.AgentState state, string detail)
    {
        if (animator != null) animator.SetInteger(StateHash, (int)state);

        if (thoughtBubble != null)
        {
            bool isQuiet = state == BridgeReceiver.AgentState.Idle ||
                           state == BridgeReceiver.AgentState.Done;
            bool show = !isQuiet || !string.IsNullOrEmpty(detail);
            thoughtBubble.SetActive(show);
            if (bubbleText != null)
            {
                bubbleText.text = !string.IsNullOrEmpty(detail)
                    ? detail
                    : DefaultMessageFor(state);
            }
        }
    }

    static string DefaultMessageFor(BridgeReceiver.AgentState s)
    {
        switch (s)
        {
            case BridgeReceiver.AgentState.Thinking: return "Thinking…";
            case BridgeReceiver.AgentState.Searching: return "Searching the web…";
            case BridgeReceiver.AgentState.Reading: return "Reading results…";
            case BridgeReceiver.AgentState.Answering: return "Writing the answer…";
            case BridgeReceiver.AgentState.Done: return "Done!";
            case BridgeReceiver.AgentState.Error: return "Hit a snag.";
            default: return "";
        }
    }
}
```

`FaceCamera.cs` keeps the bubble pointed at the camera every frame:

```csharp
using UnityEngine;

public class FaceCamera : MonoBehaviour
{
    Camera cam;
    void Start() { cam = Camera.main; }
    void LateUpdate()
    {
        if (cam == null) cam = Camera.main;
        if (cam == null) return;
        transform.rotation = cam.transform.rotation;
    }
}
```

In the scene:

- On the **character**: Add Component → `Character Controller` (the script we just made — Unity might shorten it to "Character Controller" but make sure you pick *your* class, not the built-in physics one). Drag the Animator into the Animator slot, the `ThoughtBubble` Canvas GameObject into the Thought Bubble slot, and the `BubbleText` TMP component into the Bubble Text slot. Bridge slot can stay empty — `Awake` finds it by `FindObjectOfType` if not wired explicitly.
- On the **ThoughtBubble Canvas**: Add Component → `Face Camera`.

Save the scene.

---

## 6. Build, copy, deploy

```powershell
# Unity → Build Profiles → Build → output to C:\Unity-Builds\sprite-agent\
# Then in PowerShell:

cd C:\Projects\Agent
# Copy the new Build/ over the old one in public/unity/Build/
Copy-Item -Path C:\Unity-Builds\sprite-agent\Build\* -Destination public\unity\Build\ -Recurse -Force
npm run dev
```

Visit `http://localhost:3000/unity-test`. Expected timeline:

1. Loader → your character standing in the small room (no more cube).
2. "Bridge ready" fires automatically (the Sprint A bridge fix is still in effect).
3. Click **Thinking** → character does its thinking animation, bubble pops in with "Thinking…".
4. Click **Searching** → searching animation, bubble shows the test page's `detail` string ("weather in Phoenix").
5. Click each remaining state — animation + bubble line per state.
6. Click **Idle** → returns to the idle loop, bubble hides.

If all six animated states + bubble work, push to GitHub and verify the same flow on your phone via the Vercel URL. **Sprint B is done.**

```powershell
git add unity-bridge public/unity components/UnityCanvas.tsx app/unity-test docs/SPRINT_B.md
git commit -m "sprint b: character, room, animator, thought bubble"
git push
```

---

## Troubleshooting

**Character T-poses instead of animating** — Animator Controller isn't assigned, or the clips' Avatar setting is `None` instead of your character's avatar. Click each clip → Inspector → Rig → Avatar should match your character's avatar.

**Animations play but limbs bend wrong** — rig type mismatch. Mixamo clips downloaded *with* Skin can drift; download them *without* Skin and re-import as Humanoid.

**Bubble is invisible / black on black** — TMP color and BubbleBackground color are both dark. Pick high contrast: dark text on light bubble, or vice versa.

**Bubble renders behind the character** — world-space Canvas at the same Z as the mesh. Move `ThoughtBubbleAnchor` slightly toward the camera, e.g. `(0, 1.9, -0.3)`.

**Bubble jitters or rolls when the camera moves** — `FaceCamera` runs in LateUpdate and copies the camera's rotation, which keeps it upright. If yours still looks off, ensure the Canvas isn't a child of an animated bone (it would inherit bone rotation). Parent it to `ThoughtBubbleAnchor`, not directly to the head bone.

**Character is tiny / huge after import** — Mixamo characters import at unit-meter scale. If you scaled in the FBX importer, camera framing breaks. Reset character scale to `(1,1,1)` and adjust camera position instead.

**Build size > 30 MB compressed** — bump Player Settings → Managed Stripping Level to **High**. Disable any URP features you're not using (Soft Shadows, MSAA at 4x). A character + simple room build should be 10–18 MB compressed.

**iOS Safari stutters on phone** — animation curves can be expensive in WebGL. Per clip → Inspector → Animation tab → uncheck Mirror and any unused curves; Compression: **Optimal**. Also turn URP Anti-Aliasing down to FXAA or off in the URP Renderer Asset.

**The bridge log shows `[Bridge] state=Thinking` but the character does nothing** — `CharacterController` isn't subscribed. In the Console, look for an "OnStateChanged subscription" or `NullReferenceException`. Confirm the script is attached to the character and the Animator slot is wired.

---

## What this sprint does NOT include

- The real agent stream still isn't wired to Unity. `/unity-test` continues to use the seven-button test panel from Sprint A. The agent → Unity wire is **Sprint C**.
- The v1 page at `/` still works untouched. Replacing it with the Unity-embedded version is **Sprint C**.
- Idle micro-behaviors (blinking, looking around between states, weight shifts), camera tilt, ambient room detail — that's **Sprint D** polish.
- Multiple characters / multiple rooms / scene transitions — out of scope for v2.
