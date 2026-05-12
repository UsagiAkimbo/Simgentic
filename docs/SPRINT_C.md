# Sprint C — Wire the agent stream to the character

**Goal:** retire the seven test buttons. Replace them with the existing `/api/agent` SSE feed so the character built in Sprint B reacts to **real** agent activity — thinking, searching the user's actual query, reading, answering — driven by a question the user types. By the end of this sprint the home page (`/`) is the Unity-embedded experience, and the v1 sprite version moves to `/classic` as a fallback.

**Stack:** unchanged. The Unity scene from Sprint B stays exactly as-is. Sprint C is entirely on the Next.js side: a new page that parses the SSE stream the same way `app/page.tsx` already does, but instead of pushing labels into a React `<ThoughtBubble />`, it pushes them into Unity via `unity.current.sendMessage(...)`.

```
[user types question]
         │
         ▼
   POST /api/agent  ──► Anthropic + web_search ──► SSE frames stream back
         │
         ▼
   parse SSE in React ──► map each frame to:
                              ├── unity.sendMessage("BridgeReceiver", "SetAgentState", {state, detail})
                              └── append text deltas to the answer panel
```

The bridge contract from Sprint A is the only API between the agent and the character — no new C# needed, no Unity rebuild required. This sprint only touches Next.js code.

---

## 1. Map SSE frames to Unity state

The existing `/api/agent` route emits four frame types. Map them as follows:

| SSE frame                                          | Unity state | Bubble `detail`                          | Answer panel              |
|----------------------------------------------------|-------------|------------------------------------------|----------------------------|
| `{type:"status", label:"Thinking..."}`             | `thinking`  | (empty — character uses default)         | unchanged                  |
| `{type:"status", label:"Searching the web for \"X\"..."}` | `searching` | `X` (the query, extracted via regex)     | unchanged                  |
| `{type:"status", label:"Searching the web..."}`    | `searching` | (empty)                                  | unchanged                  |
| `{type:"status", label:"Reading results..."}`      | `reading`   | (empty)                                  | unchanged                  |
| `{type:"status", label:"Answering..."}`            | `answering` | (empty)                                  | begins receiving deltas    |
| `{type:"text", delta:"..."}`                       | (unchanged) | (unchanged)                              | append `delta`             |
| `{type:"done"}`                                    | `done`      | (empty — character uses default)         | finalized                  |
| `{type:"error", message:"..."}`                    | `error`     | the error message                        | error displayed            |

Two design decisions worth flagging up front:

