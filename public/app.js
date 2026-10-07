const $ = (id) => document.getElementById(id);

const state = {
  slides: [],
  view: null, // null follows the live slide; a number pins an earlier one
  listening: false,
  status: null,
  finals: [],
  partial: "",
  variants: false,
  paths: [], // the paths mode: where the talk may go next, as cards
};

let ws;
let activeProject = "";
let projectList = [];
let documentsTimer;
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

/** The points of a slide the speaker has actually said, whatever its layout. */
function saidPoints(slide) {
  const texts = slide.bullets?.length ? slide.bullets
    : slide.left && slide.right ? [...slide.left.items, ...slide.right.items]
    : [slide.subtitle, slide.quote && `«${slide.quote}»`, slide.value && [slide.value, slide.caption].filter(Boolean).join(" — ")].filter(Boolean);
  return texts.filter((text) => !slide.predicted.includes(text));
}

function card(title, items, className) {
  const node = el("section", `card ${className}`);
  if (title) node.append(el("h2", "", title));
  if (items.length) {
    const ul = node.appendChild(el("ul", "slide-list"));
    for (const text of items) ul.append(el("li", "", text));
  }
  return node;
}

/**
 * The paths mode: what the speaker is saying now sits plain at the bottom left; around it,
 * three coloured cards with directions the talk may take in the next quarter of a minute.
 */
function buildCards(slide) {
  const root = el("article", "cards");
  const now = slide ? card(slide.title, saidPoints(slide), "card-now") : card("", [], "card-now");
  if (!slide) now.append(el("p", "card-note", state.listening ? "Слушаю — тезисы появятся по ходу речи" : "Нажмите «Слушать»: здесь будут тезисы того, что вы говорите"));
  root.append(now);
  for (let i = 0; i < 3; i++) {
    const path = state.paths[i];
    root.append(path ? card(path.title, path.bullets, "card-path") : card("", [], "card-path card-empty"));
  }
  return root;
}

/** `before` is the previous version of the same slide: what differs gets the marker stroke. */
function renderStage({ before = null, enter = false } = {}) {
  const index = state.view ?? state.slides.length - 1;
  const slide = state.slides[index];
  const node = state.variants ? buildCards(state.slides.at(-1)) : slide ? buildSlide(slide, index, before) : buildEmpty();
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
  if (state.variants !== status.variants) {
    state.variants = status.variants;
    renderStage();
  }
  $("variants").setAttribute("aria-pressed", String(status.variants));
  // Only engines this server can run are offered; with a single one there is nothing to choose.
  for (const option of $("engine").options) option.hidden = option.disabled = !stt.engines.includes(option.value);
  $("engine").parentElement.hidden = stt.engines.length < 2;
  if (!stt.engines.includes($("engine").value)) $("engine").value = stt.engine;
}

