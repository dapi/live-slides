const $ = (id) => document.getElementById(id);

// The page follows the system theme; slide.css keys its dark palette off this attribute.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => (document.documentElement.dataset.theme = dark.matches ? "dark" : "light");
applyTheme();
dark.addEventListener("change", applyTheme);

/* Demo: a short talk replayed the way the app shows it. Each phrase arrives word by word as a
   partial, closes into the tape, and at marked words the slide reacts: it opens with every point
   forecast, then points become spoken one by one. */

const TALK = [
  { text: "Сегодня — про то, как агент работает в команде разработчиков.", at: { "команде": "open" } },
  { text: "Три вещи. Первая: до первой правки он читает правила репозитория.", at: { "репозитория.": 0 } },
  { text: "Вторая: каждый шаг оставляет след в задаче.", at: { "задаче.": 1 } },
  { text: "И третья — результат принимает человек.", at: { "человек.": 2 } },
];

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const demo = document.querySelector(".demo");
const items = [...$("demo-list").children];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resetDemo() {
  $("demo-slide").hidden = false;
  $("demo-slide").classList.remove("enter");
  for (const li of items) {
    li.classList.add("ahead");
    li.textContent = li.textContent;
  }
  $("demo-final").textContent = "";
  $("demo-partial").textContent = "";
}

function react(event) {
  if (event === "open") {
    return;
  }
  const li = items[event];
  const mark = document.createElement("span");
  mark.className = "fresh";
  mark.textContent = li.textContent;
  li.classList.remove("ahead");
  li.replaceChildren(mark);
}

async function play() {
  for (;;) {
    resetDemo();
    demo.classList.add("live");
    await wait(900);
    for (const phrase of TALK) {
      const words = phrase.text.split(" ");
      for (let i = 0; i < words.length; i++) {
        $("demo-partial").textContent = words.slice(0, i + 1).join(" ");
        const event = phrase.at[words[i]];
        if (event !== undefined) react(event);
        await wait(170 + Math.random() * 140 + (words[i].endsWith(",") || words[i].endsWith(".") ? 260 : 0));
      }
      await wait(350);
      $("demo-final").textContent += phrase.text + "  ";
      $("demo-partial").textContent = "";
      await wait(500);
    }
    demo.classList.remove("live");
    await wait(7000);
  }
}

if (reduced) {
  // No replay: the finished slide, all points spoken, and the whole talk in the tape.
  resetDemo();
  $("demo-slide").hidden = false;
  for (const li of items) li.classList.remove("ahead");
  $("demo-final").textContent = TALK.map((phrase) => phrase.text).join("  ");
} else {
  play();
}

/* The circle: silent on its own; a tap starts it over with sound, another tap mutes again. */

const circle = $("circle");
const video = $("circle-video");
const circleButton = $("circle-button");

if (!reduced) video.play().catch(() => {});

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
