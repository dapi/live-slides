import { join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { config, secret } from "./config";
import { deckMarkdown, Session } from "./session";
import { Waitlist } from "./waitlist";

const ROOM = "room";
const PUBLIC = join(config.root, "public");
/** Public page and its form; everything else on the hosted site is behind the owner's session. */
const PAGES: Record<string, string> = { "/": "landing.html", "/app": "index.html", "/app/": "index.html" };

let session: Session;
/** The one browser tab whose microphone is live; everyone else only watches. */
let micOwner: ServerWebSocket<unknown> | null = null;
const waitlist = await Waitlist.open();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,

  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return server.upgrade(request) ? undefined : new Response("WebSocket expected", { status: 400 });
    }
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/waitlist" && request.method === "POST") return joinWaitlist(request, server.requestIP(request)?.address ?? "");
    if (url.pathname === "/api/waitlist") return Response.json(waitlist.list());
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, session: session.id, listening: session.listening, slides: session.slides.length, waitlist: waitlist.count, status: session.status });
    }
    if (url.pathname === "/api/deck.md") {
      return new Response(deckMarkdown(session.slides), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="slides-${session.id}.md"`,
        },
      });
    }
    const path = normalize(join(PUBLIC, PAGES[url.pathname] ?? url.pathname));
    if (!path.startsWith(PUBLIC)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      ws.subscribe(ROOM);
      ws.send(JSON.stringify(snapshot()));
    },
    async message(ws, message) {
      if (typeof message !== "string") {
        if (ws === micOwner) session.audio(message);
        return;
      }
      let command: { type?: string; engine?: string; on?: boolean };
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
        case "variants":
          session.setVariants(command.on === true);
          break;
        case "reset":
          micOwner = null;
          await session.stop();
          session = new Session(broadcast);
          broadcast(snapshot());
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

function snapshot(): Record<string, unknown> {
  return { ...session.snapshot(), waitlist: waitlist.count };
}

function broadcast(message: Record<string, unknown>): void {
  server.publish(ROOM, JSON.stringify(message));
}

/** The early-access form: JSON from the page script, or a plain form post without it. */
async function joinWaitlist(request: Request, peer: string): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  let input: Record<string, unknown> = {};
  try {
    input = type.includes("json") ? await request.json() : Object.fromEntries((await request.formData()).entries());
  } catch {
    return Response.json({ ok: false, error: "Форма пришла пустой. Попробуйте ещё раз." }, { status: 400 });
  }
  // Behind the ingress the peer is nginx; it passes the visitor's address along.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || peer;
  const result = await waitlist.add(input, ip);
  if (result.ok) broadcast({ type: "waitlist", count: waitlist.count });
  if (!type.includes("json")) return Response.redirect(result.ok ? "/#sent" : `/#error=${encodeURIComponent(result.error)}`, 303);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

if (config.llm.keyPassEntry && !process.env.LLM_API_KEY) config.llm.apiKey = await secret("LLM_API_KEY", config.llm.keyPassEntry);

session = await Session.resumeLatest(broadcast);
if (session.slides.length) console.log(`Продолжаю сессию ${session.id}: слайдов ${session.slides.length}`);

console.log(`Живые слайды: http://${server.hostname}:${server.port}`);
console.log(`Распознавание: ${config.stt.engine} · слайды: ${config.llm.model} · источники: ${session.status.sources.scopes.join(", ") || "выключены"}`);
