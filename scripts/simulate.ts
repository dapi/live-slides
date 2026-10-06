// Plays a 16 kHz mono 16-bit WAV into a running server as if it were the microphone.
// Usage: bun scripts/simulate.ts talk.wav [ws://127.0.0.1:4747/ws] [elevenlabs|whisper]
export {};

const [file, urlArg, engine] = process.argv.slice(2);
const url = urlArg || `ws://127.0.0.1:${process.env.PORT ?? 4747}/ws`;
if (!file) throw new Error("Usage: bun scripts/simulate.ts talk.wav [ws-url] [engine]");

const pcm = new Uint8Array(await Bun.file(file).arrayBuffer()).subarray(44);
// SIMULATE_COOKIE carries a session cookie when the server sits behind an authenticating proxy.
const cookie = process.env.SIMULATE_COOKIE;
const ws = new WebSocket(url, cookie ? ({ headers: { Cookie: cookie } } as any) : undefined);
const started = performance.now();
const at = () => ((performance.now() - started) / 1000).toFixed(1).padStart(5);
let lastStage = "";

ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "final") console.log(at(), "речь  ", message.text);
  if (message.type === "slide") {
    const { slide, action } = message;
    console.log(at(), action === "new" ? "НОВЫЙ " : "ДОП.  ", `#${message.index + 1} [${slide.layout}] ${slide.title}`);
    // "·" was said, "◌" is a forecast the speaker has not reached yet
    const sign = (text: string) => (slide.predicted.includes(text) ? "◌" : "·");
    for (const line of [slide.subtitle, slide.value, slide.caption, slide.quote, ...(slide.bullets ?? [])].filter(Boolean)) console.log("       ", sign(line), line);
    for (const side of [slide.left, slide.right].filter(Boolean)) console.log("        ▸", side.title, "|", side.items.map((item: string) => `${sign(item)} ${item}`).join(" / "));
    for (const source of slide.sources) console.log("        ↳ источник:", source.title, "—", source.ref);
  }
  if (message.type === "status") {
    const s = message.status;
    const stage = `stt=${s.stt.state} slides=${s.slides.state} sources=${s.sources.state}`;
    const problem = [s.stt, s.slides, s.sources].find((part) => part.state === "error");
    if (problem && stage !== lastStage) console.log(at(), "ОШИБКА", problem.detail);
    lastStage = stage;
  }
};

ws.onclose = (event) => {
  console.log(at(), "соединение закрыто", event.code, event.reason);
  process.exit(event.code === 1000 ? 0 : 1);
};

ws.onopen = async () => {
  ws.send(JSON.stringify({ type: "start", engine }));
  const chunk = 3200; // 100 ms
  for (let offset = 0; offset < pcm.length; offset += chunk) {
    ws.send(pcm.slice(offset, offset + chunk));
    await Bun.sleep(100);
  }
  const silence = new Uint8Array(chunk);
  for (let i = 0; i < 15; i++) {
    ws.send(silence);
    await Bun.sleep(100);
  }
  ws.send(JSON.stringify({ type: "stop" }));
  await Bun.sleep(9000); // let the last slide arrive
  ws.close();
  process.exit(0);
};