/** Early-access requests left on the public page; the owner sees how many came in. */
function renderWaitlist(count) {
  $("waitlist").hidden = !count;
  $("waitlist").textContent = `Заявки: ${count ?? 0}`;
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
  if (!activeProject) return;
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?project=${encodeURIComponent(activeProject)}`);
  ws = socket;
  socket.onopen = () => { if (ws === socket) $("mic").disabled = false; };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "state":
        state.slides = message.slides;
        state.view = null;
        state.listening = message.listening;
        state.status = message.status;
        state.variants = message.status.variants;
        state.paths = message.paths ?? [];
        state.finals = message.transcript.map((entry) => entry.text);
        state.partial = "";
        renderStage();
        renderTape();
        renderStatus();
        renderListening();
        renderWaitlist(message.waitlist);
        break;
      case "waitlist":
        renderWaitlist(message.count);
        break;
      case "paths":
        state.paths = message.paths;
        if (state.variants) renderStage({ enter: true });
        break;
      case "slide": {
        const before = message.action === "update" ? state.slides[message.index] : null;
        state.slides[message.index] = message.slide;
        const live = message.index === state.slides.length - 1;
        if (state.variants) renderStage();
        else if (state.view === null && live) renderStage({ before, enter: message.action === "new" });
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
  socket.onclose = (event) => {
    if (ws !== socket) return;
    if (mic) releaseMic();
    state.listening = false;
    renderListening();
    $("mic").disabled = true;
    if (event.code === 4001) { location.href = "/login"; return; }
    $("chain").replaceChildren(Object.assign(el("li", "is-error"), { textContent: "Нет связи с сервером. Переподключение…" }));
    setTimeout(() => { if (ws === socket && activeProject) connect(); }, 1000);
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
  $("projects-panel").hidden = true;
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
  if (!activeProject || ws?.readyState !== WebSocket.OPEN) return;
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
$("variants").onclick = () => send({ type: "variants", on: !state.variants });
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
    case "KeyV": send({ type: "variants", on: !state.variants }); break;
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
void initProjects();

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) { location.href = "/login"; throw new Error("Войдите в аккаунт"); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Не удалось выполнить запрос");
  return result;
}

async function initProjects() {
  $("mic").disabled = true;
  try {
    const me = await api("/api/me");
    $("account-name").textContent = me.name;
    $("logout").hidden = !me.localAccount;
    $("personal-source-label").hidden = !me.personalSourceAvailable;
    await loadProjects();
    const requested = new URL(location.href).searchParams.get("project");
    const first = projectList.find(p => p.id === requested) ?? projectList[0];
    if (first) chooseProject(first.id);
    else $("project-message").textContent = "Создайте проект и загрузите материалы для слайдов.";
  } catch (error) { $("project-message").textContent = error.message; }
}
async function loadProjects() {
  projectList = await api("/api/projects");
  $("project-select").replaceChildren(new Option("Выберите проект", ""), ...projectList.map(p => new Option(p.name, p.id)));
  $("project-select").value = activeProject;
}
function chooseProject(id) {
  if (mic) releaseMic();
  const previous = ws;
  ws = null;
  previous?.close();
  clearTimeout(documentsTimer);
  activeProject = id;
  const url = new URL(location.href);
  id ? url.searchParams.set("project", id) : url.searchParams.delete("project");
  history.replaceState(null, "", url);
  $("project-select").value = id;
  const selectedName = projectList.find(p => p.id === id)?.name;
  $("projects-toggle").textContent = selectedName ? `Проект: ${selectedName.slice(0, 24)}${selectedName.length > 24 ? "…" : ""}` : "Проекты";
  $("projects-toggle").title = selectedName ?? "Проекты";
  $("project-documents").hidden = !id;
  $("download").href = `/api/deck.md?project=${encodeURIComponent(id)}`;
  state.slides = []; state.finals = []; state.partial = ""; state.paths = []; state.view = null; state.listening = false;
  renderStage(); renderTape(); renderListening();
  $("mic").disabled = true;
  $("project-source-note").textContent = projectList.find(p => p.id === id)?.personal_source
    ? "Источники: документы проекта и моя база знаний." : "Источники: документы этого проекта.";
  $("project-message").textContent = "";
  if (id) { void loadDocuments(id); connect(); }
}
async function loadDocuments(id) {
  try {
    const documents = await api(`/api/projects/${id}/documents`);
    if (id !== activeProject) return;
    const names = { queued: "В очереди", processing: "Распознаётся и индексируется", ready: "Готов", error: "Ошибка" };
    const rows = documents.map(doc => {
      const li = el("li", "document-row");
      li.append(el("span", "document-name", doc.name), el("span", `document-status ${doc.status}`, names[doc.status]));
      if (doc.error) li.append(el("span", "document-error", doc.error));
      if (doc.status === "error") {
        const button = el("button", "", "Повторить"); button.type = "button";
        button.onclick = async () => {
          button.disabled = true;
          try { await api(`/api/projects/${id}/documents/${doc.id}/retry`, { method: "POST" }); await loadDocuments(id); }
          catch (error) { $("project-message").textContent = error.message; button.disabled = false; }
        };
        li.append(button);
      }
      return li;
    });
    $("documents-list").replaceChildren(...(rows.length ? rows : [el("li", "documents-hint", "Документов пока нет. Загрузите первые материалы.")]));
    clearTimeout(documentsTimer);
    documentsTimer = setTimeout(() => loadDocuments(id), 3000);
  } catch (error) { if (id === activeProject) $("project-message").textContent = error.message; }
}
$("project-select").onchange = event => chooseProject(event.target.value);
$("projects-toggle").onclick = () => { $("projects-panel").hidden = !$("projects-panel").hidden; };
$("project-create").onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const project = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.elements.name.value, personalSource: form.elements.personalSource.checked }) });
    form.reset(); await loadProjects(); chooseProject(project.id);
  } catch (error) { $("project-message").textContent = error.message; }
  finally { button.disabled = false; }
};
$("document-files").onchange = async event => {
  const input = event.target;
  const files = [...input.files];
  const id = activeProject;
  input.disabled = true;
  try {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw new Error("Файл должен быть не больше 20 МБ");
      if (id === activeProject) $("project-message").textContent = `Загрузка: ${file.name}`;
      const form = new FormData(); form.append("file", file);
      await api(`/api/projects/${id}/documents`, { method: "POST", body: form });
    }
    if (id === activeProject) { $("project-message").textContent = "Документы загружены. Обработка идёт в фоне."; await loadDocuments(id); }
  } catch (error) { if (id === activeProject) $("project-message").textContent = error.message; }
  finally { input.value = ""; input.disabled = false; }
};
$("logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/login"; };
