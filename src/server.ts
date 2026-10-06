import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { config, secret } from "./config";
import { deckMarkdown, Session } from "./session";

const ROOM = "room";
const PUBLIC = join(config.root, "public");

let session: Session;
/** The one browser tab whose microphone is live; everyone else only watches. */
let micOwner: ServerWebSocket<unknown> | null = null;

const server = Bun.serve({
  hostname: config.host,
  port: config.port,

  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return server.upgrade(request) ? undefined : new Response("WebSocket expected", { status: 400 });
    }
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, session: session.id, listening: session.listening, slides: session.slides.length, status: session.status });
    }
    if (url.pathname === "/api/deck.md") {
      return new Response(deckMarkdown(session.slides), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="slides-${session.id}.md"`,
        },
      });
    }
    const path = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(PUBLIC)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      ws.subscribe(ROOM);
      ws.send(JSON.stringify(session.snapshot()));
    },
    async message(ws, message) {
      if (typeof message !== "string") {
        if (ws === micOwner) session.audio(message);
        return;
      }
      let command: { type?: string; engine?: string };
      try {
        command = JSON.parse(message);
      } catch {
        return;
      }
      switch (command.type) {
        case "start":
          if (session.listening) break;
          micOwner = ws;
          await session.start(command.engine === "whisper" || command.engine === "elevenlabs" ? command.engine : undefined);
          break;
        case "stop":
          micOwner = null;
          await session.stop();
          break;
        case "new-slide":
          session.newSlide();
          break;
        case "reset":
          micOwner = null;
          await session.stop();
          session = new Session(broadcast);
          broadcast(session.snapshot());
          break;
      }
    },
    close(ws) {
      if (ws !== micOwner) return;
      micOwner = null;
      void session.stop();
    },
  },
});

function broadcast(message: Record<string, unknown>): void {
  server.publish(ROOM, JSON.stringify(message));
}

if (config.llm.keyPassEntry && !process.env.LLM_API_KEY) config.llm.apiKey = await secret("LLM_API_KEY", config.llm.keyPassEntry);

session = new Session(broadcast);

console.log(`Живые слайды: http://${server.hostname}:${server.port}`);
console.log(`Распознавание: ${config.stt.engine} · слайды: ${config.llm.model} · источники: ${session.status.sources.scopes.join(", ") || "выключены"}`);
