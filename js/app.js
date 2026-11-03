import {
  initializeApp, initializeAuth, browserLocalPersistence, signInAnonymously,
  initializeFirestore, doc, collection, getDoc, setDoc, writeBatch, updateDoc, onSnapshot,
  query, orderBy, limit, serverTimestamp, Timestamp,
} from "../vendor/firebase.js";
import { firebaseConfig, useEmulator } from "./config.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_BODY = 20000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no I/O/0/1
const CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/;

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  home: $("view-home"), room: $("view-room"), ended: $("view-ended"),
  tools: $("room-tools"), code: $("room-code"), copyCode: $("copy-code"), copyLink: $("copy-link"), emptyCopyCode: $("empty-copy-code"),
  expiry: $("expiry"), expiryTime: $("expiry-time"),
  burn: $("burn"), leave: $("leave"), burnDialog: $("burn-dialog"),
  create: $("create"), joinForm: $("join-form"), joinCode: $("join-code"), joinBtn: $("join-btn"), joinMsg: $("join-msg"),
  feed: $("feed"), msgs: $("msgs"), empty: $("empty"), emptyCopy: $("empty-copy"),
  composer: $("composer"), draft: $("draft"), send: $("send"), hint: $("hint"),
  endedWhy: $("ended-why"), endedNew: $("ended-new"),
  theme: $("theme"), toast: $("toast"), homeLink: $("home-link"),
};

let app, auth, db, uid = null;
let session = null; // { id, expireAt (ms), unsubs[], ids:Set, ended }

/* ---------- small utilities ---------- */

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join(""); // 256 % 32 === 0, so no modulo bias
}
const fmtCode = (c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
const normCode = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.setAttribute("data-show", "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.removeAttribute("data-show"), 2200);
}

async function copyText(text, okMsg = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.className = "sr";
    document.body.append(ta); ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
  toast(okMsg);
}

function show(view) {
  el.body.dataset.view = view;
  el.home.hidden = view !== "home";
  el.room.hidden = view !== "room";
  el.ended.hidden = view !== "ended";
  el.tools.hidden = view !== "room";
  document.title = view === "room" ? "Shadowlatch: room" : "Shadowlatch: rooms that vanish";
  if (view !== "room") setDrift(3, 1);
}

// Misregistration of the stone plate: 0 right after a message, up to ~9px at expiry.
// Slow at first, then accelerating, so the last stretch is unmistakable.
function setDrift(px, left) {
  const root = document.documentElement.style;
  root.setProperty("--drift", `${px.toFixed(2)}px`);
  root.setProperty("--left", String(Math.max(0, Math.min(1, left))));
}

/* ---------- firebase ---------- */

async function boot() {
  app = initializeApp(firebaseConfig);
  auth = initializeAuth(app, { persistence: browserLocalPersistence });
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  if (useEmulator) {
    // Loaded only for local testing; CSP must be relaxed by hand for the emulator.
    const m = await import("../vendor/emulator.js");
    m.connect(auth, db);
  }
  const cred = await signInAnonymously(auth);
  uid = cred.user.uid;
}

/* ---------- routing ---------- */

function codeFromHash() {
  const c = normCode(location.hash.slice(1));
  return CODE_RE.test(c) ? c : null;
}

async function route() {
  const code = codeFromHash();
  if (!code) { leaveSession(); show("home"); return; }
  if (session && session.id === code) return;
  await enterRoom(code);
}

/* ---------- rooms ---------- */

async function createRoom() {
  el.create.disabled = true;
  try {
    const id = newCode();
    await setDoc(doc(db, "rooms", id), {
      createdAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + HOUR),
      last: "",
    });
    location.hash = id;
  } catch (e) {
    toast(friendlyError(e, "Couldn't open a room"));
  } finally {
    el.create.disabled = false;
  }
}

async function enterRoom(id, { fresh = false } = {}) {
  leaveSession();
  el.joinMsg.textContent = "";
  el.joinCode.removeAttribute("aria-invalid");
  try {
    const snap = await getDoc(doc(db, "rooms", id));
    if (!snap.exists()) throw Object.assign(new Error("missing"), { code: "permission-denied" });
  } catch (e) {
    history.replaceState(null, "", location.pathname);
    show("home");
    el.joinMsg.textContent = isDenied(e) ? "No live room has that code. It may have expired." : friendlyError(e, "Couldn't reach the room");
    el.joinCode.value = fmtCode(id);
    el.joinCode.setAttribute("aria-invalid", "true");
    return;
  }

  const s = session = { id, expireAt: 0, unsubs: [], ids: new Set(), ended: false, lastCount: 0, initial: true };
  el.code.textContent = fmtCode(id);
  el.msgs.replaceChildren();
  el.feed.classList.remove("has-msgs");
  show("room");
  tick();
  s.timer = setInterval(tick, 1000);

  const roomRef = doc(db, "rooms", id);
  s.unsubs.push(onSnapshot(roomRef, (snap) => {
    if (!snap.exists()) return end(s, "The room was deleted.");
    const exp = snap.data({ serverTimestamps: "estimate" }).expireAt;
    s.expireAt = exp.toMillis();
    tick();
  }, (e) => end(s, isDenied(e) ? "The room expired or was burned." : null)));

  const q = query(collection(db, "rooms", id, "messages"), orderBy("createdAt", "asc"), limit(300));
  s.unsubs.push(onSnapshot(q, (snap) => {
    snap.docChanges().forEach((c) => { if (c.type === "added") s.ids.add(c.doc.id); });
    renderMessages(s, snap.docs);
  }, (e) => { if (isDenied(e)) end(s, "The room expired or was burned."); }));

  el.draft.focus({ preventScroll: true });
}

