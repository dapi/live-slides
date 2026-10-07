const $ = (id) => document.getElementById(id);

const state = {
  slides: [],
  view: null, // null follows the live slide; a number pins an earlier one
  listening: false,
  status: null,
  finals: [],
  partial: "",
};

let ws;
let mic = null; // { stream, context } while this tab owns the microphone
let quietTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Text inside a span, so the marker stroke hugs the words rather than the block.
 * "ahead" is a forecast the speaker has not reached; "fresh" is what he has just said.
 */
function words(text, state) {
  return el("span", state, text);
}

/** What an earlier version of the slide already showed as said. */
function saidTexts(slide) {
  if (!slide) return null;
  return new Set([
    slide.title, slide.subtitle, slide.quote, slide.value, slide.caption,
    ...(slide.bullets ?? []),
    slide.left?.title, ...(slide.left?.items ?? []),
    slide.right?.title, ...(slide.right?.items ?? []),
  ].filter((text) => text && !slide.predicted.includes(text)));
}

function list(items, stateOf) {
  const ul = el("ul", "slide-list");
  for (const item of items) ul.appendChild(el("li", stateOf(item) === "ahead" ? "ahead" : "")).append(words(item, stateOf(item)));
  return ul;
}

const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attributes) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** A node of a diagram: a box whose border is dashed until the speaker reaches it. */
function diagramNode(text, state) {
  const box = el("div", `node ${state === "ahead" ? "ahead" : ""}`);
  box.append(words(text, state));
  return box;
}

/**
 * Three diagrams, drawn from the slide's structure: a chain of steps, a loop that returns to
 * its start, and a stack of layers from the base up.
 */
function diagram(slide, stateOf) {
  const root = el("div", `diagram diagram-${slide.layout}`);
  const nodes = slide.bullets;
  if (slide.layout === "layers") {
    for (const text of [...nodes].reverse()) root.append(diagramNode(text, stateOf(text)));
    return root;
  }
  const row = root.appendChild(el("div", "diagram-row"));
  nodes.forEach((text, i) => {
    if (i) row.appendChild(svg("svg", { class: "arrow", viewBox: "0 0 24 24", "aria-hidden": "true" })).append(svg("path", { d: "M2 12h17m-6-6 6 6-6 6" }));
    row.append(diagramNode(text, stateOf(text)));
  });
  if (slide.layout === "cycle") {
    // The way back from the last node to the first: a line under the row, arrow up at the start.
    root.appendChild(el("div", "loop")).appendChild(svg("svg", { class: "loop-head", viewBox: "0 0 24 24", "aria-hidden": "true" })).append(svg("path", { d: "M5 15l7-8 7 8" }));
  }
  return root;
}

function buildSlide(slide, index, before) {
  const known = saidTexts(before);
  // Said for the first time gets the marker, including a forecast that has just come true.
  const fresh = (text) => (slide.predicted.includes(text) ? "ahead" : known !== null && !known.has(text) ? "fresh" : "");
  const root = el("article", `slide layout-${slide.layout}`);
  const title = (className) => {
    const node = el("h1", className);
    node.append(words(slide.title, fresh(slide.title)));
    return node;
  };

  if (slide.layout === "quote" && slide.quote) {
    root.append(el("p", "slide-topic", slide.title));
    root.appendChild(el("blockquote", "slide-quote")).append(words(`«${slide.quote.replace(/^[«"“]|[»"”]$/g, "")}»`, fresh(slide.quote)));
    if (slide.attribution) root.append(el("p", "slide-by", slide.attribution));
  } else if (slide.layout === "number" && slide.value) {
    root.append(el("p", "slide-topic", slide.title));
    root.appendChild(el("p", "slide-value")).append(words(slide.value, fresh(slide.value) === "ahead" ? "ahead" : ""));
    if (slide.caption) root.appendChild(el("p", "slide-sub")).append(words(slide.caption, fresh(slide.caption)));
  } else if (["flow", "cycle", "layers"].includes(slide.layout) && slide.bullets?.length) {
    root.append(title("slide-title"), diagram(slide, fresh));
  } else if (slide.layout === "compare" && slide.left && slide.right) {
    root.append(title("slide-title"));
    const grid = root.appendChild(el("div", "compare"));
    for (const side of [slide.left, slide.right]) {
      const column = grid.appendChild(el("section"));
      column.append(el("h2", "", side.title), list(side.items, fresh));
    }
  } else {
    root.append(title(`slide-title${slide.title.length > 44 ? " long" : ""}`));
    if (slide.subtitle) root.appendChild(el("p", "slide-sub")).append(words(slide.subtitle, fresh(slide.subtitle)));
    if (slide.bullets?.length) root.append(list(slide.bullets, fresh));
  }

  const foot = root.appendChild(el("footer", "slide-foot"));
  // A published source is named with its site, so the audience knows where to find it.
  const names = slide.sources.map((source) => (source.url ? `${source.title} — ${new URL(source.url).hostname}` : source.title));
  foot.append(
    el("span", "slide-sources", names.length ? `${names.length > 1 ? "Источники" : "Источник"}: ${names.join("; ")}` : ""),
    ...(slide.predicted.length ? [el("span", "slide-legend", "пунктир — прогноз, докладчик к этому подходит")] : []),
    el("span", "slide-count", `${index + 1} / ${state.slides.length}`),
  );
  return root;
}

