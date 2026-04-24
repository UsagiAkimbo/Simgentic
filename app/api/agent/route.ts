import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

type SseFrame =
  | { type: "status"; label: string }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };

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
  try {
    const body = (await req.json()) as { message?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Body must be { message: string }." }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    userMessage = body.message.trim();
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

        const anthropicStream = client.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 5,
            },
          ],
          messages: [{ role: "user", content: userMessage }],
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
