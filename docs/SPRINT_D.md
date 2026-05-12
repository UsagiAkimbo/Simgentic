# Sprint D — Polish, conversation, life

**Goal:** v2 works end-to-end after Sprint C, but it's still a stiff prototype: every question is a one-shot interaction, the character is statue-still between requests, the JS focus workaround from Sprint C is now redundant dead code, and the Unity bundle hasn't been audited for size. Sprint D is the polish pass that makes the experience feel intentional. By the end of this sprint the character has small idle behaviors that signal it's *waiting* rather than *frozen*, conversations carry context across turns, the user can start a fresh conversation without reloading, and the Unity bundle is tightened for fast load on cellular networks.

**Stack:** unchanged. No new dependencies. Some changes touch Next.js (`app/page.tsx`, `app/api/agent/route.ts`, `components/UnityCanvas.tsx`), some touch Unity C# (`unity-bridge/CharacterController.cs`), and one phase is purely Player Settings tweaks in the Unity Editor.

The sprint is broken into five phases. Each is independent — you can ship them in any order, and any one of them improves the product on its own. Recommended order is the one below: smallest blast radius first.

---

## Phase 1: Drop the JS focus workaround

**Why:** in Sprint C we added a JavaScript shim in `components/UnityCanvas.tsx` that intercepted keyboard events at window capture phase and patched the canvas's `focus()` method, all to work around `WebGLInput.captureAllKeyboardInput = true` stealing focus from the input field. After the C# fix shipped (`WebGLInput.captureAllKeyboardInput = false` in `BridgeReceiver.Start()`), Unity no longer steals focus, and the JS shim is doing redundant work on every keystroke. Time to delete it.

**Risk:** very low if your last Vercel deploy used a Unity build that contains the C# fix. Confirm by inspecting the deployed `sprite-agent.framework.js.unityweb` — it should contain the string `captureAllKeyboardInput`. If not, rebuild Unity first, then drop the JS shim.

**Change:** in `components/UnityCanvas.tsx`, delete the entire `useEffect` block that begins with the comment `// Unity WebGL defaults to WebGLInput.captureAllKeyboardInput = true...` and ends with the cleanup return. That's the only change to that file. Keep the callback-stabilization refs and the boot effect — those are still load-bearing.

After deleting, hard reload `/`, tap the input, type a character. If a character appears, you're done with Phase 1.

---

## Phase 2: Multi-turn conversation history

**Why:** v1 and v2 today both treat each question as completely fresh. "What's the weather in Phoenix?" → "Will I need a jacket?" produces a useless response because the agent has no memory of Phoenix. Multi-turn history lets follow-ups work the way users expect from chat.

**Server change** — `app/api/agent/route.ts`:

Extend the request body shape to optionally accept an array of prior turns, and prepend it to the messages sent to Anthropic.

```ts
// Add to the body validation block, after parsing message:
const rawHistory = (await req.json()) as {
  message?: unknown;
  history?: unknown;
};

const history: Array<{ role: "user" | "assistant"; content: string }> =
  Array.isArray(rawHistory.history)
    ? rawHistory.history
        .filter(
          (h: unknown): h is { role: "user" | "assistant"; content: string } =>
            !!h &&
            typeof h === "object" &&
            "role" in h &&
            "content" in h &&
            (h.role === "user" || h.role === "assistant") &&
            typeof h.content === "string" &&
            h.content.length > 0
        )
        .slice(-20) // cap to last 20 turns to bound prompt growth
    : [];

// Then in the messages.stream call:
messages: [
  ...history,
  { role: "user", content: userMessage },
],
```

The existing `body.message` parse already gates on string + non-empty. Just thread `history` through alongside it. The 20-turn cap protects the prompt from growing unboundedly across long sessions.

**Client change** — `app/page.tsx`:

Add a `history` state, send it on every request, and append `(user, assistant)` pairs after each successful run.