function buildEmpty() {
  const root = el("article", "slide empty");
  root.append(
    el("h1", "slide-title", "Говорите — слайды соберутся сами"),
    el("p", "slide-sub", "Речь распознаётся на лету, мысли становятся слайдами, а формулировки и факты подтягиваются из вашей базы знаний."),
  );
  const keys = root.appendChild(el("dl", "keys"));
  for (const [key, action] of [
    ["Пробел", "начать или остановить запись"],
    ["N", "новый слайд прямо сейчас"],
    ["← →", "листать слайды, L — вернуться к живому"],
    ["F", "на весь экран"],
    ["D", "тёмная тема, T — скрыть ленту речи"],
  ]) keys.append(el("dt", "", key), el("dd", "", action));
  return root;
}

/** `before` is the previous version of the same slide: what differs gets the marker stroke. */
function renderStage({ before = null, enter = false } = {}) {
  const index = state.view ?? state.slides.length - 1;
  const slide = state.slides[index];
  const node = slide ? buildSlide(slide, index, before) : buildEmpty();
  if (enter) node.classList.add("enter");
  $("stage").replaceChildren(node);

  const rail = $("rail");
  rail.replaceChildren(...state.slides.map((item, i) => {
    const tick = el("button");
    tick.type = "button";
    tick.title = `${i + 1}. ${item.title}`;
    tick.setAttribute("aria-label", tick.title);
    if (i === index) tick.setAttribute("aria-current", "true");
    tick.onclick = () => go(i);
    return tick;
  }));

  const away = state.view !== null && state.view < state.slides.length - 1;
  $("away").hidden = !away;
  if (away) $("away-text").textContent = `Вы на слайде ${state.view + 1} из ${state.slides.length}`;
  $("download").toggleAttribute("hidden", state.slides.length === 0);
}

function go(index) {
  if (!state.slides.length) return;
  const clamped = Math.max(0, Math.min(state.slides.length - 1, index));
  state.view = clamped === state.slides.length - 1 ? null : clamped;
  renderStage({ enter: true });
}

function renderTape() {
  $("tape-final").textContent = state.finals.slice(-6).join("  ") + (state.partial ? "  " : "");
  $("tape-partial").textContent = state.partial;
}

const STT_STATES = { idle: "ждёт", connecting: "подключается", ready: "слушает" };
const ENGINE_NAMES = { elevenlabs: "ElevenLabs", whisper: "Whisper" };

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const row = (name, kind, text, extra = "") => {
    const li = el("li", `is-${kind} ${extra}`);
    li.title = text ?? "";
    li.append(el("span", "dot"), ...(name ? [el("b", "", name)] : []), el("span", "", text));
    return li;
  };
  const { stt, slides, sources } = status;
  const model = slides.model.split("/").pop().replace(/-subscription$/, "");
  const rows = [
    row("Речь", stt.state === "error" ? "error" : stt.state === "ready" ? "ok" : stt.state === "connecting" ? "working" : "idle",
      stt.state === "error" ? stt.detail : `${ENGINE_NAMES[stt.engine]}, ${stt.detail ?? STT_STATES[stt.state]}`),
    row("Слайды", slides.state === "error" ? "error" : slides.state === "working" ? "working" : "ok",
      slides.state === "error" ? slides.detail : slides.state === "working" ? `${model} пишет` : model),
  ];
  if (sources.state !== "off") {
    rows.push(row("База знаний", sources.state === "error" ? "error" : sources.state === "working" ? "working" : "ok",
      sources.state === "error" ? sources.detail : sources.state === "working" ? "ищет" : sources.found === undefined ? sources.scopes.join(", ") : `найдено ${sources.found}`));
  }
  if (status.next) rows.push(row("Дальше", "idle", status.next, "chain-next"));
  if (status.speechToSlideMs) {
    rows.push(row("", "idle", `${(status.speechToSlideMs / 1000).toFixed(1).replace(".", ",")} с до слайда`));
  }
  $("chain").replaceChildren(...rows);
  // Only engines this server can run are offered; with a single one there is nothing to choose.
  for (const option of $("engine").options) option.hidden = option.disabled = !stt.engines.includes(option.value);
  $("engine").parentElement.hidden = stt.engines.length < 2;
  if (!stt.engines.includes($("engine").value)) $("engine").value = stt.engine;
}