function leaveSession() {
  if (!session) return;
  session.unsubs.forEach((u) => u());
  clearInterval(session.timer);
  session = null;
}

// The room is over. Whoever notices first sweeps what they saw; the TTL policy is the backstop.
async function end(s, why) {
  if (s.ended) return;
  s.ended = true;
  const ids = [...s.ids];
  leaveSession();
  history.replaceState(null, "", location.pathname);
  el.endedWhy.textContent = why || "It reached its hour of silence and was deleted.";
  show("ended");
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const b = writeBatch(db);
      ids.slice(i, i + 100).forEach((m) => b.delete(doc(db, "rooms", s.id, "messages", m)));
      await b.commit();
    }
    const b = writeBatch(db);
    b.delete(doc(db, "rooms", s.id));
    await b.commit();
  } catch { /* another device swept first, or the TTL policy will */ }
}

function tick() {
  const s = session;
  if (!s || !s.expireAt) return;
  const msLeft = s.expireAt - Date.now();
  if (msLeft <= 0) { end(s, null); return; }
  const m = Math.floor(msLeft / 60000), sec = Math.floor((msLeft % 60000) / 1000);
  el.expiryTime.textContent = `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  el.expiry.toggleAttribute("data-urgent", msLeft <= 5 * 60000);
  const idle = 1 - Math.min(1, msLeft / HOUR);
  setDrift(9 * idle ** 1.8, msLeft / HOUR);
}

/* ---------- messages ---------- */

const ADJ = ["amber", "brisk", "calm", "dusky", "eager", "fleet", "gentle", "hazy", "keen", "lucid", "mellow", "nimble", "ochre", "plucky", "quiet", "rapid"];
const NOUN = ["fox", "heron", "otter", "lynx", "wren", "moth", "newt", "finch", "marten", "ibis", "stoat", "tern", "vole", "yak", "pika", "crane"];
function nameFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${ADJ[h & 15]} ${NOUN[(h >>> 4) & 15]}`;
}