```ts
type Turn = { role: "user" | "assistant"; content: string };
const [history, setHistory] = useState<Turn[]>([]);

// Inside run(message), accumulate the assistant's reply locally so we can
// append it to history once the stream finishes:
const run = useCallback(async (message: string) => {
  setRunning(true);
  setErrorMsg(null);
  setAnswer("");
  setPanelOpen(true);
  sendUnity(unity.current, "thinking");

  let accumulated = "";
  let didFinish = false;
  const controller = new AbortController();
  abortRef.current = controller;

  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, history }),  // <-- include history
      signal: controller.signal,
    });
    // ... existing reader loop ...
    // Inside the SSE handler:
    //   case "text":   accumulated += frame.delta; setAnswer(accumulated); break;
    //   case "done":   didFinish = true; sendUnity(unity.current, "done"); break;
  } catch (err) { /* ... */ }
  finally {
    setRunning(false);
    abortRef.current = null;
    if (didFinish && accumulated) {
      setHistory((prev) => [
        ...prev,
        { role: "user", content: message },
        { role: "assistant", content: accumulated },
      ]);
    }
  }
}, [history]);
```

The `useCallback` dependency on `history` is intentional: each new turn captures the latest history. The cost is one ref re-creation per turn, which is negligible.

**Test:** ask `what's the weather in Phoenix today?`, wait for the answer, then ask `will I need a jacket?`. The second answer should reference Phoenix's weather rather than asking which city you mean.

---

## Phase 3: New Conversation button

**Why:** once history is in place, the user needs a way to clear it. Without that the conversation grows until you hit the 20-turn cap or until topics get tangled. The button is also a small "reset" UX affordance — tap it, character returns to idle, panel clears, you're starting fresh.

**Change** — `app/page.tsx`:

Add a small icon button in the input bar (left of the text field), only visible when `history.length > 0` so it doesn't clutter the empty state.

```tsx
function onNewConversation() {
  abortRef.current?.abort();         // stop any in-flight request
  setHistory([]);
  setAnswer("");
  setErrorMsg(null);
  setPanelOpen(false);
  sendUnity(unity.current, "idle");  // character returns to idle pose
}

// Inside the form, before the <input>:
{history.length > 0 && !running && (
  <button
    type="button"
    onClick={onNewConversation}
    aria-label="Start a new conversation"
    className="h-12 w-12 shrink-0 rounded-full border border-white/10 bg-slate-900 text-slate-400 hover:text-slate-200"
  >
    +
  </button>
)}
```

A `+` glyph is intentionally minimal — recognizable as "new" without needing an icon library. Replace with a Lucide icon later if you want.

---

## Phase 4: Character idle micro-behaviors

**Why:** the most expensive thing about a static character is that it reads as broken. A few cheap behaviors during idle — blinks, weight shifts, occasional head turns — flip the read instantly from "frozen" to "waiting." This is the single change in Sprint D that most affects how alive the character feels.

**C# change** — `unity-bridge/CharacterController.cs`:

Add a tracked `currentState` and an `Update` loop that fires animator triggers on randomized intervals while the state is Idle.

```csharp
[Header("Idle micro-behavior intervals (seconds)")]
[SerializeField] float blinkMin = 2.5f;
[SerializeField] float blinkMax = 5.5f;
[SerializeField] float shiftMin = 8f;
[SerializeField] float shiftMax = 18f;

static readonly int BlinkHash = Animator.StringToHash("Blink");
static readonly int ShiftHash = Animator.StringToHash("Shift");

BridgeReceiver.AgentState currentState = BridgeReceiver.AgentState.Idle;
float nextBlinkAt;
float nextShiftAt;

void Start()
{
    nextBlinkAt = Time.time + Random.Range(blinkMin, blinkMax);
    nextShiftAt = Time.time + Random.Range(shiftMin, shiftMax);
}

// Inside HandleStateChanged, add as the first line:
//     currentState = state;

void Update()
{
    if (animator == null) return;
    if (currentState != BridgeReceiver.AgentState.Idle) return;

    if (Time.time >= nextBlinkAt)
    {
        animator.SetTrigger(BlinkHash);
        nextBlinkAt = Time.time + Random.Range(blinkMin, blinkMax);
    }
    if (Time.time >= nextShiftAt)
    {
        animator.SetTrigger(ShiftHash);
        nextShiftAt = Time.time + Random.Range(shiftMin, shiftMax);
    }
}
```

