# Sprite Agent — v1

A mobile-first prototype of a sprite-based UI for an AI agent. Instead of a chat, you see a character with a thought bubble that narrates what it's doing as it streams — "Thinking…", "Searching the web for …", "Answering…" — then the result renders in a panel below.

- **Stack:** Next.js (App Router, TypeScript), Tailwind CSS, `@anthropic-ai/sdk`
- **Model:** `claude-sonnet-4-5` with the `web_search_20250305` tool
- **Transport:** Server-Sent Events from a Next.js route handler
- **Auth:** single shared password stored in `APP_PASSWORD`; httpOnly cookie set after login

## Run locally

```bash
# 1. Install
npm install

# 2. Create your env file
cp .env.local.example .env.local
#    then edit .env.local and fill in ANTHROPIC_API_KEY + APP_PASSWORD

# 3. Start the dev server
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/login`. Enter the password you set in `APP_PASSWORD`, then try a task like `what's the weather in Phoenix right now`.

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Get one at https://console.anthropic.com/settings/keys |
| `APP_PASSWORD` | yes | Anyone with this password can use the app. Use something long and random outside of local dev. |

`.env.local` is gitignored. Never commit real secrets.

## Deploy to Vercel

1. Push this repo to GitHub (see next section if you don't have a repo yet).
2. Go to https://vercel.com/new and import the repo.
3. Vercel auto-detects Next.js — leave the framework preset, build command, and output directory alone.
4. Before the first deploy, expand **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` → your real key
   - `APP_PASSWORD` → your real password
   Set both for all three environments (Production, Preview, Development) unless you want them to differ.
5. Click **Deploy**. You'll get a `https://<project>.vercel.app` URL when it finishes.
6. Open the URL on your phone, enter the password, and give the sprite a task.

If you need to change env vars after deploying, go to **Project → Settings → Environment Variables**, update, and redeploy (Deployments → the latest → Redeploy).

### Pushing to GitHub first

```bash
git init
git add .
git commit -m "Sprite Agent v1"
# create an empty repo at https://github.com/new, then:
git remote add origin git@github.com:<you>/<repo>.git
git branch -M main
git push -u origin main
```

Double-check that `.env.local` is NOT in the commit — `.gitignore` already excludes it, but grep the output of `git status` anyway.

## How it works

- `app/page.tsx` renders the sprite, bubble, and input. It POSTs each task to `/api/agent` and parses the SSE response stream, updating the bubble's label and appending text deltas into the answer panel.
- `app/api/agent/route.ts` calls `client.messages.stream()` with the `web_search_20250305` tool, maps Anthropic events (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_stop`) to typed SSE frames, and writes them to a `ReadableStream`.
- `app/api/auth/route.ts` + `middleware.ts` implement the password gate. Login sets `sprite_auth` (httpOnly, 30-day) to the SHA-256 of the password; middleware recomputes and compares on every non-public request.

## Mobile notes

- Viewport is configured to avoid Safari zoom on inputs.
- Bottom input uses `env(safe-area-inset-bottom)` so it doesn't sit under the iPhone home indicator.
- Primary tap targets are 44×48 px or larger.
- Portrait is the priority; landscape works but isn't tuned.

## What's deliberately NOT in v1

- Task history / running log
- Multiple sprites or characters
- Any tools beyond `web_search`
- User accounts (just the shared password)
- Persistence of any kind
- A database

These are v2 material.
"# Simgentic" 