function parseBody(kind, body) {
  if (kind === "code") return [{ code: true, text: body }];
  const parts = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push({ code: false, text: body.slice(last, m.index) });
    parts.push({ code: true, text: m[1].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < body.length) parts.push({ code: false, text: body.slice(last) });
  return parts.filter((p) => p.code || p.text.trim());
}

function buildMessage(id, d) {
  const mine = d.uid === uid;
  const li = document.createElement("li");
  li.className = `msg ${mine ? "msg--me" : "msg--them"}`;
  li.dataset.id = id;

  const head = document.createElement("div");
  head.className = "msg__head";
  const who = document.createElement("span");
  who.className = "msg__who";
  who.textContent = mine ? "You" : nameFor(d.uid);
  const time = document.createElement("time");
  time.className = "msg__time";
  const ts = d.createdAt ? d.createdAt.toDate() : new Date();
  time.dateTime = ts.toISOString();
  time.textContent = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  head.append(who, time);
  li.append(head);

  for (const part of parseBody(d.kind, d.body)) {
    if (!part.code) {
      const p = document.createElement("p");
      p.className = "msg__text";
      p.textContent = part.text.replace(/^\n+|\n+$/g, ""); // textContent only: never HTML
      li.append(p);
      continue;
    }
    const fig = document.createElement("figure");
    fig.className = "code";
    const bar = document.createElement("div");
    bar.className = "code__bar";
    const label = document.createElement("span");
    label.className = "code__label";
    label.textContent = "Code";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "code__copy";
    btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-copy"/></svg><span>Copy</span>';
    btn.addEventListener("click", async () => {
      await copyText(part.text, "Code copied");
      const lab = btn.querySelector("span");
      lab.textContent = "Copied";
      setTimeout(() => (lab.textContent = "Copy"), 1500);
    });
    const tools = document.createElement("div");
    tools.className = "code__tools";
    const wrapBtn = document.createElement("button");
    wrapBtn.type = "button"; wrapBtn.className = "code__copy code__wrap"; wrapBtn.textContent = "Wrap"; wrapBtn.setAttribute("aria-pressed", "false");
    const expandBtn = document.createElement("button");
    expandBtn.type = "button"; expandBtn.className = "code__copy code__expand"; expandBtn.textContent = "Expand"; expandBtn.hidden = true; expandBtn.setAttribute("aria-pressed", "false");
    tools.append(wrapBtn, expandBtn, btn);
    bar.append(label, tools);
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    const code = document.createElement("code");
    code.textContent = part.text;
    pre.append(code);
    fig.append(bar, pre);
    li.append(fig);
  }
  return li;
}

// Code blocks: lines wrap by default on phones (so nothing is cut off at the edge) and scroll sideways on
// wide screens; Wrap flips that, Expand lifts the height cap on tall blocks. Copy always copies the original.
function setupCode(fig) {
  const pre = fig.querySelector("pre"), wrapBtn = fig.querySelector(".code__wrap"), expandBtn = fig.querySelector(".code__expand");
  const sync = () => { expandBtn.hidden = !(fig.classList.contains("is-expanded") || pre.scrollHeight > pre.clientHeight + 1); };
  const setWrap = (on) => { fig.classList.toggle("is-wrapped", on); wrapBtn.setAttribute("aria-pressed", String(on)); sync(); };
  setWrap(window.innerWidth < 640);
  wrapBtn.addEventListener("click", () => setWrap(!fig.classList.contains("is-wrapped")));
  expandBtn.addEventListener("click", () => {
    const on = fig.classList.toggle("is-expanded");
    expandBtn.textContent = on ? "Collapse" : "Expand";
    expandBtn.setAttribute("aria-pressed", String(on));
    sync();
  });
}

// Long text collapses to 12 lines with a Show more toggle; short text is left alone.
function clampLong(p) {
  p.classList.add("is-clamped");
  if (p.scrollHeight <= p.clientHeight + 1) { p.classList.remove("is-clamped"); return; }
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "msg__more"; btn.textContent = "Show more"; btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => {
    const open = p.classList.toggle("is-clamped") === false;
    btn.textContent = open ? "Show less" : "Show more";
    btn.setAttribute("aria-expanded", String(open));
  });
  p.after(btn);
}

function renderMessages(s, docs) {
  if (session !== s) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  const seen = new Set();
  docs.forEach((d) => {
    seen.add(d.id);
    const data = d.data({ serverTimestamps: "estimate" });
    const existing = el.msgs.querySelector(`[data-id="${d.id}"]`);
    if (existing) {
      // Pending local write resolving: keep the node, no re-animation.
      return;
    }
    const node = buildMessage(d.id, data);
    if (s.initial) node.style.animation = "none";
    el.msgs.append(node);
    node.querySelectorAll(".msg__text").forEach(clampLong);
    node.querySelectorAll(".code").forEach(setupCode);
  });
  [...el.msgs.children].forEach((n) => { if (!seen.has(n.dataset.id)) n.remove(); });
  s.initial = false;
  el.feed.classList.toggle("has-msgs", el.msgs.children.length > 0);
  if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
}

async function sendMessage() {
  const s = session;
  if (!s) return;
  const body = el.draft.value.replace(/\r\n/g, "\n");
  if (!body.trim()) return;
  if (body.length > MAX_BODY) { toast(`Messages are limited to ${MAX_BODY.toLocaleString()} characters`); return; }
  const kind = el.composer.querySelector('input[name="kind"]:checked').value;

  const msgRef = doc(collection(db, "rooms", s.id, "messages"));
  const batch = writeBatch(db);
  const now = Date.now();
  batch.set(msgRef, {
    uid, kind, body,
    createdAt: serverTimestamp(),
    expireAt: Timestamp.fromMillis(now + DAY),
  });
  batch.update(doc(db, "rooms", s.id), { expireAt: Timestamp.fromMillis(now + HOUR), last: msgRef.id });

  el.send.disabled = true;
  const saved = el.draft.value;
  el.draft.value = "";
  autosize();
  try {
    await batch.commit();
  } catch (e) {
    el.draft.value = saved; autosize();
    toast(friendlyError(e, "Message not sent"));
  } finally {
    updateSend();
    el.draft.focus();
  }
}

/* ---------- ui wiring ---------- */

function autosize() {
  el.draft.style.height = "auto";
  const share = window.innerWidth < 640 ? 0.28 : 0.4; // leave the chat visible above a long draft on phones
  el.draft.style.height = `${Math.min(el.draft.scrollHeight + 4, window.innerHeight * share)}px`;
}
function updateSend() { el.send.disabled = !el.draft.value.trim(); }