**Animator setup in Unity:**

1. Open `SimAgentController` in the Animator window.
2. Parameters tab → add two new **Trigger** parameters: `Blink` and `Shift`.
3. Right-click `Idle` → Make Transition → click the same `Idle` (a self-transition). Select the arrow → Conditions: `Blink` (trigger). Has Exit Time: **off**. Transition Duration: 0.05s.
4. Repeat for `Shift` — same Idle-to-Idle self-transition, condition `Shift`.
5. Optionally: drag in subtle blink and weight-shift animation clips and route the triggers to those instead of self-transitions. If you don't have those clips yet, the trigger just consumes silently — no crash, no warning. You can add the clips later without touching code.

The Mixamo library has both `Blink` (very short eye-close) and `Idle Weight Shift` if you want to grab them while you're there. Both are tiny downloads.

**Optional enhancement:** if you want occasional head-turns ("looking around" — the agent is patient but not bored), add a third trigger `Glance` with a 20–40 second interval, and wire it the same way. The character's micro-vocabulary scales linearly with how many of these you add.

---

## Phase 5: Unity build size & performance audit

**Why:** the current build is probably 15–25 MB compressed. On cellular this is a 5–10 second load before the character appears. With aggressive stripping and a few URP knobs, you can usually halve this without losing any visual quality the user can perceive at phone size.

**Player Settings → Other Settings:**

- **Managed Stripping Level**: bump from Low to **High**. This is the single biggest win — strips unused engine code aggressively. Test thoroughly after the change; if anything breaks (rare for our Sprint A–C surface area), drop back to Medium.
- **Strip Engine Code**: confirm checked.
- **IL2CPP Code Generation**: **Faster (smaller) builds**.
- **Compression Format**: stay on the same option you're using (`.unityweb` per current build); no change.

**Player Settings → Publishing Settings:**