function renderListening() {
  document.body.classList.toggle("listening", state.listening);
  const button = $("mic");
  const elsewhere = state.listening && !mic;
  button.setAttribute("aria-pressed", String(state.listening && !!mic));
  button.disabled = elsewhere;
  $("mic-label").textContent = elsewhere ? "Запись идёт в другой вкладке" : state.listening ? "Остановить" : "Слушать";
  $("engine").disabled = state.listening;
  wake();
}

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "state":
        state.slides = message.slides;
        state.view = null;
        state.listening = message.listening;
        state.status = message.status;
        state.finals = message.transcript.map((entry) => entry.text);
        state.partial = "";
        renderStage();
        renderTape();
        renderStatus();
        renderListening();
        break;
      case "slide": {
        const before = message.action === "update" ? state.slides[message.index] : null;
        state.slides[message.index] = message.slide;
        const live = message.index === state.slides.length - 1;
        if (state.view === null && live) renderStage({ before, enter: message.action === "new" });
        else if (state.view === null && !live) break; // an earlier slide was tidied up; nothing on screen changes
        else renderStage();
        break;
      }
      case "partial":
        state.partial = message.text;
        renderTape();
        break;
      case "final":
        state.finals.push(message.text);
        state.partial = "";
        renderTape();
        break;
      case "status":
        state.status = message.status;
        renderStatus();
        break;
      case "listening":
        state.listening = message.on;
        if (!message.on && mic) releaseMic();
        renderListening();
        break;
    }
  };
  ws.onclose = () => {
    if (mic) releaseMic();
    state.listening = false;
    renderListening();
    $("chain").replaceChildren(Object.assign(el("li", "is-error"), { textContent: "Нет связи с сервером. Переподключение…" }));
    setTimeout(connect, 1000);
  };
}

async function startMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    $("chain").replaceChildren(Object.assign(el("li", "is-error"), {
      textContent: error.name === "NotAllowedError"
        ? "Браузер не дал доступ к микрофону. Разрешите его в настройках сайта и нажмите «Слушать» ещё раз."
        : `Микрофон недоступен: ${error.message}`,
    }));
    return;
  }
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("/pcm-worklet.js");
  const node = new AudioWorkletNode(context, "pcm");
  node.port.onmessage = ({ data }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data.pcm);
    $("mic-level").style.setProperty("--level", Math.min(1, data.level * 6).toFixed(2));
  };
  context.createMediaStreamSource(stream).connect(node);
  // A silent path to the output keeps the worklet running in every browser.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);
  mic = { stream, context };
  localStorage.setItem("engine", $("engine").value);
  send({ type: "start", engine: $("engine").value });
}

function releaseMic() {
  mic.stream.getTracks().forEach((track) => track.stop());
  void mic.context.close();
  mic = null;
  $("mic-level").style.removeProperty("--level");
}

function toggleMic() {
  if (mic) {
    releaseMic();
    send({ type: "stop" });
  } else if (!state.listening) {
    void startMic();
  }
}

/** While recording, the controls fade after the pointer rests, leaving only the slide. */
function wake() {
  document.body.classList.remove("quiet");
  clearTimeout(quietTimer);
  if (state.listening) quietTimer = setTimeout(() => document.body.classList.add("quiet"), 3000);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
}

$("mic").onclick = toggleMic;
$("new-slide").onclick = () => send({ type: "new-slide" });
$("back-live").onclick = () => go(state.slides.length - 1);
$("reset").onclick = () => {
  if (confirm("Начать новую сессию? Слайды и текст этой сессии останутся в папке data/sessions.")) {
    if (mic) releaseMic();
    send({ type: "reset" });
  }
};

document.addEventListener("pointermove", wake);
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.matches("select, input, textarea")) return;
  if (event.code === "Space" && event.target.closest("button, a")) return; // the focused control handles it
  wake();
  const index = state.view ?? state.slides.length - 1;
  switch (event.code) {
    case "Space": event.preventDefault(); toggleMic(); break;
    case "KeyN": send({ type: "new-slide" }); break;
    case "ArrowLeft": case "PageUp": go(index - 1); break;
    case "ArrowRight": case "PageDown": go(index + 1); break;
    case "KeyL": case "End": go(state.slides.length - 1); break;
    case "KeyF": document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); break;
    case "KeyD": setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); break;
    case "KeyT": $("tape").hidden = !$("tape").hidden; break;
  }
});

setTheme(localStorage.getItem("theme") ?? "light");
$("engine").value = localStorage.getItem("engine") ?? "elevenlabs";
connect();