function isDenied(e) { return e && (e.code === "permission-denied" || e.code === "not-found"); }
function friendlyError(e, fallback) {
  if (!navigator.onLine) return "You're offline. Check your connection.";
  if (isDenied(e)) return `${fallback}. If your device clock is off by more than a few minutes, fix it and retry.`;
  return fallback + ".";
}

el.create.addEventListener("click", createRoom);

el.joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const code = normCode(el.joinCode.value);
  if (!CODE_RE.test(code)) {
    el.joinMsg.textContent = "Codes are 12 letters and numbers, like K7QM-X2PD-9RTA.";
    el.joinCode.setAttribute("aria-invalid", "true");
    el.joinCode.focus();
    return;
  }
  el.joinMsg.textContent = "";
  el.joinCode.removeAttribute("aria-invalid");
  if (location.hash.slice(1) === code) route(); else location.hash = code;
});
el.joinCode.addEventListener("input", () => {
  const raw = normCode(el.joinCode.value).slice(0, 12);
  el.joinCode.value = raw.replace(/(.{4})(?=.)/g, "$1-");
  el.joinMsg.textContent = "";
  el.joinCode.removeAttribute("aria-invalid");
});

el.homeLink.addEventListener("click", (e) => {
  e.preventDefault();
  history.replaceState(null, "", location.pathname);
  route();
});
el.leave.addEventListener("click", () => { history.replaceState(null, "", location.pathname); route(); });
el.endedNew.addEventListener("click", () => { show("home"); createRoom(); });

const inviteLink = () => `${location.origin}${location.pathname}#${session.id}`;
const roomCode = () => fmtCode(session.id); // just the code, nothing else
el.copyCode.addEventListener("click", () => session && copyText(roomCode(), "Room code copied"));
el.emptyCopyCode.addEventListener("click", () => session && copyText(roomCode(), "Room code copied"));
el.copyLink.addEventListener("click", () => session && copyText(inviteLink(), "Invite link copied"));
el.emptyCopy.addEventListener("click", () => session && copyText(inviteLink(), "Invite link copied"));

el.burn.addEventListener("click", () => el.burnDialog.showModal());
el.burnDialog.addEventListener("close", async () => {
  if (el.burnDialog.returnValue !== "burn" || !session) return;
  const s = session;
  try {
    await updateDoc(doc(db, "rooms", s.id), { expireAt: serverTimestamp() });
  } catch (e) {
    toast(friendlyError(e, "Couldn't burn the room"));
  }
});

el.composer.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
el.draft.addEventListener("input", () => { autosize(); updateSend(); });
el.draft.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
  if (e.key === "Tab" && el.composer.dataset.kind === "code") {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = el.draft;
    el.draft.value = `${value.slice(0, a)}  ${value.slice(b)}`;
    el.draft.selectionStart = el.draft.selectionEnd = a + 2;
  }
});
el.composer.addEventListener("change", (e) => {
  if (e.target.name !== "kind") return;
  el.composer.dataset.kind = e.target.value;
  el.hint.textContent = e.target.value === "code" ? "Tab indents. Ctrl + Enter to send" : "Ctrl + Enter to send. Wrap code in ``` fences";
  autosize();
});
el.composer.dataset.kind = "text";
el.hint.textContent = "Ctrl + Enter to send. Wrap code in ``` fences";

// Pasting several lines that look like code flips to Code mode once, so it renders as a block.
el.draft.addEventListener("paste", (e) => {
  const t = e.clipboardData?.getData("text") || "";
  if (el.draft.value === "" && t.split("\n").length > 2 && /[{};=<>()]|^\s{2,}\S/m.test(t) && !t.includes("```")) {
    $("kind-code").checked = true;
    $("kind-code").dispatchEvent(new Event("change", { bubbles: true }));
    el.hint.textContent = "Switched to Code. Tab indents. Ctrl + Enter to send";
  }
});

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => session && autosize());

/* ---------- theme ---------- */

function applyTheme(t, save) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#141517" : "#efefed";
  el.theme.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if (save) { try { localStorage.setItem("sl-theme", t); } catch { /* private mode */ } }
}
el.theme.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null; try { saved = localStorage.getItem("sl-theme"); } catch { /* ignore */ }
  if (!saved) applyTheme(e.matches ? "dark" : "light", false);
});
applyTheme(document.documentElement.dataset.theme || "light", false);

/* ---------- go ---------- */

show("home");
el.create.disabled = true; el.joinBtn.disabled = true;
boot().then(() => {
  el.create.disabled = false; el.joinBtn.disabled = false;
  return route();
}).catch((e) => {
  console.error(e);
  el.joinMsg.textContent = "Couldn't connect. Check your connection or the Firebase setup.";
});