- **Decompression Fallback**: stay checked (Vercel doesn't set Content-Encoding for us).
- **Data caching**: checked (returning visitors get IndexedDB cache, much faster reload).

**URP Renderer Asset (`Mobile_Renderer` if you used Sprint B's defaults):**

- **HDR**: **off** for phone. Saves a render target.
- **Anti Aliasing (MSAA)**: **off** or **2x**. Off is fine at phone DPI.
- **Post Processing**: **off** unless you actively use a post FX in your room. The default URP pipeline includes the Edge Adaptive Spatial Upsampling shader you've been seeing in console errors — turning post-processing off makes that warning go away too.
- **Soft Shadows**: **off** for phone. Hard shadows look fine and cost much less.

**Package Manager:**

- Open Window → Package Manager → In Project. Remove anything you're not actively using: `com.unity.visualscripting`, any XR packages, `com.unity.timeline` if you don't use Timeline, `com.unity.cinemachine` if you don't use it. Each of these adds 200KB–2MB to the wasm.

**Test the new build size:**

```powershell
cd C:\Unity-Builds\sprite-agent\Build
dir   # check the file sizes — aim for <12 MB total compressed
```

A trimmed Sprint D build should land in the 8–14 MB range depending on how much character/animation content you've imported. If it's still above 20 MB, the culprit is usually animation curves or texture sizes — audit `Assets/Animations/` (set Compression to Optimal on each clip) and `Assets/Characters/` (texture max size 1024 or 512 for phone-only).

---

## Optional Phase 6: Camera tilt parallax (stretch)

**Why:** very Sims-like, free polish, makes the scene feel three-dimensional when you tilt your phone. Skip this entirely if you want to ship Sprint D faster.

**The shape of the change:**

1. Client (`app/page.tsx` or a new `hooks/useDeviceOrientation.ts`): listen to `DeviceOrientationEvent`. iOS Safari requires `DeviceOrientationEvent.requestPermission()` from a user gesture — usually a one-time tap. Throttle to 30 Hz, send `{tiltX, tiltY}` to Unity via a new `SetCameraTilt` SendMessage call.

2. C# (`unity-bridge/CameraTilt.cs`, new): a small MonoBehaviour on the Main Camera that lerps the camera's `localPosition` and `localRotation` toward the tilt-driven target each Update. Tilt range ±5° in rotation, ±0.15m in position is usually enough — much more and the room walls misalign.

3. Bridge (`unity-bridge/BridgeReceiver.cs`): add a `SetCameraTilt(string json)` method that parses `{x, y}` and forwards to the CameraTilt component via a public field reference or a UnityEvent.

I'm leaving the actual implementation as a sketch for this sprint because (a) it's truly optional, and (b) it's the only Sprint D phase that touches the bridge protocol — worth doing carefully when you're ready, not as a rushed addition. Ping me when you want it and I'll write it out.

---

## 7. Test, ship

After each phase, hard reload `/` and run through the checklist:

- **Phase 1**: type into the input. Characters appear. (No focus theft.)
- **Phase 2**: ask a question with a Phoenix-style follow-up. Second answer references the first.
- **Phase 3**: tap the `+` button after a conversation. History clears, character returns to Idle, answer panel collapses.
- **Phase 4**: leave the page sitting on Idle for a minute. Character blinks every few seconds, occasional weight shift. (If your Animator triggers aren't wired, no visible change but no crash either — the triggers just consume.)
- **Phase 5**: load the page on cellular (or throttle in DevTools → Network → Slow 4G). Time to first character should be under 8 seconds.

Then commit and push:

```powershell
cd C:\Projects\Agent
git add app components/UnityCanvas.tsx unity-bridge docs/SPRINT_D.md public/unity
git commit -m "sprint d: polish — drop focus shim, multi-turn history, new convo button, idle behaviors, build trim"
git push
```

After Vercel redeploys, run the same checklist on your phone. If it all passes — **v2 is feature-complete**.

---

## Troubleshooting

**Multi-turn answers ignore prior context** — the `history` array isn't reaching the API. Open DevTools → Network → click the `/api/agent` request → Payload tab. The body should have `{message, history: [...]}`. If `history` is missing, the client isn't passing it. If it's present but the answer ignores it, the server isn't using it — confirm the `messages: [...history, ...]` change in the route handler.

**New Conversation button doesn't make the character return to idle** — `sendUnity(unity.current, "idle")` is firing but Unity's Animator doesn't have an Idle transition from Done/Error/etc. Confirm `Any State → Idle (State Equals 0)` exists and Has Exit Time is off.

**Character blinks during Thinking/Searching/etc.** — `currentState` isn't being updated in `HandleStateChanged`. Confirm `currentState = state;` is the first line of that method.

**Build size dropped below 8 MB but the character looks oddly washed-out / shadow-less** — Phase 5 turned off HDR and Soft Shadows. That's expected; verify by toggling Soft Shadows back on temporarily and rebuilding. If the difference matters at phone size, leave Soft Shadows on and accept the build size hit.

**Phone shows "Unity failed to start" after Phase 5 build** — Managed Stripping High removed something the bridge needs. Drop to Medium, rebuild, retest.

---

## What this sprint does NOT include

- **Voice input or audio output.** Out of scope for v2.
- **Persistent conversation history across page reloads.** Sprint D's history lives in React state only; reloading the page clears it. If you want sessions to persist, that's localStorage + load-on-mount — straightforward but adds an SSR/hydration consideration. Defer to v3.
- **Multiple characters or scene switching.** Out of scope.
- **Mobile keyboard handling for the answer panel scroll.** If the keyboard pops up while the answer panel is open and content gets clipped, the fix is a `dvh`-aware max-height on the panel — small change, but worth doing only if it's actually annoying in practice.
- **Analytics, error tracking, or telemetry.** v3 territory.
- **The camera tilt stretch from Phase 6.** Optional within Sprint D itself; ping me when you want it.