**Bubble shows the activity, panel shows the answer.** The thought bubble in Sprint B was for short status text. The actual streamed answer can be dozens of paragraphs — too much for a floating world-space label. So the bubble keeps showing "Writing the answer…" while the answer streams into a separate slide-up panel below the Unity canvas. After `done`, the bubble auto-hides (Sprint B's `CharacterController.HandleStateChanged` already does this for Idle/Done with no detail) and the panel stays open for reading.

**No idle state is sent during a run.** Once you submit, the character moves Thinking → Searching → Reading → Answering → Done. Idle is the resting state when no query is in flight; the character returns to it when the user dismisses the answer panel or starts a new question.

---

## 2. Build the new `/agent` page

Create `app/agent/page.tsx`. This is the Unity-embedded version. We're building it at a *new* route first so v1 stays as a known-good fallback while we test. The route swap happens in step 5.

The file is already in the repo at `app/agent/page.tsx`. The structure is:

```
app/agent/page.tsx
├── parses SSE the same way app/page.tsx does
├── mounts UnityCanvas (same Sprint B build, same buildPath/buildName)
├── on each status frame → unity.sendMessage("BridgeReceiver", "SetAgentState", {state, detail})
├── on each text delta → setAnswer(prev => prev + delta)
├── input bar fixed at the bottom (slides with iOS keyboard)
└── slide-up answer panel (collapsible) when answer is non-empty
```

The label-to-state mapper is the only piece worth highlighting because it has to match the labels from `app/api/agent/route.ts` exactly:

```ts
function frameToUnityState(label: string): { state: string; detail: string } {
  // Match in order — searching has the longest prefix and a query embedded.
  const search = label.match(/^Searching the web for "(.+)"/);
  if (search) return { state: "searching", detail: search[1] };
  if (label.startsWith("Searching the web")) return { state: "searching", detail: "" };
  if (label.startsWith("Reading"))            return { state: "reading",   detail: "" };
  if (label.startsWith("Answering"))          return { state: "answering", detail: "" };
  if (label.startsWith("Thinking"))           return { state: "thinking",  detail: "" };
  if (label.startsWith("Done"))               return { state: "done",      detail: "" };
  return { state: "thinking", detail: label };
}
```

Anything that doesn't match a known prefix falls through to `thinking` with the raw label as the detail — so unknown labels still produce *some* visual reaction rather than going silent.

---

## 3. Mobile layout

The page uses portrait phone screens as the primary canvas. The layout:

```
┌──────────────────────────────┐
│                              │
│                              │
│        Unity scene           │  60% of viewport
│   (character + bubble)       │
│                              │
│                              │
├──────────────────────────────┤
│  Answer panel (slides up     │  expands when answer
│  from collapsed state)       │  is non-empty; tap to
│                              │  toggle expanded
├──────────────────────────────┤
│  [   ask the sprite...   ][▶]│  sticky input bar
└──────────────────────────────┘
```

- The Unity canvas always occupies a tall portion at the top so the character is the dominant visual.
- The input bar is `position: sticky` at the bottom with `padding-bottom: calc(env(safe-area-inset-bottom) + 1rem)` — same pattern as v1, handles iOS notches and the dynamic keyboard.
- The answer panel is a collapsible drawer between Unity and the input. When closed it shows a 1-line teaser; when expanded it scrolls. Tap to toggle.
- The `Stop` button replaces `Go` while a request is in flight, identical to v1.

---

## 4. Stop, error, and reset behavior

The abort controller pattern from `app/page.tsx` carries over directly. When the user hits **Stop**:

1. `controller.abort()` is called.
2. The `for await` loop in `/api/agent/route.ts` sees `req.signal.aborted` and breaks.
3. The fetch's `AbortError` is caught on the React side.
4. We send `unity.sendMessage("BridgeReceiver", "SetAgentState", {state: "idle", detail: ""})` so the character returns to Idle and the bubble hides.
5. The answer panel keeps whatever text already streamed in — the user can still read what got partway done.

On `error` frames: send `state: "error", detail: <message>` to Unity (character does the disappointed/shrug animation, bubble shows the error), and surface the error in the answer panel with a red tint.

When the user starts a new question while the previous answer panel is open: clear the panel, set Unity to `thinking`, kick off a new request. Nothing fancy — just the same `run(message)` flow as v1.

---

## 5. Test

```powershell
cd C:\Projects\Agent
npm run dev
```

Visit `http://localhost:3000/agent` (note the new route — `/` is still v1). Log in, wait for the Unity character.

Type a question that exercises web search, e.g. **"what's the weather in Phoenix today?"**. Watch the timeline:

1. Character flips to Thinking, bubble shows the default "Thinking…" label.
2. Bubble updates to `weather in Phoenix` while the search runs (extracted from the label by the regex above).
3. Character flips to Reading once results come back, bubble shows "Reading results…".
4. Character flips to Answering, bubble shows "Writing the answer…", and the slide-up panel begins receiving streamed text.
5. On `done`, the character does the Done animation, the bubble hides, the panel stays open with the full answer.

Try a non-search question too, e.g. **"explain how RNAi works in two paragraphs"** — should skip Searching/Reading and go straight from Thinking to Answering. The character should still animate through the appropriate states cleanly.

Test **Stop**: type a long question, hit Stop mid-stream. Character should return to Idle, partial answer stays visible, no console errors.

Test **error**: temporarily delete `ANTHROPIC_API_KEY` from `.env.local`, restart `npm run dev`, submit a question. The page should show the error in the panel and the character should do the Error animation.

If all three flows look right on desktop *and* on your phone (via the LAN IP that `next dev` prints, or by pushing to Vercel and testing the preview URL), Sprint C's core is done.

---

## 6. Swap routes (`/agent` → `/`, v1 → `/classic`)

Once `/agent` is verified working end-to-end:

```powershell
cd C:\Projects\Agent

# Move v1 home page to /classic so it's preserved as a fallback
mkdir app\classic
git mv app\page.tsx app\classic\page.tsx

# Move the new Unity-embedded page to /
git mv app\agent\page.tsx app\page.tsx

# Empty agent/ folder can be deleted
Remove-Item app\agent
```

Now `/` is the Unity experience and `/classic` is the v1 sprite UI. Both routes still go through the auth middleware — the password gate is unchanged.

---

## 7. Build, commit, deploy

```powershell
cd C:\Projects\Agent
git add app middleware.ts docs/SPRINT_C.md
git commit -m "sprint c: agent stream wired to Unity character; v1 moved to /classic"
git push
```

Vercel auto-deploys. After it finishes, load `https://simgentic.vercel.app/` on your phone and run through the same three test cases (search question, non-search question, Stop). If the phone session is identical to localhost, **Sprint C is done.**

---

## Troubleshooting

**Character animates but bubble shows raw labels like "Reading results..."** — the label-to-state mapper is matching but not stripping the label from the detail field. Either pass an empty string as detail (the character uses the default message from Sprint B), or trim the suffix dots from the label.

**Answer panel never opens** — check the `running` and `answer` state in DevTools. The panel should appear when `answer.length > 0`. If `answer` is empty during streaming, the SSE parser isn't picking up `text` deltas — usually a frame parsing bug; log every parsed frame to confirm.

**Search query doesn't appear in the bubble** — the regex `/^Searching the web for "(.+)"/` requires the API to send the labeled form `Searching the web for "X"...`. Check `/api/agent/route.ts` line ~138; that's the canonical label format. If you've customized it, update the regex to match.

**Character stays stuck in a state after `done`** — `CharacterController.HandleStateChanged` got a Done event but the Animator's `Any State → Done` transition isn't wired. Open `SimAgentController.controller`, confirm Any State has a transition to Done with `State Equals 5`. Or: the SSE stream errored before `done` fired, in which case the character will sit in whatever state it was last in. Check the Network tab for a stalled response.

**Mobile keyboard pushes Unity offscreen** — the Unity `<canvas>`'s parent needs a flexible height (e.g. `flex: 1` inside a `min-h-[100dvh]` parent). If you used a fixed `height: 60vh`, the keyboard overlay shrinks the visible area but Unity stays its original size and gets clipped. Use `dvh` units (`100dvh`, `60dvh`) — they account for the dynamic visible viewport on mobile Safari and Chrome.

**Two simultaneous requests interfere** — the input is supposed to be `disabled` during `running`. If you see overlapping responses, an old `AbortController` reference is leaking. Confirm `abortRef.current = controller` runs before the fetch, and `abortRef.current = null` runs in the `finally`.

**Vercel build fails on the new page** — TypeScript usually catches the issues locally first. Run `npm run build` before pushing if Vercel keeps failing; the local error message is identical.

---

## What this sprint does NOT include

- Idle micro-behaviors (blinking, weight shifts, looking around between requests). That's **Sprint D** polish.
- Multi-turn conversation history. Each question is a fresh agent call with no memory of the previous one. Adding turn history is straightforward — accumulate `messages` in client state, pass the full array to the API — but explicitly punted from Sprint C to keep the bridge change minimal.
- Voice input or audio output. Out of scope for v2.
- Metrics, analytics, conversation logging. Out of scope for v2.
- A "new conversation" button or panel-clearing UX beyond submitting a new question. Sprint D.
