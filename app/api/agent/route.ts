import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// The `web_search_20250305` server tool was added to the API in May 2025.
// Older SDK versions may not have the type in their `Tool` union, so we
// declare the shape explicitly and cast at the call site.
type WebSearchTool = {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

// Sprint E: models the Unity ModelPanel can select. Keys must match
// ModelIconToId in unity-bridge/UIOverlayController.cs and MODEL_LABELS in
// app/page.tsx. `thinking` marks models that accept the extended-thinking
// parameter — for the rest the flag is silently ignored.
const ALLOWED_MODELS: Record<string, { thinking: boolean }> = {
  "claude-3-opus-20240229": { thinking: false },
  "claude-haiku-4-5": { thinking: true },
  "claude-sonnet-4-5": { thinking: true },
  "claude-opus-4-6": { thinking: true },
  "claude-opus-4-7": { thinking: true },
};

const THINKING_BUDGET_TOKENS = 4096;
const MAX_TOKENS_WITH_THINKING = 8192; // must exceed the thinking budget

type SseFrame =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };

// One conversation turn. Mirrors the Turn type in app/page.tsx.
type Turn = { role: "user" | "assistant"; content: string };

// Cap how many turns we accept from the client. 20 keeps the prompt bounded
// even on long sessions; older turns get dropped silently.
const MAX_HISTORY_TURNS = 20;

// A file attached to the current message. Mirrors Attachment in app/page.tsx.
type Attachment =
  | { kind: "image"; name: string; mediaType: string; dataBase64: string }
  | { kind: "text"; name: string; text: string };

// Server-side attachment guardrails (client enforces its own, but never
// trust the client). Base64 inflates bytes ~4/3, hence the string caps.
const MAX_ATTACHMENTS = 10;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== "string" || a.name.length === 0) continue;

    if (
      a.kind === "image" &&
      typeof a.mediaType === "string" &&
      IMAGE_MEDIA_TYPES.has(a.mediaType) &&
      typeof a.dataBase64 === "string" &&
      a.dataBase64.length > 0 &&
      a.dataBase64.length <= MAX_IMAGE_BASE64_CHARS
    ) {
      out.push({
        kind: "image",
        name: a.name,
        mediaType: a.mediaType,
        dataBase64: a.dataBase64,
      });
    } else if (
      a.kind === "text" &&
      typeof a.text === "string" &&
      a.text.length > 0 &&
      a.text.length <= MAX_TEXT_CHARS
    ) {
      out.push({ kind: "text", name: a.name, text: a.text });
    }
  }
  return out;
}

function sseEncode(frame: SseFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function tryParseSearchQuery(accumulated: string): string | null {
  // web_search tool input is { "query": "..." }. Streams as partial JSON,
  // so we try parse; if partial, bail.
  try {
    const parsed = JSON.parse(accumulated) as { query?: string };
    return typeof parsed.query === "string" ? parsed.query : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY is not set on the server." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let userMessage: string;
  let history: Turn[] = [];
  let model = DEFAULT_MODEL;
  let thinking = false;
  let attachments: Attachment[] = [];
  try {
    const body = (await req.json()) as {
      message?: unknown;
      history?: unknown;
      model?: unknown;
      thinking?: unknown;
      attachments?: unknown;
    };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Body must be { message: string }." }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    userMessage = body.message.trim();

    // Unknown model ids fall back to the default rather than erroring, so a
    // stale Unity build with an outdated ModelPanel can't brick the app.
    if (typeof body.model === "string" && body.model in ALLOWED_MODELS) {
      model = body.model;
    }
    thinking = body.thinking === true && ALLOWED_MODELS[model].thinking;
    attachments = parseAttachments(body.attachments);

    if (Array.isArray(body.history)) {
      history = body.history
        .filter((h: unknown): h is Turn => {
          if (!h || typeof h !== "object") return false;
          const obj = h as Record<string, unknown>;
          return (
            (obj.role === "user" || obj.role === "assistant") &&
            typeof obj.content === "string" &&
            obj.content.length > 0
          );
        })
        .slice(-MAX_HISTORY_TURNS);
    }
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: SseFrame) => {
        controller.enqueue(encoder.encode(sseEncode(frame)));
      };

      // Track server_tool_use blocks so we can extract the query as it streams.
      const toolBlocks = new Map<number, { name: string; input: string }>();
      let closed = false;
      const safeClose = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };

      try {
        send({ type: "status", label: "Thinking..." });

        const webSearchTool: WebSearchTool = {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        };

        // Attachments become content blocks ahead of the user's text: images
        // as base64 image blocks, text files as labeled text blocks.
        const userContent:
          | string
          | Array<
              | { type: "text"; text: string }
              | {
                  type: "image";
                  source: {
                    type: "base64";
                    media_type: string;
                    data: string;
                  };
                }
            > =
          attachments.length === 0
            ? userMessage
            : [
                ...attachments.map((a) =>
                  a.kind === "image"
                    ? {
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: a.mediaType,
                          data: a.dataBase64,
                        },
                      }
                    : {
                        type: "text" as const,
                        text: `Attached file "${a.name}":\n\n${a.text}`,
                      }
                ),
                { type: "text" as const, text: userMessage },
              ];

        const anthropicStream = client.messages.stream({
          model,
          max_tokens: thinking ? MAX_TOKENS_WITH_THINKING : MAX_TOKENS,
          ...(thinking
            ? {
                thinking: {
                  type: "enabled" as const,
                  budget_tokens: THINKING_BUDGET_TOKENS,
                },
              }
            : {}),
          // Cast: older SDK type unions don't include web_search_20250305,
          // but the API accepts it at runtime.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [webSearchTool] as any,
          messages: [
            ...history,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { role: "user", content: userContent as any },
          ],
        });

        for await (const event of anthropicStream) {
          if (req.signal.aborted) break;

          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "server_tool_use" && block.name === "web_search") {
                toolBlocks.set(event.index, { name: block.name, input: "" });
              } else if (block.type === "web_search_tool_result") {
                send({ type: "status", label: "Reading results..." });
              } else if (block.type === "thinking") {
                send({ type: "status", label: "Thinking..." });
              } else if (block.type === "text") {
                send({ type: "status", label: "Answering..." });
              }
              break;
            }
            case "content_block_delta": {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                send({ type: "text", delta: delta.text });
              } else if (delta.type === "input_json_delta") {
                const tool = toolBlocks.get(event.index);
                if (tool) tool.input += delta.partial_json;
              }
              break;
            }
            case "content_block_stop": {
              const tool = toolBlocks.get(event.index);
              if (tool) {
                const query = tryParseSearchQuery(tool.input);
                const label = query
                  ? `Searching the web for "${query}"...`
                  : "Searching the web...";
                send({ type: "status", label });
                toolBlocks.delete(event.index);
              }
              break;
            }
            case "message_stop":
              send({ type: "done" });
              break;
            default:
              // message_start, message_delta, ping — no-op
              break;
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown streaming error.";
        send({ type: "error", message });
      } finally {
        safeClose();
      }
    },
    cancel() {
      // Client disconnected; nothing to clean up — the `for await` will see
      // req.signal.aborted and break on its next tick.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
