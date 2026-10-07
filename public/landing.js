const $ = (id) => document.getElementById(id);

// The page follows the system theme; slide.css keys its dark palette off this attribute.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

/* Demo, in step with the circle. The words are the circle's speech with the moment each was
   said (recognized by Whisper once, offline); the slides are what the director does with it:
   a slide opens on the announced topic, its forecast points come true as the words arrive.
   Everything is drawn from the video's own clock, so a replay or a seek stays in sync. */

const WORDS = [[0.0, "Рассказываю,"], [1.09, "в"], [1.18, "моем"], [1.54, "случае"], [2.17, "это"], [2.48, "так,"], [2.75, "у"], [2.83, "меня"], [3.21, "есть"], [3.8, "доклад,"], [4.24, "я"], [4.32, "выступаю,"], [5.14, "его"], [5.43, "слушает"], [6.08, "25"], [6.49, "человек,"], [7.23, "есть"], [7.95, "слайды,"], [8.78, "они"], [8.92, "проецируются"], [10.36, "на"], [10.71, "экран,"], [11.4, "дальше"], [11.75, "происходит"], [12.33, "следующее,"], [12.92, "меня"], [13.27, "несет,"], [13.83, "я"], [13.86, "слайды"], [14.49, "не"], [14.54, "переключаю,"], [15.6, "или"], [15.65, "меня"], [16.13, "унесло"], [16.58, "в"], [16.65, "одну"], [16.95, "сторону,"], [17.58, "в"], [17.63, "слайде"], [18.08, "что-то"], [18.49, "другое,"], [19.09, "или"], [19.15, "еще"], [19.78, "вариант,"], [20.32, "когда"], [20.75, "слайды"], [21.26, "вообще"], [21.77, "переключаю"], [22.62, "не"], [22.79, "я,"], [23.02, "а"], [23.08, "клики"], [23.42, "где-то"], [23.71, "у"], [23.8, "какого-то"], [24.32, "менеджера,"], [24.98, "где-то"], [25.34, "там"], [25.54, "в"], [25.62, "загашнике,"], [26.28, "и"], [26.34, "он"], [26.46, "забывает"], [26.95, "эти"], [27.12, "слайды"], [27.49, "листать,"], [28.04, "или"], [28.21, "листает"], [28.68, "не"], [28.71, "туда,"], [29.24, "или"], [29.27, "вообще"], [29.68, "черти"], [30.04, "знает"], [30.45, "что,"], [30.69, "по-хорошему"], [31.5, "мне"], [31.66, "слайды"], [32.15, "вообще"], [32.52, "не"], [32.8, "нужны,"], [33.09, "людям"], [33.45, "нужны,"], [33.96, "они"], [34.1, "любят"], [34.46, "смотреть"], [35.04, "какие-то"], [35.57, "картинки,"], [36.2, "которые"], [36.52, "по-хорошему"], [37.48, "не"], [37.62, "до"], [37.8, "конца"], [38.16, "все"], [38.34, "равно"], [38.7, "понимают,"], [39.58, "поэтому"], [39.99, "эта"], [40.16, "штука"], [40.44, "просто-напросто"], [41.3, "под"], [41.42, "мою"], [41.62, "речь"], [41.81, "подстраивается,"], [42.84, "делает"], [43.22, "какие-то"], [43.61, "слайды,"], [44.04, "а"], [44.1, "я"], [44.16, "могу"], [44.42, "нестись"], [44.72, "своим"], [45.37, "паровозом"], [45.73, "вперед"], [46.12, "туда,"], [46.43, "куда"], [46.69, "меня"], [47.04, "несет"], [47.26, "мысль,"], [47.63, "могу"], [47.89, "периодически"], [48.79, "заглядывать"], [49.34, "на"], [49.47, "эти"], [49.66, "слайды,"], [50.09, "чтобы"], [50.41, "они"], [50.6, "меня"], [50.86, "выравнивали,"], [51.61, "как-то"], [51.95, "так."]];

// Each slide: when it opens, its title, and the points with the moment each was actually said.
const SLIDES = [
  { at: 0, title: "Как обычно проходит доклад", points: [
    ["Слайды на экране, 25 слушателей", 10.7],
    ["Докладчика несёт — слайды не переключает", 14.5],
    ["Или переключает кто-то другой, и не туда", 28.4],
  ] },
  { at: 30.7, title: "Кому нужны слайды", points: [
    ["Докладчику — нет", 32.9],
    ["Слушателям — да, им нужны картинки", 36.0],
    ["Даже если понимают не до конца", 39.3],
  ] },
  { at: 39.6, title: "Слайды подстраиваются под речь", points: [
    ["Слайды собираются по ходу речи", 43.8],
    ["Докладчик несётся за мыслью", 47.4],
    ["Слайды выравнивают, когда заглянул", 51.5],
  ] },
];

const PARTIAL_WINDOW = 2.4; // seconds of speech the recognizer still treats as an open phrase
const TAPE_WORDS = 16;

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const demo = document.querySelector(".demo");
const slideNode = $("demo-slide");
let shown = { index: -1, said: [] };

function slideAt(t) {
  let index = 0;
  for (let i = 0; i < SLIDES.length; i++) if (t >= SLIDES[i].at) index = i;
  return index;
}

/** Draws the demo for a moment of the talk; only what changed since the last frame is touched. */
function renderDemo(t) {
  const index = slideAt(t);
  const slide = SLIDES[index];
  const said = slide.points.map(([, at]) => t >= at);
  if (index !== shown.index) {
    slideNode.querySelector(".slide-title").textContent = slide.title;
    const list = $("demo-list");
    list.replaceChildren(...slide.points.map(([text]) => {
      const li = document.createElement("li");
      li.className = "ahead";
      li.textContent = text;
      return li;
    }));
    slideNode.classList.remove("enter");
    if (shown.index !== -1) {
      void slideNode.offsetWidth; // restart the entrance animation
      slideNode.classList.add("enter");
    }
    shown = { index, said: slide.points.map(() => false) };
  }
  const items = [...$("demo-list").children];
  said.forEach((isSaid, i) => {
    if (isSaid === shown.said[i]) return;
    const li = items[i];
    li.classList.toggle("ahead", !isSaid);
    if (isSaid && t - slide.points[i][1] < 1) {
      const mark = document.createElement("span");
      mark.className = "fresh";
      mark.textContent = li.textContent;
      li.replaceChildren(mark);
    } else {
      li.textContent = li.textContent;
    }
  });
  shown.said = said;

  // The tape: the latest words, the last couple of seconds still "open" like a partial.
  const heard = WORDS.filter(([at]) => at <= t).slice(-TAPE_WORDS);
  const open = heard.filter(([at]) => t - at < PARTIAL_WINDOW);
  const closed = heard.slice(0, heard.length - open.length);
  $("demo-final").textContent = closed.map(([, w]) => w).join(" ") + (closed.length && open.length ? " " : "");
  $("demo-partial").textContent = open.map(([, w]) => w).join(" ");
}

/* The circle drives the demo: silent on its own, a tap starts it over with sound, another tap
   mutes again. */

const circle = $("circle");
const video = $("circle-video");
const circleButton = $("circle-button");

function follow() {
  renderDemo(video.currentTime);
  demo.classList.toggle("live", !video.paused && !video.ended);
  if (!video.paused) requestAnimationFrame(follow);
}

video.addEventListener("play", follow);
video.addEventListener("seeked", () => renderDemo(video.currentTime));
video.addEventListener("pause", () => demo.classList.remove("live"));

if (reduced || !video.getAttribute('src')) {
  // No motion: the finished third slide and the end of the tape.
  renderDemo(53);
} else {
  renderDemo(0);
  video.play().catch(() => renderDemo(53)); // autoplay refused: show the result instead
}

circleButton.addEventListener("click", () => {
  const sound = !circle.classList.contains("sound");
  circle.classList.toggle("sound", sound);
  video.muted = !sound;
  circleButton.setAttribute("aria-label", sound ? "Выключить звук" : "Включить звук");
  if (sound) video.currentTime = 0;
  video.play().catch(() => {});
});

/* Early-access form */

const form = $("form");
const hint = $("hint");
const plain = hint.textContent;

function sent() {
  form.hidden = true;
  $("done").hidden = false;
}

function fail(message) {
  hint.textContent = message;
  hint.classList.add("error");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  $("submit").textContent = "Отправляю…";
  hint.textContent = plain;
  hint.classList.remove("error");
  try {
    const response = await fetch("/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const result = await response.json().catch(() => ({ ok: false }));
    if (result.ok) sent();
    else fail(result.error ?? "Не получилось отправить. Попробуйте ещё раз.");
  } catch {
    fail("Нет связи с сервером. Попробуйте ещё раз через минуту.");
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "Оставить заявку";
  }
});

// A plain form post without this script comes back here with its outcome in the hash.
if (location.hash === "#sent") sent();
else if (location.hash.startsWith("#error=")) fail(decodeURIComponent(location.hash.slice(7)));
