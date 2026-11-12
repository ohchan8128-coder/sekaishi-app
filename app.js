"use strict";
/*
 * 世界史 復習アプリ
 * - 問題データは端末(localStorage)に保存し、GitHubの非公開リポジトリと同期する
 * - トークンはこの端末の localStorage にだけ保存する（コードには書かない）
 * - データは3種類
 *     一問一答 … front / back / memo
 *     出来事   … kind:"event"。年号(year, yearEnd)・地域(region)・説明(desc)つき。front/back は自動で作る
 *     まとめメモ … kind:"note"。key は「地域|世紀」
 *     事典の直し・追加 … kind:"jt"。id は「jt|項目名」、data に項目の中身
 */
const DAY = 86400000;
const DEFAULT_DECK = "世界史";
const LS = { cards: "sk.cards", token: "sk.token", settings: "sk.settings", dirty: "sk.dirty", last: "sk.lastSync", chap: "sk.chap", qset: "sk.qset" };
const CH_META_ID = "meta|chapters-all";
const REGIONS = ["ヨーロッパ", "西アジア", "南アジア", "東南アジア", "中国", "朝鮮・日本", "内陸アジア", "アフリカ", "アメリカ", "国際"];
const RCOLOR = { "ヨーロッパ": "#2563eb", "西アジア": "#a16207", "南アジア": "#db2777", "東南アジア": "#059669", "中国": "#dc2626",
  "朝鮮・日本": "#7c3aed", "内陸アジア": "#0891b2", "アフリカ": "#65a30d", "アメリカ": "#ea580c", "国際": "#475569" };
const STARTER_TAG = "基本セット";
const PROMPT_EVENT = `次の範囲の重要な出来事を、1行に1つ、次の形で書いてください。
年 ｜ 出来事名 ｜ 地域 ｜ 説明（1文）
・年は半角数字。紀元前は「前221」、期間は「1337〜1453」のように書く
・地域は「${REGIONS.join("／")}」から選ぶ
・前置き・見出し・番号は書かない
・教科書によって年号が違うものや、自信がないものは、行の最後に「要確認」と書く
範囲：（ここに範囲を書く）`;
const PROMPT_CARD = `次の範囲の一問一答を、1行に1問「問題 ｜ 答え」の形で作ってください。
・答えは用語・人名・年号などの短い語句にする
・前置き・見出し・番号は書かない
・自信がない内容は問題にしない
範囲：（ここに範囲を書く）`;

/* ---------- localStorage ---------- */
function lsGet(k, d){ try{ const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch(e){ return d; } }
function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } }
function token(){ try{ return localStorage.getItem(LS.token) || ""; } catch(e){ return ""; } }
function setToken(t){ try{ if (t) localStorage.setItem(LS.token, t); else localStorage.removeItem(LS.token); } catch(e){} }
function defaultOwner(){ const h = location.hostname; return h.endsWith(".github.io") ? h.slice(0, -".github.io".length) : ""; }
function settings(){
  const s = lsGet(LS.settings, {});
  return { owner: s.owner || defaultOwner(), repo: s.repo || "sekaishi-data", path: s.path || "cards.json" };
}

/* ---------- 状態 ---------- */
const S = {
  cards: (() => { const c = lsGet(LS.cards, []); return Array.isArray(c) ? c : []; })(),
  view: "home", deck: "すべて",
  session: null, practice: null,
  pset: { deck: "すべて", tag: "", order: "random", count: 20 },
  qset: Object.assign({ chap: "", region: "", era: "", order: "random", count: 20 }, lsGet("sk.qset", {})),
  quiz: null,
  add: { mode: "one", deck: DEFAULT_DECK, tags: "", front: "", back: "", memo: "", bulk: "", bulkKind: "event", bulkRegion: "", bsrs: true, confirmStarterDel: false },
  aev: { title: "", year: "", region: "", desc: "", tags: "", related: "", srs: true },
  yset: { mode: "sort", region: "すべて", from: "", to: "", tag: "", n: 4, near: false, total: 10 },
  yd: null,
  jt: { type: "E", ch: 0, q: "" },
  note: { mode: "chap", region: null, cent: null, line: "すべて", q: "", chap: lsGet(LS.chap, 1), chDel: null },
  q: "", listDeck: "すべて", listKind: "all",
  sheet: [], edit: null, confirmDel: false,
  sync: { state: "idle", msg: "" }, localVer: 0,
  form: null, testMsg: null
};

/* ---------- 小道具 ---------- */
const $ = s => document.querySelector(s);
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function nl(s){ return esc(s).replace(/\n/g, "<br>"); }
function startOfDay(t){ const d = new Date(t); d.setHours(0,0,0,0); return d.getTime(); }
function endOfToday(){ return startOfDay(Date.now()) + DAY - 1; }
function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function live(){ return S.cards.filter(c => !c.deleted && c.kind !== "note" && c.kind !== "meta" && c.kind !== "jt"); }
function card(id){ return S.cards.find(c => c.id === id && !c.deleted); }
function isEv(c){ return !!c && c.kind === "event" && Number.isFinite(c.year); }
function evs(){ return live().filter(isEv); }
function tagsOf(c){ return Array.isArray(c.tags) ? c.tags : []; }
function parseTags(s){ return String(s || "").split(/[,、，\s]+/).map(t => t.trim()).filter(Boolean).slice(0, 8); }
function deckOf(c){ return c.deck || DEFAULT_DECK; }
function decks(){ const s = new Set([DEFAULT_DECK]); live().forEach(c => s.add(deckOf(c))); return [...s]; }
function inDeck(c, d){ return d === "すべて" || deckOf(c) === d; }
function shuffle(a){ a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function fmtDate(t){ if (!t) return "—"; const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; }
function toast(m){ const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200); }
function dueList(d){
  const end = endOfToday();
  return live().filter(c => c.srs !== false && inDeck(c, d) && (c.due || 0) <= end)
    .sort((a, b) => ((a.reps ? 0 : 1) - (b.reps ? 0 : 1)) || ((a.due || 0) - (b.due || 0)));
}
function fmtIv(days){ if (days <= 0) return "10分"; if (days < 30) return days + "日"; if (days < 365) return Math.round(days / 30) + "か月"; return "1年"; }
function dueLabel(c){
  if (!c.reps) return "新規";
  const diff = Math.round((startOfDay(c.due || 0) - startOfDay(Date.now())) / DAY);
  return diff <= 0 ? "今日復習" : diff === 1 ? "明日" : diff + "日後";
}

/* ---------- 年号 ---------- */
function z2h(s){ return String(s ?? "").replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)); }
// 「1077」「前221」「紀元前221年」「-221」「1337〜1453」「前264〜前146」「1299頃」を読む
function parseYearText(t){
  let s = z2h(t).trim().replace(/\s+/g, "");
  if (!s) return null;
  let approx = false;
  if (/(頃|ごろ|ころ)$/.test(s)){ approx = true; s = s.replace(/(頃|ごろ|ころ)$/, ""); }
  s = s.replace(/紀元前/g, "前").replace(/^BC/i, "前").replace(/年/g, "");
  const m = s.match(/^(前|[-−])?(\d{1,4})(?:[〜～~\-－–—―](前|BC)?(\d{1,4}))?$/i);
  if (!m) return null;
  const a = +m[2]; if (!a) return null;
  const year = m[1] ? -a : a;
  let yearEnd = null;
  if (m[4]){
    const b = +m[4]; if (!b) return null;
    yearEnd = m[3] ? -b : b;
    if (yearEnd < year) return null;
    if (yearEnd === year) yearEnd = null;
  }
  return { year, yearEnd, approx };
}
function yearStr(y){ return y < 0 ? "前" + (-y) : String(y); }
function yearShort(e){ return yearStr(e.year) + (e.yearEnd != null ? "〜" + yearStr(e.yearEnd) : ""); }
function yearLabel(e){ return yearShort(e) + "年" + (e.approx ? "頃" : ""); }
function yearInput(e){ return yearShort(e) + (e.approx ? "頃" : ""); }
function centuryOf(y){ return y < 0 ? -Math.ceil(-y / 100) : Math.ceil(y / 100); }
function centLabel(c){ return c < 0 ? `前${-c}世紀` : `${c}世紀`; }
function centSpan(c){ return c < 0 ? `前${-c * 100}〜前${(-c - 1) * 100 + 1}年` : `${(c - 1) * 100 + 1}〜${c * 100}年`; }
function byYear(a, b){ return a.year - b.year || (a.yearEnd ?? a.year) - (b.yearEnd ?? b.year) || String(a.title).localeCompare(String(b.title), "ja"); }

/* ---------- 地域 ---------- */
function rName(r){ return r || "地域なし"; }
function rDot(r){ return `<span class="rg"><i style="background:${RCOLOR[r] || "#9ca3af"}"></i>${esc(rName(r))}</span>`; }
function regionOrder(list){
  const set = new Set(list.map(e => e.region || ""));
  const out = REGIONS.filter(r => set.has(r));
  [...set].filter(r => r && !REGIONS.includes(r)).sort((a, b) => a.localeCompare(b, "ja")).forEach(r => out.push(r));
  if (set.has("")) out.push("");
  return out;
}

/* ---------- 関連さがし ---------- */
function stripParen(t){ return String(t || "").replace(/（[^）]*）|\([^)]*\)/g, "").trim(); }
function kw(e){
  const t = String(e.title || "");
  const parts = t.split(/[・、，,（）()「」『』\s]+/).filter(p => p.length >= 3 && p !== t);
  return [t, ...parts].filter(k => k.length >= 2);
}
function mentions(text, e){ return !!text && kw(e).some(k => text.includes(k)); }
function cardText(c){ return [c.front, c.back, c.memo].join("\n"); }
function nameHit(names, e){ return Array.isArray(names) && names.some(n => n === e.title || n === stripParen(e.title)); }
function linkedOf(e, list){
  const ids = new Set(Array.isArray(e.related) ? e.related : []);
  for (const x of list){
    if (x.id === e.id) continue;
    if ((Array.isArray(x.related) && x.related.includes(e.id)) || nameHit(e.relNames, x) || nameHit(x.relNames, e)
        || mentions(e.desc, x) || mentions(x.desc, e)) ids.add(x.id);
  }
  ids.delete(e.id);
  return list.filter(x => ids.has(x.id)).sort(byYear);
}
function unresolvedOf(e, list){ return (Array.isArray(e.relNames) ? e.relNames : []).filter(n => !list.some(x => x.title === n || stripParen(x.title) === n)); }
function flowOf(e, list){
  const same = list.filter(x => (x.region || "") === (e.region || "")).sort(byYear);
  const i = same.findIndex(x => x.id === e.id);
  return { prev: same.slice(Math.max(0, i - 2), i), next: same.slice(i + 1, i + 3) };
}
function sameTimeOf(e, list, w = 25){
  return list.filter(x => (x.region || "") !== (e.region || "") && Math.abs(x.year - e.year) <= w)
    .sort((a, b) => Math.abs(a.year - e.year) - Math.abs(b.year - e.year) || a.year - b.year).slice(0, 8).sort(byYear);
}
function cardsAbout(e){ return live().filter(c => !isEv(c) && mentions(cardText(c), e)).slice(0, 10); }
function eventsIn(c){ const t = cardText(c); return evs().filter(e => mentions(t, e)).sort(byYear).slice(0, 5); }
function resolveRelated(text, selfId){
  const names = String(text || "").split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean);
  const list = evs().filter(e => e.id !== selfId); const ids = [], miss = [];
  names.forEach(n => {
    const x = list.find(e => e.title === n) || list.find(e => stripParen(e.title) === n);
    if (x){ if (!ids.includes(x.id)) ids.push(x.id); } else if (!miss.includes(n)) miss.push(n);
  });
  return { ids, miss };
}

/* ---------- まとめメモ ---------- */
function noteKey(r, c){ return `${r === null ? "" : rName(r)}|${c === null ? "" : c}`; }
function noteOf(key){ const n = S.cards.find(c => c.id === "note|" + key && !c.deleted); return n ? n.text || "" : ""; }
function setNote(key, text){
  const id = "note|" + key, t = String(text || "").trim();
  if (t) putCard({ id, kind: "note", key, text: t });
  else if (card(id)) putCard({ id, deleted: true });
}
function noteLabel(key){
  const i = key.lastIndexOf("|"), r = key.slice(0, i), c = key.slice(i + 1);
  const cl = c === "" ? "" : centLabel(+c);
  return r && cl ? `${r}・${cl}` : r ? `${r}（全体）` : `${cl}（全体）`;
}

/* ---------- 間隔反復（SM-2 を簡略化） r: 0=もう一度 1=難しい 2=正解 3=簡単 ---------- */
function schedule(c, r){
  let ease = c.ease || 2.5, iv = c.interval || 0, reps = c.reps || 0, lapses = c.lapses || 0;
  const t = Date.now(); let due;
  if (r === 0){ reps = 0; lapses++; ease = Math.max(1.3, ease - 0.2); iv = 0; due = t + 10 * 60000; }
  else {
    if (r === 1){ iv = reps === 0 ? 1 : Math.max(iv + 1, Math.round(iv * 1.2)); ease = Math.max(1.3, ease - 0.15); }
    else if (r === 2){ iv = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(iv + 1, Math.round(iv * ease)); }
    else { iv = reps === 0 ? 3 : Math.max(iv + 2, Math.round(Math.max(iv, 1) * ease * 1.3)); ease += 0.15; }
    iv = Math.min(iv, 365); reps++; due = startOfDay(t) + iv * DAY;
  }
  return { ease: Math.round(ease * 100) / 100, interval: iv, reps, lapses, due, last: t };
}

/* ---------- 変更の保存 ---------- */
function commit(ms){
  S.localVer++;
  if (!lsSet(LS.cards, S.cards)) toast("端末に保存できませんでした（容量不足？）");
  lsSet(LS.dirty, true);
  renderPill(); scheduleSync(ms);
}
function putCard(c){
  c.updatedAt = Date.now();
  const i = S.cards.findIndex(x => x.id === c.id);
  if (i >= 0) S.cards[i] = c; else S.cards.push(c);
}
function createCard(f){
  const t = Date.now();
  putCard({ id: newId(), deck: f.deck || DEFAULT_DECK, tags: f.tags || [], front: f.front, back: f.back, memo: f.memo || "",
            created: t, due: t, interval: 0, ease: 2.5, reps: 0, lapses: 0 });
}
function evFront(e){ return e.yearEnd != null ? `「${e.title}」が始まったのは何年？` : `「${e.title}」は何年？`; }
function evFields(f){
  const e = { kind: "event", title: f.title, year: f.year, yearEnd: f.yearEnd ?? null, approx: !!f.approx,
    region: f.region || "", desc: f.desc || "", tags: f.tags || [], related: f.related || [], relNames: f.relNames || [], srs: f.srs !== false };
  e.front = evFront(e); e.back = yearLabel(e); e.memo = e.desc;
  return e;
}
function createEvent(f, id){
  const t = Date.now();
  putCard(Object.assign({ id: id || newId(), deck: DEFAULT_DECK, created: t, due: t, interval: 0, ease: 2.5, reps: 0, lapses: 0 }, evFields(f)));
}
function updateCard(id, patch){ const c = card(id); if (!c) return; putCard(Object.assign({}, c, patch)); }
function deleteCard(id){ putCard({ id, deleted: true }); }

/* ---------- GitHub 同期 ---------- */
function b64encode(str){
  const bytes = new TextEncoder().encode(str); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64){
  const bin = atob(String(b64).replace(/\s/g, "")); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function repoUrl(s){ return `https://api.github.com/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`; }
function fileUrl(s){ return repoUrl(s) + "/contents/" + s.path.split("/").map(encodeURIComponent).join("/"); }
function gh(url, opt = {}){
  const headers = { Authorization: "Bearer " + token(), Accept: opt.accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (opt.body) headers["Content-Type"] = "application/json";
  return fetch(url, { method: opt.method || "GET", headers, cache: "no-store", body: opt.body ? JSON.stringify(opt.body) : undefined });
}
function httpMsg(status){
  if (status === 401) return "トークンが正しくないか、期限が切れています";
  if (status === 403) return "権限が足りません（Contents の Read and write を確認）";
  if (status === 404) return "リポジトリが見つからないか、トークンがそのリポジトリを使えません";
  if (status === 409 || status === 422) return "ほかの端末と同時に保存しようとしました。もう一度同期してね";
  return "GitHub との通信でエラーが起きました（" + status + "）";
}
class HttpError extends Error { constructor(status){ super(httpMsg(status)); this.status = status; } }
async function fetchRemote(s){
  const r = await gh(fileUrl(s));
  if (r.status === 404) return { cards: [], sha: null };
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  let text;
  if (j.content && j.encoding === "base64") text = b64decode(j.content);
  else { const r2 = await gh(fileUrl(s), { accept: "application/vnd.github.raw+json" }); if (!r2.ok) throw new HttpError(r2.status); text = await r2.text(); }
  let data; try { data = JSON.parse(text || "{}"); } catch(e){ throw new Error("記録ファイルの中身を読めませんでした"); }
  return { cards: Array.isArray(data.cards) ? data.cards : [], sha: j.sha };
}
function merge(a, b){
  const m = new Map();
  for (const c of [...a, ...b]){
    if (!c || typeof c.id !== "string") continue;
    const p = m.get(c.id);
    if (!p || (c.updatedAt || 0) > (p.updatedAt || 0)) m.set(c.id, c);
  }
  return [...m.values()];
}
function canon(cards){ return JSON.stringify(cards.slice().sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0)); }

let syncing = false, again = false, syncTimer = null;
function scheduleSync(ms = 4000){ clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }
async function sync(manual){
  const s = settings();
  if (!token() || !s.owner){ S.sync = { state: "unset", msg: "" }; renderPill(); return; }
  if (!navigator.onLine){ S.sync = { state: "offline", msg: "" }; renderPill(); if (manual) toast("オフラインです。つながったら送ります"); return; }
  if (syncing){ again = true; return; }
  syncing = true; S.sync = { state: "syncing", msg: "" }; renderPill();
  const v0 = S.localVer;
  try{
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++){
      const remote = await fetchRemote(s);
      const merged = merge(S.cards, remote.cards);
      if (canon(merged) !== canon(remote.cards)){
        const body = { message: "update " + new Date().toISOString(),
          content: b64encode(JSON.stringify({ version: 1, updated: Date.now(), cards: merged })) };
        if (remote.sha) body.sha = remote.sha;
        const r = await gh(fileUrl(s), { method: "PUT", body });
        if (r.status === 409 || r.status === 422) continue;
        if (!r.ok) throw new HttpError(r.status);
      }
      S.cards = merge(merged, S.cards);
      lsSet(LS.cards, S.cards);
      ok = true;
    }
    if (!ok) throw new HttpError(409);
    ensureChapterCards();   // 記録をGitHubから受け取ってから、章の問題をまだ入れていなければ入れる
    if (S.localVer === v0) lsSet(LS.dirty, false); else again = true;
    lsSet(LS.last, Date.now());
    S.sync = { state: "ok", msg: "" };
    if (manual) toast("同期しました");
    refreshAfterSync();
  } catch(e){
    const offline = !navigator.onLine || e instanceof TypeError;
    S.sync = offline ? { state: "offline", msg: "" } : { state: "error", msg: e.message || String(e) };
    if (manual) toast(offline ? "通信できませんでした。あとで送ります" : "同期できませんでした");
  } finally {
    syncing = false; renderPill();
    if (again){ again = false; scheduleSync(1500); }
  }
}
function refreshAfterSync(){
  // 入力中の画面は書き換えない
  if (S.sheet.length) return;
  if (S.view === "home") renderMain();
  else if (S.view === "list") renderListItems();
  else if (S.view === "note") renderNoteBody();
  else if (S.view === "jiten") renderJtBody();
  else if (S.view === "year" && !S.yd) renderMain();
  else if (S.view === "settings" && !S.form) renderMain();
}
function renderPill(){
  const p = $("#sync-pill"); const dirty = lsGet(LS.dirty, false);
  let cls = "pill", txt = "同期済み";
  const st = S.sync.state;
  if (!token()) { cls += " gray"; txt = "未設定"; }
  else if (st === "syncing") txt = "同期中…";
  else if (st === "error") { cls += " err"; txt = "同期エラー"; }
  else if (st === "offline" || !navigator.onLine) { cls += " warn"; txt = dirty ? "オフライン・未送信" : "オフライン"; }
  else if (dirty) { cls += " warn"; txt = "未送信あり"; }
  p.className = cls; p.textContent = txt;
}

/* ---------- 共通の部品 ---------- */
function chips(cur, act, list){
  return `<div class="chips">${list.map(d => `<button class="chip ${d === cur ? "on" : ""}" data-act="${act}" data-d="${esc(d)}">${esc(d || "すべて")}</button>`).join("")}</div>`;
}
// [値, 表示名] のリストからチップを作る
function kvChips(cur, act, key, list){
  return `<div class="chips">${list.map(([v, l]) => `<button class="chip ${v === cur ? "on" : ""}" data-act="${act}" data-k="${key}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
}
function evRow(e, o = {}){
  return `<button class="ev ${o.cur ? "cur" : ""}" data-act="${o.cur ? "" : "ev"}" data-id="${esc(e.id)}"><span class="yr">${esc(yearShort(e))}${e.approx ? "頃" : ""}</span>
    <span class="evb"><span class="tt">${esc(e.title)}</span>${o.region ? rDot(e.region) : ""}${o.desc && e.desc ? `<span class="ds">${esc(e.desc)}</span>` : ""}</span></button>`;
}
function evChip(e){ return `<button class="rchip" data-act="ev" data-id="${esc(e.id)}">${esc(yearShort(e))} ${esc(e.title)}</button>`; }
function emptyEvHTML(){
  return `<div class="card"><h2>年号つきの出来事がまだありません</h2>
    <p class="muted small" style="margin-top:-4px">「追加」から出来事を登録するか、基本の年号セットを入れると、年号ドリル・ノートが使えるようになるよ。</p>
    <button class="btn" data-act="goAddEvent">出来事を追加する</button></div>`;
}

/* ---------- 画面：復習 ---------- */
function homeHTML(){
  const due = dueList(S.deck), newN = due.filter(c => !c.reps).length;
  const pool = live().filter(c => c.srs !== false && inDeck(c, S.deck)); const t0 = startOfDay(Date.now());
  const within = n => pool.filter(c => c.reps && (c.due || 0) > endOfToday() && (c.due || 0) < t0 + (n + 1) * DAY).length;
  let h = "";
  if (!token()) h += `<div class="note">記録を GitHub に保存するには、まず<b>設定</b>（右上の ⚙︎）でトークンを入れてね。今のままでもこの端末の中には保存されるよ。</div>`;
  h += quizSetupHTML();
  if (decks().length > 1) h += chips(S.deck, "deck", ["すべて", ...decks()]);
  h += `<div class="card hero"><div class="big">${due.length}</div><div class="lbl">今日の復習</div>
    <div class="sub">復習 ${due.length - newN}・新しい問題 ${newN}</div>
    <button class="btn" data-act="start" ${due.length ? "" : "disabled"}>${due.length ? "復習を始める" : pool.length ? "今日の分は終わり！" : "まだ復習に送った問題がありません"}</button>
    <p class="small" style="margin:8px 0 0;opacity:.85">「問題」で復習に送った問題が、忘れかけたころにここに出てくるよ。</p></div>`;
  h += `<div class="btns" style="margin:-2px 0 12px"><button class="btn sec" data-act="nav" data-v="practice">練習（何周でも）</button><button class="btn sec" data-act="nav" data-v="year">年号ドリル</button></div>`;
  h += `<div class="card"><h2>この先の予定</h2><div class="stats">
    <div><b>${within(1)}</b><span>明日</span></div><div><b>${within(7)}</b><span>7日以内</span></div><div><b>${pool.length}</b><span>復習に入っている問題</span></div></div>
    ${pool.length ? `<div style="height:10px"></div><button class="btn line" data-act="goSrsList">復習に入っている問題を見る・外す</button>` : ""}</div>`;
  if (!live().length){
    h += `<div class="card"><h2>使い方</h2><ol class="guide">
      <li>「追加」で一問一答や、年号つきの出来事を登録する。Claude に作ってもらったものは「まとめて取り込む」に貼り付ける</li>
      <li>「問題」で範囲を選んで解き、覚えたい問題を毎日の復習に送ると、忘れかけたころに出てくる</li>
      <li>「ノート」の「章ごと」で、教科書の流れに沿った全24章のまとめを読み、その章の一問一答をまとめて追加できる</li>
      <li>「年号」で並び替え・年号当て、「ノート」で地域ごと・年代ごとのまとめが見られる</li>
      <li>「事典」で、出来事の原因・結果・関連人物、人物が何をしたか、国ごとの流れが見られる</li>
      <li>好きな範囲を何周もしたいときは「練習」</li></ol></div>`;
  }
  return h;
}
function reviewHTML(){
  const s = S.session; if (!s){ S.view = "home"; return homeHTML(); }
  while (s.idx < s.queue.length && !card(s.queue[s.idx])) s.idx++;
  if (s.idx >= s.queue.length){
    return `<div class="card done"><div class="big">おつかれさま！</div><p>${s.done}回答えて、「もう一度」は${s.again}回。</p>
      <p class="muted">間違えた問題は少し後と明日以降にまた出てくるよ。</p><button class="btn" data-act="nav" data-v="home">ホームへ</button></div>`;
  }
  const c = card(s.queue[s.idx]);
  let h = `<div class="progress"><i style="width:${Math.round(s.idx / s.queue.length * 100)}%"></i></div>
    <div class="muted small" style="margin-bottom:8px">${s.idx + 1} / ${s.queue.length}</div>${qHTML(c, s.shown)}`;
  if (!s.shown) h += `<button class="btn" data-act="show">答えを見る</button>`;
  else h += `<div class="rate">${["もう一度","難しい","正解","簡単"].map((n, r) =>
      `<button class="r${r}" data-act="rate" data-r="${r}">${n}<small>${fmtIv(schedule(c, r).interval)}</small></button>`).join("")}</div>`;
  h += `<div class="links"><button class="link" data-act="edit" data-id="${esc(c.id)}">この問題を直す</button><button class="link" data-act="rOut">復習から外す</button><button class="link" data-act="quit">中断する</button></div>`;
  return h;
}
function qHTML(c, shown){
  const ev = isEv(c);
  const meta = ev ? [rName(c.region), centLabel(centuryOf(c.year)), ...tagsOf(c)] : [deckOf(c), ...tagsOf(c)];
  let h = `<div class="card q"><div class="meta">${meta.map(esc).join(" ・ ")}${c.reps ? "" : " ・ 新しい問題"}</div><div class="front">${nl(c.front)}</div>`;
  if (shown){
    h += `<div class="back">${nl(c.back)}</div>`;
    if (ev){
      if (c.desc) h += `<p class="small" style="margin:8px 0 0">${nl(c.desc)}</p>`;
      h += `<div class="chipline"><button class="rchip" data-act="ev" data-id="${esc(c.id)}">関連・前後の流れを見る</button></div>`;
    } else {
      if (c.memo) h += `<details><summary>メモを見る</summary><div>${esc(c.memo)}</div></details>`;
      const rel = eventsIn(c);
      if (rel.length) h += `<div class="muted small" style="margin-top:10px">関連する出来事</div><div class="chipline" style="margin-top:4px">${rel.map(evChip).join("")}</div>`;
      h += jtChipsFor(c.front + "\n" + c.back);
    }
  }
  return h + `</div>`;
}
function practicePool(){ const p = S.pset; return live().filter(c => inDeck(c, p.deck) && (!p.tag || tagsOf(c).includes(p.tag))); }
function practiceHTML(){
  const P = S.practice;
  if (P){
    while (P.idx < P.queue.length && !card(P.queue[P.idx])) P.idx++;
    if (P.idx >= P.queue.length){
      const wrong = P.queue.filter(id => P.res[id] === false && card(id));
      const okN = P.queue.filter(id => P.res[id] === true).length;
      let h = `<div class="card done"><div class="big">${P.round}周目 終了</div><p>○ ${okN}問 ／ × ${wrong.length}問</p></div>`;
      if (wrong.length){
        h += `<div class="card"><h2>×だった問題</h2>${wrong.map(id => { const c = card(id); return `<div class="item" style="cursor:default"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div></div>`; }).join("")}</div>
          <button class="btn" data-act="pRetry">×だけもう一周</button>`;
      }
      return h + `<div class="btns"><button class="btn sec" data-act="pAgain">全部もう一周</button><button class="btn line" data-act="pEnd">終わる</button></div>`;
    }
    const c = card(P.queue[P.idx]);
    let h = `<div class="progress"><i style="width:${Math.round(P.idx / P.queue.length * 100)}%"></i></div>
      <div class="muted small" style="margin-bottom:8px">練習 ${P.round}周目　${P.idx + 1} / ${P.queue.length}</div>${qHTML(c, P.shown)}`;
    h += P.shown ? `<div class="two"><button class="x" data-act="pAns" data-ok="0">× まだ</button><button class="o" data-act="pAns" data-ok="1">○ 覚えた</button></div>`
                 : `<button class="btn" data-act="pShow">答えを見る</button>`;
    return h + `<div class="links"><button class="link" data-act="edit" data-id="${esc(c.id)}">この問題を直す</button><button class="link" data-act="pEnd">やめる</button></div>`;
  }
  const p = S.pset;
  const tags = [...new Set(live().filter(c => inDeck(c, p.deck)).flatMap(tagsOf))];
  if (p.tag && !tags.includes(p.tag)) p.tag = "";
  const n = practicePool().length;
  let h = `<div class="card"><h2>好きな範囲を何周でも</h2><p class="muted small" style="margin-top:-4px">ここで解いても「復習」のスケジュールは変わらないよ。</p>
    <label class="f">科目</label>${chips(p.deck, "pDeck", ["すべて", ...decks()])}`;
  if (tags.length) h += `<label class="f">タグ</label>${chips(p.tag, "pTag", ["", ...tags])}`;
  h += `<label class="f">順番</label>${chips(p.order === "random" ? "ランダム" : "登録順", "pOrder", ["ランダム", "登録順"])}
    <label class="f">問題数</label>${chips(p.count ? p.count + "問" : "全部", "pCount", ["10問", "20問", "50問", "全部"])}
    <div style="height:8px"></div><button class="btn" data-act="pStart" ${n ? "" : "disabled"}>${n ? `始める（対象 ${n}問）` : "対象の問題がありません"}</button></div>`;
  return h;
}

/* ---------- 画面：問題（範囲を選んでランダム出題） ---------- */
const ERAS = [["A", "古代", "〜5世紀"], ["M", "中世", "6〜15世紀"], ["E", "近世", "16〜18世紀"], ["K", "近代", "19世紀〜1914年"], ["G", "現代", "1914年〜"]];
function eraName(code){ const x = ERAS.find(e => e[0] === code); return x ? x[1] : ""; }
let CHMETA = null;
// 章の問題のID → { no: 章, r: [地域], e: "時代コード" }
function chMeta(id){
  if (!CHMETA){
    CHMETA = new Map();
    chList().forEach(ch => ch.qa.forEach(x => CHMETA.set(chId(ch, x[0]), { no: ch.no, r: String(x[2] || "").split(",").filter(Boolean), e: String(x[3] || "") })));
  }
  return CHMETA.get(id) || null;
}
// 章の問題を全部「問題」に入れる（最初の1回だけ。毎日の復習には入れない）
// 更新時刻をいちばん古い値にしておくので、同期やバックアップの記録（解いた結果・削除）が必ず優先される
function ensureChapterCards(){
  if (!chList().length || S.cards.some(c => c.id === CH_META_ID)) return false;
  const ids = new Set(S.cards.map(c => c.id)), t = Date.now(); let n = 0, k = 0;
  const putOld = c => { putCard(c); c.updatedAt = 1; };
  chList().forEach(ch => ch.qa.forEach(([q, a]) => {
    const id = chId(ch, q); k++;
    if (ids.has(id)) return;   // すでにある（自分で消したものも含む）ならそのまま
    putOld({ id, deck: DEFAULT_DECK, tags: [chTag(ch)], front: q, back: a, memo: "", created: t + k, due: t,
             interval: 0, ease: 2.5, reps: 0, lapses: 0, srs: false });
    n++;
  }));
  putOld({ id: CH_META_ID, kind: "meta", text: "章の一問一答を全部追加済み" });
  commit();
  if (n) toast(`章の一問一答 ${n}問を「問題」に入れました`);
  return true;
}
function saveQset(){ lsSet(LS.qset, S.qset); }
function qsetLabel(p){
  return [p.chap ? `第${p.chap}章 ${(chOf(p.chap) || {}).short || ""}` : "全範囲", p.region, p.era ? eraName(p.era) : ""].filter(Boolean).join(" ・ ");
}
function quizPool(){
  const p = S.qset, filtered = p.chap || p.region || p.era;
  return live().filter(c => !isEv(c)).filter(c => {
    if (!filtered) return true;
    const m = chMeta(c.id); if (!m) return false;
    return (!p.chap || m.no === +p.chap) && (!p.region || m.r.includes(p.region)) && (!p.era || m.e.includes(p.era));
  }).filter(c => p.order !== "wrong" || (c.qng || 0) > 0);
}
function wrapChips(h){ return h.replace('<div class="chips">', '<div class="chips wrap">'); }
function quizSetupHTML(){
  const p = S.qset, n = quizPool().length;
  let h = `<div class="card"><h2>問題を解く</h2><p class="muted small" style="margin-top:-4px">範囲を選ぶと、その中からランダムに出題するよ。答え合わせのあとに、毎日の復習に送るかを選べる。</p>
    <label class="f">章</label><select data-qsel="chap"><option value="">全範囲（すべての章）</option>${chList().map(c => `<option value="${c.no}" ${String(c.no) === String(p.chap) ? "selected" : ""}>第${c.no}章 ${esc(c.short)}</option>`).join("")}</select>
    <label class="f">地域</label>${wrapChips(kvChips(p.region, "qSet", "region", [["", "すべて"], ...REGIONS.map(r => [r, r])]))}
    <label class="f">時代</label>${wrapChips(kvChips(p.era, "qSet", "era", [["", "すべて"], ...ERAS.map(([v, l, s]) => [v, `${l}（${s}）`])]))}
    <label class="f">出し方</label>${wrapChips(kvChips(p.order, "qSet", "order", [["random", "ランダム"], ["fresh", "まだ出ていない問題から"], ["wrong", "×をつけたことがある問題だけ"]]))}
    <label class="f">問題数</label>${wrapChips(kvChips(String(p.count), "qSet", "count", [["10", "10問"], ["20", "20問"], ["50", "50問"], ["0", "全部"]]))}
    <div style="height:8px"></div><button class="btn" data-act="qStart" ${n ? "" : "disabled"}>${n ? `始める（対象 ${n}問）` : "対象の問題がありません"}</button>`;
  if (!n) h += `<p class="muted small">${p.order === "wrong" ? "この範囲で×をつけた問題はまだありません。" : "この組み合わせの問題はありません。"}条件を変えてみてね。</p>`;
  return h + `</div>`;
}
function quizMeta(c){
  const m = chMeta(c.id);
  const parts = m ? [`第${m.no}章 ${(chOf(m.no) || {}).short || ""}`, m.r.join("・"), [...m.e].map(eraName).join("〜")] : [deckOf(c), ...tagsOf(c)];
  if (c.srs !== false) parts.push("復習に入っている");
  return parts.filter(Boolean).map(esc).join(" ・ ");
}
function quizLinks(c){ return `<div class="links"><button class="link" data-act="edit" data-id="${esc(c.id)}">この問題を直す</button><button class="link" data-act="qQuit">やめる</button></div>`; }
function quizHTML(){
  const Q = S.quiz; if (!Q){ S.view = "home"; return homeHTML(); }
  while (Q.idx < Q.queue.length && !card(Q.queue[Q.idx])) Q.idx++;
  if (Q.idx >= Q.queue.length) return quizDoneHTML();
  const c = card(Q.queue[Q.idx]), inR = c.srs !== false;
  const okN = Object.values(Q.res).filter(x => x === true).length, ngN = Object.values(Q.res).filter(x => x === false).length;
  let h = `<div class="progress"><i style="width:${Math.round(Q.idx / Q.queue.length * 100)}%"></i></div>
    <div class="muted small" style="margin-bottom:8px">${Q.round > 1 ? "×の解き直し　" : ""}${Q.idx + 1} / ${Q.queue.length}　・　○ ${okN}　× ${ngN}</div>
    <div class="card q"><div class="meta">${quizMeta(c)}</div><div class="front">${nl(c.front)}</div>`;
  if (Q.shown){
    h += `<div class="back">${nl(c.back)}</div>`;
    if (c.memo) h += `<details><summary>メモを見る</summary><div>${esc(c.memo)}</div></details>`;
    h += jtChipsFor(c.front + "\n" + c.back);
  }
  h += `</div>`;
  if (!Q.shown) return h + `<button class="btn" data-act="qShow">答えを見る</button>` + quizLinks(c);
  if (Q.judged === null){
    return h + `<p class="muted small" style="text-align:center;margin:0 0 6px">自分の答えは合っていた？</p>
      <div class="two"><button class="x" data-act="qJudge" data-ok="0">× まちがえた</button><button class="o" data-act="qJudge" data-ok="1">○ 正解</button></div>` + quizLinks(c);
  }
  const ok = Q.judged;
  h += `<div class="card"><div class="res ${ok ? "ok" : "ng"}">${ok ? "○ 正解" : "× 不正解"}</div>`;
  if (!inR){
    // 上の青いボタンは、正解でも不正解でも「復習に送って次へ」
    h += `<p class="small" style="margin:6px 0 10px">この問題を毎日の復習に送る？送ると、忘れかけたころに「今日の復習」で出てくるよ。</p>
      <div class="btns"><button class="btn" data-act="qNext" data-do="send">復習に送って次へ</button></div>
      <div class="btns"><button class="btn line" data-act="qNext" data-do="">送らずに次へ</button></div>`;
  } else {
    h += `<p class="small" style="margin:6px 0 10px">この問題はもう毎日の復習に入っています（${c.reps ? "次の復習：" + esc(dueLabel(c)) : "まだ一度も復習していない"}）。</p>`
      + (ok ? `<div class="btns"><button class="btn" data-act="qNext" data-do="">次へ</button></div>`
            : `<div class="btns"><button class="btn" data-act="qNext" data-do="today">今日の復習に回して次へ</button></div><div class="btns"><button class="btn line" data-act="qNext" data-do="">このまま次へ</button></div>`)
      + `<div class="btns"><button class="btn line" data-act="qNext" data-do="out">復習から外して次へ</button></div>`;
  }
  return h + `</div>` + quizLinks(c);
}
function quizDoneHTML(){
  const Q = S.quiz, ids = Q.queue.filter(id => card(id));
  const okN = ids.filter(id => Q.res[id] === true).length, wrong = ids.filter(id => Q.res[id] === false);
  const unsent = wrong.filter(id => card(id).srs === false);
  let h = `<div class="card done"><div class="big">${okN} / ${okN + wrong.length} 正解</div><p class="muted">${esc(qsetLabel(Q.set))}</p></div>`;
  if (wrong.length){
    h += `<div class="card"><h2>×だった問題（${wrong.length}）</h2>${wrong.map(id => { const c = card(id);
      return `<button class="item" data-act="edit" data-id="${esc(id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div><div class="im">${c.srs === false ? "復習に入っていない" : "復習に入っている"}</div></button>`; }).join("")}
      ${unsent.length ? `<div style="height:8px"></div><button class="btn sec" data-act="qSendWrong">まだ送っていない${unsent.length}問を復習に送る</button>` : ""}</div>
      <button class="btn" data-act="qRetry">×だけもう一度</button>`;
  }
  return h + `<div class="btns"><button class="btn sec" data-act="qStart">同じ範囲で新しく出題</button><button class="btn line" data-act="qQuit">終わる</button></div>`;
}

/* ---------- 画面：年号ドリル ---------- */
const YMODES = [["sort", "並び替え"], ["y4", "年号4択"], ["yin", "年号入力"], ["e4", "出来事4択"]];
const YLABEL = Object.fromEntries(YMODES);
const YDESC = { sort: "出来事を古い順に並べる。", y4: "出来事を見て、年号を4つから選ぶ。", yin: "出来事を見て、年号を入力する。", e4: "年号を見て、その年の出来事を4つから選ぶ。" };
function yPool(){
  const p = S.yset;
  return evs().filter(e => (p.region === "すべて" || (e.region || "") === p.region)
    && (p.from === "" || centuryOf(e.year) >= +p.from) && (p.to === "" || centuryOf(e.year) <= +p.to)
    && (!p.tag || tagsOf(e).includes(p.tag)));
}
function distinctYears(pool){ return new Set(pool.map(e => e.year)).size; }
function yReady(mode, pool, n){ return mode === "sort" ? distinctYears(pool) >= n : mode === "e4" ? distinctYears(pool) >= 4 : pool.length >= 1; }
function pickSort(pool, n, near){
  const byY = new Map();
  pool.forEach(e => { if (!byY.has(e.year)) byY.set(e.year, []); byY.get(e.year).push(e); });
  const years = [...byY.keys()];
  if (years.length < n) return null;
  let chosen;
  if (near){
    const anchor = years[Math.floor(Math.random() * years.length)];
    for (let w = 30; ; w *= 2){
      const cand = years.filter(y => Math.abs(y - anchor) <= w);
      if (cand.length >= n){ chosen = [anchor, ...shuffle(cand.filter(y => y !== anchor)).slice(0, n - 1)]; break; }
    }
  } else chosen = shuffle(years).slice(0, n);
  return chosen.map(y => { const a = byY.get(y); return a[Math.floor(Math.random() * a.length)]; });
}
function yearChoices(e, pool){
  const Y = e.year, set = new Set([Y]);
  const near = shuffle(pool.filter(x => x.year !== Y && Math.abs(x.year - Y) <= 60).map(x => x.year));
  if (near.length) set.add(near[0]);
  const offs = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 30, 50, 100].flatMap(d => [d, -d]));
  for (const d of offs){
    if (set.size >= 4) break;
    const v = Y + d;
    if (v === 0 || (v > 0) !== (Y > 0)) continue;   // 紀元前と紀元後をまたがない
    set.add(v);
  }
  return shuffle([...set]);
}
function eventChoices(e, pool){
  const Y = e.year;
  const others = pool.filter(x => x.year !== Y && x.title !== e.title && !(x.yearEnd != null && x.year <= Y && Y <= x.yearEnd))
    .sort((a, b) => Math.abs(a.year - Y) - Math.abs(b.year - Y));
  const picked = [], years = new Set([Y]);
  const take = list => { for (const x of list){ if (picked.length >= 3) break; if (years.has(x.year)) continue; years.add(x.year); picked.push(x); } };
  take(shuffle(others.slice(0, 10))); take(others);
  return shuffle([e, ...picked].map(x => x.id));
}
function yMake(){
  const d = S.yd; d.answered = false; d.sel = null; d.mine = null;
  const pool = d.ids.map(id => card(id)).filter(isEv);
  if (d.mode === "sort"){
    const items = pickSort(pool, d.n, d.near);
    if (!items){ d.cur = null; return; }
    const order = items.slice().sort(byYear).map(e => e.id);
    let shown = shuffle(order);
    for (let k = 0; k < 5 && shown.join() === order.join(); k++) shown = shuffle(order);
    d.cur = { order, shown, picked: [] };
    return;
  }
  const e = card(d.queue[d.idx]);
  if (!isEv(e)){ d.cur = null; return; }
  if (d.mode === "y4") d.cur = { id: e.id, choices: yearChoices(e, pool) };
  else if (d.mode === "yin") d.cur = { id: e.id, input: "", bc: false };
  else d.cur = { id: e.id, choices: eventChoices(e, pool) };
}
function yearHTML(){ return S.yd ? ydHTML() : ysetHTML(); }
function ysetHTML(){
  const p = S.yset, all = evs();
  if (!all.length) return emptyEvHTML();
  const regs = regionOrder(all);
  if (p.region !== "すべて" && !regs.includes(p.region)) p.region = "すべて";
  const cents = [...new Set(all.map(e => centuryOf(e.year)))].sort((a, b) => a - b);
  const tags = [...new Set(all.flatMap(tagsOf))];
  if (p.tag && !tags.includes(p.tag)) p.tag = "";
  const pool = yPool(), ok = yReady(p.mode, pool, p.n);
  let h = `<div class="card"><div class="seg s4">${YMODES.map(([v, l]) => `<button class="${p.mode === v ? "on" : ""}" data-act="ySet" data-k="mode" data-v="${v}">${l}</button>`).join("")}</div>
    <p class="muted small" style="margin:6px 0 0">${YDESC[p.mode]}ここで解いても、毎日の復習のスケジュールは変わらないよ。</p>
    <label class="f">地域</label>${kvChips(p.region, "ySet", "region", [["すべて", "すべて"], ...regs.map(r => [r, rName(r)])])}
    <label class="f">時代</label><div class="row2">
      <select data-ysel="from"><option value="">いちばん古い</option>${cents.map(c => `<option value="${c}" ${String(c) === String(p.from) ? "selected" : ""}>${centLabel(c)}から</option>`).join("")}</select>
      <select data-ysel="to"><option value="">いちばん新しい</option>${cents.map(c => `<option value="${c}" ${String(c) === String(p.to) ? "selected" : ""}>${centLabel(c)}まで</option>`).join("")}</select></div>`;
  if (tags.length) h += `<label class="f">タグ</label>${kvChips(p.tag, "ySet", "tag", [["", "すべて"], ...tags.map(t => [t, t])])}`;
  if (p.mode === "sort"){
    h += `<label class="f">一度に並べる数</label>${kvChips(String(p.n), "ySet", "n", [["3", "3つ"], ["4", "4つ"], ["5", "5つ"], ["6", "6つ"]])}
      <label class="f">年代の近さ</label>${kvChips(p.near ? "1" : "0", "ySet", "near", [["0", "ばらばら"], ["1", "近い年代どうし（難しい）"]])}`;
  }
  h += `<label class="f">問題数</label>${kvChips(String(p.total), "ySet", "total", [["5", "5問"], ["10", "10問"], ["20", "20問"]])}
    <div style="height:8px"></div><button class="btn" data-act="yStart" ${ok ? "" : "disabled"}>${ok ? `始める（対象 ${pool.length}件）` : "対象の出来事が足りません"}</button>`;
  if (!ok) h += `<p class="muted small">${p.mode === "sort" ? `年号のちがう出来事が${p.n}つ以上必要です。` : p.mode === "e4" ? "年号のちがう出来事が4つ以上必要です。" : "対象の出来事がありません。"}範囲を広げるか、出来事を追加してね。</p>`;
  return h + `</div>`;
}
function ydHTML(){
  const d = S.yd;
  if (d.idx >= d.total || !d.cur) return yResultHTML();
  let h = `<div class="progress"><i style="width:${Math.round(d.idx / d.total * 100)}%"></i></div>
    <div class="muted small" style="margin-bottom:8px">${YLABEL[d.mode]}　${d.idx + 1} / ${d.total}　・　正解 ${d.score}</div>`;
  h += d.mode === "sort" ? ySortHTML(d) : d.mode === "y4" ? yY4HTML(d) : d.mode === "yin" ? yYinHTML(d) : yE4HTML(d);
  return h + `<div class="links"><span></span><button class="link" data-act="yQuit">やめる</button></div>`;
}
function ySortHTML(d){
  const c = d.cur, n = c.order.length;
  let h = `<div class="card"><div class="big-q">古い順に並べよう</div>`;
  if (!d.answered){
    h += `<p class="muted small" style="margin:2px 0 0">下の出来事を古いものからタップ。上の枠をタップすると戻せるよ。</p>
      <div class="slots">${Array.from({ length: n }, (_, i) => { const id = c.picked[i], e = id && card(id);
        return e ? `<button class="slot fill" data-act="yUnpick" data-i="${i}"><span class="no">${i + 1}</span>${esc(e.title)}</button>` : `<div class="slot"><span class="no">${i + 1}</span></div>`; }).join("")}</div>
      <div class="opts">${c.shown.filter(id => !c.picked.includes(id)).map(id => { const e = card(id);
        return e ? `<button class="opt" data-act="yPick" data-id="${esc(id)}">${esc(e.title)}<span class="sub">${rDot(e.region)}</span></button>` : ""; }).join("")}</div></div>`;
    if (c.picked.length === n) h += `<button class="btn" data-act="yCheck">答え合わせ</button>`;
    return h;
  }
  h += `<div style="margin-top:8px">${c.order.map((id, i) => { const e = card(id); if (!e) return "";
    const ok = c.picked[i] === id, mine = !ok && card(c.picked[i]);
    return `<button class="ev" data-act="ev" data-id="${esc(id)}"><span class="mark ${ok ? "ok" : "ng"}">${ok ? "○" : "×"}</span><span class="yr">${esc(yearShort(e))}</span>
      <span class="evb"><span class="tt">${esc(e.title)}</span>${mine ? `<span class="ds">あなたの${i + 1}番目：${esc(mine.title)}</span>` : ""}</span></button>`; }).join("")}</div>
    <p class="muted small" style="margin:6px 0 0">${d.lastOk ? "全部正解！" : "行をタップすると、関連や前後の流れが見られるよ。"}</p></div>
    <button class="btn" data-act="yNext">次へ</button>`;
  return h;
}
function yAfter(e, d){
  return `<div class="card" style="margin-top:12px"><div class="${d.lastOk ? "res ok" : "res ng"}">${d.lastOk ? "○ 正解" : "× 不正解"}</div>
    <div class="kv"><span>${esc(e.title)}</span><b>${esc(yearLabel(e))}</b></div>${e.desc ? `<p class="small" style="margin:4px 0 0">${nl(e.desc)}</p>` : ""}
    <div class="chipline"><button class="rchip" data-act="ev" data-id="${esc(e.id)}">関連・前後の流れを見る</button></div></div>
    <button class="btn" data-act="yNext">次へ</button>`;
}
function yY4HTML(d){
  const c = d.cur, e = card(c.id); if (!e) return "";
  let h = `<div class="card"><div class="muted small">${rDot(e.region)}</div><div class="big-q">${esc(e.title)}</div>
    <p class="muted" style="margin:2px 0 0">${e.yearEnd != null ? "始まったのは何年？" : "何年？"}</p></div>
    <div class="opts">${c.choices.map((y, i) => { let cls = "";
      if (d.answered){ if (y === e.year) cls = "ok"; else if (i === d.sel) cls = "ng"; }
      return `<button class="opt center ${cls}" data-act="yChoose" data-i="${i}" ${d.answered ? "disabled" : ""}>${esc(yearStr(y))}年</button>`; }).join("")}</div>`;
  if (d.answered) h += yAfter(e, d);
  return h;
}
function yYinHTML(d){
  const c = d.cur, e = card(c.id); if (!e) return "";
  let h = `<div class="card"><div class="muted small">${rDot(e.region)}</div><div class="big-q">${esc(e.title)}</div>
    <p class="muted" style="margin:2px 0 0">${e.yearEnd != null ? "始まったのは何年？" : "何年？"}</p>`;
  if (!d.answered){
    h += `<div class="seg" style="margin-top:12px"><button class="${c.bc ? "" : "on"}" data-act="yBc" data-v="0">紀元後</button><button class="${c.bc ? "on" : ""}" data-act="yBc" data-v="1">紀元前</button></div>
      <input type="text" id="yin" class="yin" inputmode="numeric" autocomplete="off" value="${esc(c.input)}" placeholder="年号を入力"></div>
      <button class="btn" data-act="yInCheck">答え合わせ</button>`;
    return h;
  }
  return h + `<p style="margin:10px 0 0">あなたの答え：<b>${esc(yearStr(d.mine))}年</b></p></div>` + yAfter(e, d);
}
function yE4HTML(d){
  const c = d.cur, e = card(c.id); if (!e) return "";
  const q = e.yearEnd != null ? `${yearStr(e.year)}年に始まった出来事は？` : `${yearLabel(e)}の出来事は？`;
  let h = `<div class="card"><div class="big-q">${esc(q)}</div></div>
    <div class="opts">${c.choices.map((id, i) => { const x = card(id); if (!x) return ""; let cls = "";
      if (d.answered){ if (id === e.id) cls = "ok"; else if (i === d.sel) cls = "ng"; }
      return `<button class="opt ${cls}" data-act="yChoose" data-i="${i}" ${d.answered ? "disabled" : ""}>${esc(x.title)}${d.answered ? `<span class="sub">${esc(yearLabel(x))}</span>` : ""}</button>`; }).join("")}</div>`;
  if (d.answered) h += yAfter(e, d);
  return h;
}
function yResultHTML(){
  const d = S.yd;
  const wrong = [...new Set(d.wrong)].map(id => card(id)).filter(isEv).sort(byYear);
  let h = `<div class="card done"><div class="big">${d.score} / ${d.idx} 正解</div><p class="muted">${YLABEL[d.mode]}</p>
    ${!d.cur && d.idx < d.total ? `<p class="muted small">対象の出来事が足りなくなったので終わりにしたよ。</p>` : ""}</div>`;
  if (wrong.length){
    h += `<div class="card"><h2>まちがえた出来事</h2>${wrong.map(e => evRow(e, { region: true })).join("")}<div style="height:8px"></div>
      <button class="btn sec" data-act="yWrongReview" ${d.wrongDone ? "disabled" : ""}>${d.wrongDone ? "毎日の復習に入れました" : `この${wrong.length}件を毎日の復習に入れる`}</button></div>`;
  }
  return h + `<div class="btns"><button class="btn" data-act="yStart">もう一度</button><button class="btn line" data-act="yQuit">設定にもどる</button></div>`;
}

/* ---------- 画面：ノート ---------- */
function noteHTML(){
  return `<input type="search" id="nq" placeholder="出来事・まとめ・一問一答を検索" value="${esc(S.note.q)}"><div style="height:10px"></div>
    <div class="seg s4">${[["chap", "章ごと"], ["region", "地域ごと"], ["era", "年代ごと"], ["line", "年表"]].map(([v, l]) =>
      `<button class="${S.note.mode === v ? "on" : ""}" data-act="nMode" data-v="${v}">${l}</button>`).join("")}</div>
    <div style="height:10px"></div><div id="note-body"></div>`;
}
function renderNoteBody(){
  const el = $("#note-body"); if (!el) return;
  const list = evs().sort(byYear), q = S.note.q.trim();
  if (q){ el.innerHTML = searchHTML(q, list); return; }
  if (S.note.mode === "chap"){ el.innerHTML = chapHTML(); return; }
  if (!list.length){ el.innerHTML = emptyEvHTML(); return; }
  el.innerHTML = S.note.mode === "era" ? eraHTML(list) : S.note.mode === "line" ? lineHTML(list) : regionHTML(list);
}
function memoView(key){ const t = noteOf(key); return t ? `<div class="memo" data-act="memo" data-k="${esc(key)}">${nl(t)}</div>` : ""; }
function memoBtn(key, whole){ const has = !!noteOf(key); return `<button class="mini" data-act="memo" data-k="${esc(key)}">${has ? "✎ まとめ" : whole ? "＋ 全体のまとめを書く" : "＋ まとめ"}</button>`; }
function sech(label, key, sub){ return `<div class="sech"><span><b>${label}</b>${sub ? `<span class="muted small">　${esc(sub)}</span>` : ""}</span>${memoBtn(key)}</div>${memoView(key)}`; }
function regionHTML(list){
  const regs = regionOrder(list);
  if (!regs.includes(S.note.region)) S.note.region = regs[0];
  const r = S.note.region, mine = list.filter(e => (e.region || "") === r);
  const cents = [...new Set(mine.map(e => centuryOf(e.year)))].sort((a, b) => a - b);
  const wk = noteKey(r, null);
  let h = `<div class="chips">${regs.map(x => `<button class="chip ${x === r ? "on" : ""}" data-act="nRegion" data-d="${esc(x)}">${esc(rName(x))}</button>`).join("")}</div>`;
  h += `<div class="card"><h2 style="margin-bottom:2px">${rDot(r)}</h2><p class="muted small" style="margin:0 0 8px">出来事 ${mine.length}件 ・ ${centLabel(cents[0])}〜${centLabel(cents[cents.length - 1])}</p>
    ${memoView(wk)}${memoBtn(wk, true)}</div>`;
  cents.forEach(c => {
    h += `<div class="card">${sech(esc(centLabel(c)), noteKey(r, c), centSpan(c))}${mine.filter(e => centuryOf(e.year) === c).map(e => evRow(e, { desc: true })).join("")}</div>`;
  });
  return h;
}
function eraHTML(list){
  const cents = [...new Set(list.map(e => centuryOf(e.year)))].sort((a, b) => a - b);
  if (!cents.includes(S.note.cent)) S.note.cent = cents[0];
  const c = S.note.cent, i = cents.indexOf(c), mine = list.filter(e => centuryOf(e.year) === c);
  const wk = noteKey(null, c);
  let h = `<div class="chips" id="cent-chips">${cents.map(x => `<button class="chip ${x === c ? "on" : ""}" data-act="nCent" data-d="${x}">${esc(centLabel(x))}</button>`).join("")}</div>`;
  h += `<div class="card"><div class="stepper"><button class="mini" data-act="nStep" data-v="-1" ${i > 0 ? "" : "disabled"}>‹ 前</button>
      <div style="text-align:center"><b style="font-size:18px">${esc(centLabel(c))}</b><div class="muted small">${esc(centSpan(c))} ・ ${mine.length}件</div></div>
      <button class="mini" data-act="nStep" data-v="1" ${i < cents.length - 1 ? "" : "disabled"}>次 ›</button></div>
    <p class="muted small" style="margin:8px 0">同じ時代のほかの地域を見くらべると、横のつながりがつかめるよ。</p>${memoView(wk)}${memoBtn(wk, true)}</div>`;
  regionOrder(mine).forEach(r => {
    h += `<div class="card">${sech(rDot(r), noteKey(r, c))}${mine.filter(e => (e.region || "") === r).map(e => evRow(e, { desc: true })).join("")}</div>`;
  });
  return h;
}
function lineHTML(list){
  const regs = regionOrder(list);
  if (S.note.line !== "すべて" && !regs.includes(S.note.line)) S.note.line = "すべて";
  const f = S.note.line, mine = f === "すべて" ? list : list.filter(e => (e.region || "") === f);
  let h = `<div class="chips">${["すべて", ...regs].map(x => `<button class="chip ${x === f ? "on" : ""}" data-act="nLine" data-d="${esc(x)}">${esc(x === "すべて" ? x : rName(x))}</button>`).join("")}</div><div class="card">`;
  let last = null;
  mine.forEach(e => {
    const c = centuryOf(e.year);
    if (c !== last){ h += `<div class="sech"><b>${esc(centLabel(c))}</b></div>`; last = c; }
    h += evRow(e, { region: f === "すべて" });
  });
  return h + `</div>`;
}
function searchHTML(q, list){
  const ql = q.toLowerCase(), has = arr => arr.join(" ").toLowerCase().includes(ql);
  const evHits = list.filter(e => has([e.title, e.desc, rName(e.region), yearLabel(e), centLabel(centuryOf(e.year)), ...tagsOf(e)]));
  const memoHits = S.cards.filter(c => !c.deleted && c.kind === "note" && has([c.text || "", noteLabel(c.key || "|")]));
  const cardHits = live().filter(c => !isEv(c) && has([c.front, c.back, c.memo, ...tagsOf(c)]));
  const ids = liveIds(), chHits = chList().filter(c => has([c.title, c.short, c.note]));
  const qaHits = chList().flatMap(c => c.qa.filter(([qq, a]) => !ids.has(chId(c, qq)) && has([qq, a])).map(([qq, a]) => ({ c, q: qq, a })));
  const jtHits = jt().list.filter(e => has([e.name, ...e.al.map(jtAl), e.d]));
  const jtCard = jtHits.length ? `<div class="card"><h2>事典（${jtHits.length}）</h2>${jtHits.sort(jtByYear).slice(0, 60).map(e => jtRow(e, { desc: true })).join("")}</div>` : "";
  if (!evHits.length && !memoHits.length && !cardHits.length && !chHits.length && !qaHits.length && !jtHits.length) return `<div class="card"><p class="muted">「${esc(q)}」は見つかりませんでした。</p></div>`;
  let h = jtCard;
  if (chHits.length) h += `<div class="card"><h2>章のまとめ（${chHits.length}）</h2>${chHits.map(c => `<button class="item" data-act="chOpen" data-d="${c.no}"><div class="iq">第${c.no}章 ${esc(c.title)}</div><div class="im">${esc(chSnippet(c.note, ql))}</div></button>`).join("")}</div>`;
  if (evHits.length) h += `<div class="card"><h2>出来事（${evHits.length}）</h2>${evHits.slice(0, 100).map(e => evRow(e, { region: true, desc: true })).join("")}</div>`;
  if (memoHits.length) h += `<div class="card"><h2>まとめ（${memoHits.length}）</h2>${memoHits.map(n => `<div class="muted small" style="margin-top:8px">${esc(noteLabel(n.key || "|"))}</div>${memoView(n.key)}`).join("")}</div>`;
  if (cardHits.length) h += `<div class="card"><h2>一問一答（${cardHits.length}）</h2>${cardHits.slice(0, 100).map(c => `<button class="item" data-act="edit" data-id="${esc(c.id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div></button>`).join("")}</div>`;
  if (qaHits.length) h += `<div class="card"><h2>章の一問一答・まだ追加していないもの（${qaHits.length}）</h2>${qaHits.slice(0, 100).map(x => `<button class="item" data-act="chOpen" data-d="${x.c.no}"><div class="iq">${esc(x.q)}</div><div class="ia">${esc(x.a)}</div><div class="im">第${x.c.no}章 ${esc(x.c.short)}</div></button>`).join("")}</div>`;
  return h;
}

/* ---------- 画面：追加 ---------- */
function yearInfo(t){
  if (!String(t || "").trim()) return "";
  const y = parseYearText(t);
  return y ? `→ ${esc(yearLabel(y))}（${esc(centLabel(centuryOf(y.year)))}）` : "年の書き方を確認してね（例：1077、前221、1337〜1453）";
}
function evFormFields(p, f){
  return `<label class="f">出来事</label><input type="text" data-bind="${p}.title" value="${esc(f.title)}" placeholder="カノッサの屈辱">
    <label class="f">年（紀元前は「前221」、期間は「1337〜1453」）</label><input type="text" data-bind="${p}.year" value="${esc(f.year)}" placeholder="1077" autocomplete="off">
    <p class="muted small" id="${p}-yinfo" style="margin:4px 0 0">${yearInfo(f.year)}</p>
    <label class="f">地域</label><div class="chips wrap">${REGIONS.map(r => `<button class="chip ${f.region === r ? "on" : ""}" data-act="setRegion" data-p="${p}" data-d="${esc(r)}">${esc(r)}</button>`).join("")}</div>
    <input type="text" data-bind="${p}.region" id="${p}-region" value="${esc(f.region)}" placeholder="ほかの地域名を書いてもOK">
    <label class="f">説明（任意）</label><textarea data-bind="${p}.desc">${esc(f.desc)}</textarea>
    <label class="f">関連する出来事（任意・出来事名を「、」で区切る）</label><input type="text" data-bind="${p}.related" value="${esc(f.related)}" placeholder="叙任権闘争、ヴォルムス協約">
    <label class="f">タグ（任意）</label><input type="text" data-bind="${p}.tags" value="${esc(f.tags)}" placeholder="中世ヨーロッパ">
    <label class="chk"><input type="checkbox" data-bind="${p}.srs" ${f.srs ? "checked" : ""}>毎日の復習（年号の問題）にも入れる</label>`;
}
function deckRow(){
  const a = S.add;
  return `<div class="row2"><div><label class="f">科目</label><input type="text" list="decklist" data-bind="add.deck" value="${esc(a.deck)}">
    <datalist id="decklist">${decks().map(d => `<option value="${esc(d)}">`).join("")}</datalist></div>
    <div><label class="f">タグ（任意）</label><input type="text" data-bind="add.tags" value="${esc(a.tags)}" placeholder="中世ヨーロッパ"></div></div>`;
}
function promptBox(kind){
  const text = kind === "event" ? PROMPT_EVENT : PROMPT_CARD;
  return `<details><summary>Claude への頼み方（コピーしてチャットに貼る）</summary><div>${esc(text)}</div></details>
    <div class="btns"><button class="btn line" data-act="copyPrompt" data-k="${kind}">頼み方をコピー</button></div>`;
}
function addHTML(){
  const a = S.add;
  let h = `<div class="card"><div class="seg s3">
      <button class="${a.mode === "one" ? "on" : ""}" data-act="aMode" data-m="one">一問一答</button>
      <button class="${a.mode === "event" ? "on" : ""}" data-act="aMode" data-m="event">出来事・年号</button>
      <button class="${a.mode === "bulk" ? "on" : ""}" data-act="aMode" data-m="bulk">まとめて追加</button></div>`;
  if (a.mode === "one"){
    h += deckRow() + `<label class="f">問題</label><textarea data-bind="add.front" placeholder="1077年、ハインリヒ4世が教皇に謝罪した出来事は？">${esc(a.front)}</textarea>
      <label class="f">答え</label><textarea data-bind="add.back" placeholder="カノッサの屈辱">${esc(a.back)}</textarea>
      <label class="f">メモ（任意・復習のとき見られる）</label><textarea data-bind="add.memo">${esc(a.memo)}</textarea>
      <div style="height:12px"></div><button class="btn" data-act="addOne">追加する</button></div>`;
    return h + chapPromoHTML();
  }
  if (a.mode === "event"){
    h += `<p class="muted small" style="margin:6px 0 0">年号つきで登録すると、年号ドリル・ノート・関連表示に使われるよ。</p>` + evFormFields("aev", S.aev)
      + `<div style="height:12px"></div><button class="btn" data-act="addEvent">追加する</button></div>`;
    return h + starterCardHTML();
  }
  h += `<label class="f">取り込むもの</label><div class="seg">
      <button class="${a.bulkKind === "event" ? "on" : ""}" data-act="bKind" data-v="event">出来事・年号</button>
      <button class="${a.bulkKind === "card" ? "on" : ""}" data-act="bKind" data-v="card">一問一答</button></div>`;
  if (a.bulkKind === "card"){
    const parsed = parseBulk(a.bulk);
    h += deckRow() + `<label class="f">1行に1問、「問題 ｜ 答え」の形で貼り付け</label>
      <textarea class="tall" data-bind="add.bulk" placeholder="1077年、ハインリヒ4世が教皇に謝罪した出来事は？ ｜ カノッサの屈辱">${esc(a.bulk)}</textarea>
      <p class="muted small" id="bulk-info">${bulkInfo(parsed)}</p>
      <button class="btn" data-act="addBulk" id="bulk-btn">${parsed.ok.length}問を追加</button>${promptBox("card")}</div>`;
    return h + chapPromoHTML();
  }
  const parsed = parseBulkEvents(a.bulk, a.bulkRegion.trim());
  h += `<label class="f">1行に1つ、「年 ｜ 出来事 ｜ 地域 ｜ 説明」の形で貼り付け（地域・説明は省略可）</label>
    <textarea class="tall" data-bind="add.bulk" placeholder="1077 ｜ カノッサの屈辱 ｜ ヨーロッパ ｜ 叙任権闘争で破門された皇帝が教皇に謝罪">${esc(a.bulk)}</textarea>
    <p class="muted small" id="bulk-info">${bulkEvInfo(parsed)}</p>
    <label class="f">地域が書いていない行の地域（任意）</label><input type="text" data-bind="add.bulkRegion" value="${esc(a.bulkRegion)}" list="regionlist" placeholder="ヨーロッパ">
    <datalist id="regionlist">${REGIONS.map(r => `<option value="${esc(r)}">`).join("")}</datalist>
    <label class="chk"><input type="checkbox" data-bind="add.bsrs" ${a.bsrs ? "checked" : ""}>毎日の復習（年号の問題）にも入れる</label>
    <button class="btn" data-act="addBulk" id="bulk-btn">${parsed.ok.length}件を追加</button>${promptBox("event")}</div>`;
  return h + starterCardHTML();
}
function parseBulk(text){
  const ok = [], bad = [];
  String(text || "").split(/\r?\n/).forEach(line => {
    let l = line.trim(); if (!l || l.startsWith("#")) return;
    l = l.replace(/^(?:[-・*•]|\d+\s*[.)．、:：])\s*/, "");
    const m = l.match(/^(.+?)\s*(?:[|｜]|\t)\s*(.+)$/);
    if (m && m[1].trim() && m[2].trim()) ok.push({ front: m[1].trim(), back: m[2].trim() }); else bad.push(line.trim());
  });
  return { ok, bad };
}
function bulkInfo(p){
  if (!p.ok.length && !p.bad.length) return "Claude に頼むときは、下の「頼み方」をコピーして使ってね。";
  return `読み取れた問題：${p.ok.length}問` + (p.bad.length ? `　／　読み取れなかった行：${p.bad.length}行（「｜」が入っているか確認してね）` : "");
}
function parseBulkEvents(text, defRegion){
  const ok = [], bad = [];
  String(text || "").split(/\r?\n/).forEach(line => {
    let l = line.trim(); if (!l || l.startsWith("#")) return;
    l = l.replace(/^(?:[-・*•]\s*|\d+\s*[.)．:：]\s+)/, "");
    let check = false;
    if (/要確認/.test(l)){ check = true; l = l.replace(/[（(【\[]?要確認[）)】\]]?/g, "").trim(); }
    const parts = l.split(/\s*(?:[|｜]|\t)\s*/).map(s => s.trim());
    if (parts.length < 2){ bad.push(line.trim()); return; }
    let y = parseYearText(parts[0]), title = parts[1];
    if (!y && parseYearText(parts[1])){ y = parseYearText(parts[1]); title = parts[0]; }
    if (!y || !title){ bad.push(line.trim()); return; }
    ok.push({ title, year: y.year, yearEnd: y.yearEnd, approx: y.approx, region: parts[2] || defRegion || "", desc: parts[3] || "",
      relText: parts[4] || "", tags: check ? ["要確認"] : [] });
  });
  return { ok, bad };
}
function bulkEvInfo(p){
  if (!p.ok.length && !p.bad.length) return "Claude に頼むときは、下の「頼み方」をコピーして使ってね。「要確認」と書いた行には要確認タグがつくよ。";
  const chk = p.ok.filter(x => x.tags.includes("要確認")).length;
  return `読み取れた出来事：${p.ok.length}件${chk ? `（うち要確認 ${chk}件）` : ""}` + (p.bad.length ? `　／　読み取れなかった行：${p.bad.length}行（年号と「｜」を確認してね）` : "");
}
function starterList(){ return typeof STARTER_EVENTS === "string" ? parseBulkEvents(STARTER_EVENTS, "").ok : []; }
function starterId(x){ let h = 5381; const s = x.title + "|" + x.year; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return "st-" + h.toString(36); }
function starterCardHTML(){
  const list = starterList(); if (!list.length) return "";
  const have = list.filter(x => card(starterId(x))).length;
  let h = `<div class="card"><h2>基本の年号セット</h2><p class="muted small" style="margin-top:-4px">教科書によく出る出来事 ${list.length}件（年号・地域・ひとこと説明つき）。年号ドリルやノートをすぐ試せるよ。
    <b>Claude が作ったもの</b>なので、教科書・資料集と違うところがあったら直してね。毎日の復習には入れずに追加します（出来事ごとに入れられる）。</p>`;
  h += have < list.length ? `<button class="btn sec" data-act="starterAdd">${have ? `残りの${list.length - have}件を追加` : `${list.length}件を追加`}</button>` : `<p class="small" style="margin:0">✓ 追加済み（タグ「${STARTER_TAG}」）</p>`;
  if (have) h += `<div style="height:8px"></div><button class="btn danger ${S.add.confirmStarterDel ? "sure" : ""}" data-act="starterDel">${S.add.confirmStarterDel ? "本当に削除する（自分で直したものも消えます）" : "基本セットを全部削除"}</button>`;
  return h + `</div>`;
}

/* ---------- 章別の一問一答とまとめ（chapters.js） ---------- */
function chList(){ return typeof CHAPTERS !== "undefined" && Array.isArray(CHAPTERS) ? CHAPTERS : []; }
function chOf(no){ const l = chList(); return l.find(c => c.no === +no) || l[0] || null; }
function chTag(ch){ return `${ch.no}章・${ch.short}`; }
// 問題文から決まるID（同じ問題を2回追加しないため）
function chId(ch, q){ let h = 5381; const s = ch.no + "|" + q; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return `ch${ch.no}-` + h.toString(36); }
function liveIds(){ return new Set(S.cards.filter(c => !c.deleted).map(c => c.id)); }
function chCards(ch){ return ch.qa.map(([q]) => card(chId(ch, q))).filter(Boolean); }
function chSnippet(text, ql){
  const t = String(text || "").replace(/\s+/g, " "), i = t.toLowerCase().indexOf(ql);
  if (i < 0) return t.slice(0, 50) + (t.length > 50 ? "…" : "");
  const a = Math.max(0, i - 20);
  return (a ? "…" : "") + t.slice(a, i + ql.length + 30) + (i + ql.length + 30 < t.length ? "…" : "");
}
function chNoteHTML(text){
  let h = "", ul = false;
  const close = () => { if (ul){ h += "</ul>"; ul = false; } };
  String(text || "").split("\n").forEach(l => {
    const t = l.trim(); if (!t) return;
    if (t.startsWith("■")){ close(); h += `<h4>${esc(t.slice(1).trim())}</h4>`; }
    else if (t.startsWith("・")){ if (!ul){ h += "<ul>"; ul = true; } h += `<li>${esc(t.slice(1).trim())}</li>`; }
    else { close(); h += `<p>${esc(t)}</p>`; }
  });
  close();
  return `<div class="chnote">${h}</div>`;
}
function chChipIntoView(){ const on = document.querySelector("#chap-chips .chip.on"); if (on && on.scrollIntoView) on.scrollIntoView({ inline: "center", block: "nearest" }); }
function chapHTML(){
  const list = chList();
  if (!list.length) return `<div class="card"><p class="muted">章のデータ（chapters.js）を読み込めませんでした。</p></div>`;
  const ch = chOf(S.note.chap); S.note.chap = ch.no;
  const i = list.indexOf(ch), n = ch.qa.length, have = chCards(ch), inSrs = have.filter(c => c.srs !== false).length;
  const prev = list[i - 1], next = list[i + 1];
  let h = `<div class="chips" id="chap-chips">${list.map(c => `<button class="chip ${c.no === ch.no ? "on" : ""}" data-act="chSel" data-d="${c.no}">${c.no} ${esc(c.short)}</button>`).join("")}</div>`;
  h += `<div class="card"><div class="stepper"><button class="mini" data-act="chStep" data-v="-1" ${prev ? "" : "disabled"}>‹ 前</button>
    <div style="text-align:center;padding:0 6px"><div class="muted small">第${ch.no}章 ／ 全${list.length}章</div><b style="font-size:17px">${esc(ch.title)}</b></div>
    <button class="mini" data-act="chStep" data-v="1" ${next ? "" : "disabled"}>次 ›</button></div></div>`;
  h += `<div class="card"><h2>まとめ</h2>${chNoteHTML(ch.note)}
    <p class="muted small" style="margin:12px 0 0">Claude が作ったまとめです。教科書・資料集と違うところがあったら教えてね。自分のまとめは「地域ごと」「年代ごと」に書けるよ。</p></div>`;
  h += jtChapCardHTML(ch);
  h += `<div class="card"><h2>この章の一問一答（${n}問）</h2>`;
  if (have.length < n){
    const rest = have.length ? "残りを" : "";
    h += `<p class="muted small" style="margin-top:-4px">${have.length ? `${have.length}問は追加済み。残り${n - have.length}問を追加できるよ。` : "通史で習った章から追加していくのがおすすめ。"}タグ「${esc(chTag(ch))}」がつきます。</p>
      <div class="btns"><button class="btn" data-act="chAdd" data-v="1">${rest}毎日の復習に入れて追加</button></div>
      <div class="btns"><button class="btn line" data-act="chAdd" data-v="0">${rest}問題に追加（復習には入れない）</button></div>`;
  }
  if (have.length){
    const allIn = inSrs === have.length;
    h += `<div class="kv"><span>追加済み</span><span>${have.length} / ${n}問</span></div>
      <div class="kv"><span>毎日の復習に入っている</span><span>${inSrs}問</span></div>
      <div class="btns"><button class="btn sec" data-act="chQuiz">この章から問題を出す</button></div>
      <div class="btns"><button class="btn line" data-act="chSrs" data-v="${allIn ? 0 : 1}">${allIn ? "この章を毎日の復習から外す" : "この章を全部、毎日の復習に入れる"}</button></div>
      <div class="btns"><button class="btn danger ${S.note.chDel === ch.no ? "sure" : ""}" data-act="chDel">${S.note.chDel === ch.no ? "本当に削除する（この章の復習の記録も消えます）" : "この章の問題をアプリから削除"}</button></div>`;
  }
  h += `<details><summary>問題と答えを一覧で見る</summary><div class="qa">${ch.qa.map(([q, a]) => `<p>${esc(q)}<b>${esc(a)}</b></p>`).join("")}</div></details></div>`;
  if (next) h += `<button class="btn line" data-act="chStep" data-v="1" data-top="1">次の章へ：第${next.no}章 ${esc(next.short)} ›</button>`;
  return h;
}
function chapPromoHTML(){
  const list = chList(); if (!list.length) return "";
  const ids = liveIds(), total = list.reduce((s, c) => s + c.qa.length, 0);
  const have = list.reduce((s, c) => s + c.qa.filter(([q]) => ids.has(chId(c, q))).length, 0);
  return `<div class="card"><h2>章別の一問一答とまとめ</h2><p class="muted small" style="margin-top:-4px">教科書の流れに沿った全${list.length}章・${total}問（Claude 作成）。章ごとのまとめを読んで、その章から問題を出したり、まとめて毎日の復習に入れたりできるよ。${have ? `いま${have}問を追加済み。` : ""}</p>
    <button class="btn sec" data-act="goChap">ノートの「章ごと」を開く</button></div>`;
}

/* ---------- 事典（jiten.js）：出来事・人物・国のつながり ---------- */
/*
 * 形式は jiten.js の先頭を参照。自分で直した内容・追加した項目は kind:"jt"（id は「jt|名前」）として同期する。
 */
const JT_TYPES = { E: "出来事", P: "人物", C: "国" };
// 項目名をふくむが別のものを指すことば（リンクにしない）
const JT_STOP = ["太武帝", "商業ルネサンス", "南ネーデルラント継承戦争", "ワット=タイラー"];
let JTC = null;
function jtSplit(s, re){ return String(s || "").split(re).map(x => x.trim()).filter(Boolean); }
function jtNames(s){ return jtSplit(s, /[、,，]/); }
function jtItems(s){ return jtSplit(s, /[／\n]/); }
function jtBlank(t){ return { t, name: "", yt: "", cs: [], ch: [], d: "", c: [], r: [], p: [], x: [], f: [], region: "", al: [], memo: "" }; }
// 「1077」「1337〜1453」「在位1643〜1715」のほか「前5世紀半ば」「16世紀前半」などの世紀表記も、並べ替え用のおよその年にする
function jtYear(t){
  const s = z2h(String(t || "")).trim();
  const p = parseYearText(s.replace(/^[^\d前\-]+/, ""));
  if (p) return p;
  return jtYearRough(s);
}
function jtYearRough(s){
  if (s.includes("世紀")){
    const c = s.match(/(前)?(\d{1,2})/);
    if (c){
      const n = +c[2], start = c[1] ? -n * 100 : (n - 1) * 100, rest = s.slice(c.index + c[0].length, c.index + c[0].length + 6);
      const off = /^世紀初/.test(rest) ? 10 : /^世紀前半/.test(rest) ? 25 : /^世紀後半/.test(rest) ? 75 : /^世紀末/.test(rest) ? 90 : 50;
      return { year: start + off, yearEnd: null, approx: true, raw: true };
    }
  }
  const m = s.match(/(前)?(\d{1,4})/);
  return m ? { year: m[1] ? -(+m[2]) : +m[2], yearEnd: null, approx: false, raw: true } : null;
}
function jtParse(text){
  const out = []; let cur = null;
  String(text || "").split(/\r?\n/).forEach(raw => {
    const line = raw.trim(), i = line.indexOf("|"); if (i < 1) return;
    const k = line.slice(0, i), v = line.slice(i + 1).trim(), parts = v.split("|").map(s => s.trim());
    if (k === "E" || k === "P" || k === "C"){
      cur = jtBlank(k); cur.name = parts[0];
      if (k === "C"){ cur.region = parts[1] || ""; cur.al = jtNames(parts[2]); }
      else { cur.yt = parts[1] || ""; cur.cs = jtNames(parts[2]); cur.ch = jtNames(parts[3]).map(Number).filter(Boolean); }
      if (cur.name) out.push(cur);
      return;
    }
    if (!cur) return;
    if (k === "d") cur.d += (cur.d ? "\n" : "") + v;
    else if (k === "c") cur.c.push(...jtItems(v));
    else if (k === "r") cur.r.push(...jtItems(v));
    else if (k === "p") cur.p.push(...jtNames(v));
    else if (k === "x") cur.x.push(...jtNames(v));
    else if (k === "f") cur.f.push([parts[0] || "", parts.slice(1).join("｜")]);
  });
  return out;
}
function jtStamp(){ let n = 0, s = 0; for (const c of S.cards) if (typeof c.id === "string" && c.id.startsWith("jt|")){ n++; s += c.updatedAt || 0; } return n + ":" + s; }
function jt(){
  const st = jtStamp();
  if (JTC && JTC.st === st) return JTC;
  const by = new Map();
  (typeof JITEN === "string" ? jtParse(JITEN) : []).forEach(e => { e.base = true; if (!by.has(e.name)) by.set(e.name, e); });
  S.cards.forEach(c => {
    if (c.deleted || c.kind !== "jt" || !c.data || typeof c.id !== "string") return;
    const name = c.id.slice(3), b = by.get(name);
    by.set(name, Object.assign(jtBlank((b && b.t) || c.data.t || "E"), b || {}, c.data, { name, base: !!b, edited: true, cid: c.id }));
  });
  const list = [...by.values()];
  list.forEach(e => { const y = e.t === "C" ? null : jtYear(e.yt); e.year = y ? y.year : null; e.yearEnd = y ? y.yearEnd : null; e.approx = !!(y && y.approx); e.yraw = !!(y && y.raw); });
  const alias = new Map();
  const auto = list.map(e => e.name);
  list.forEach(e => (e.al || []).forEach(a0 => {
    const a = jtAl(a0); if (!a || by.has(a) || alias.has(a)) return;
    alias.set(a, e); if (a0[0] !== "!") auto.push(a);   // 「!」つきの呼び方は文中で自動リンクしない
  }));
  auto.push(...JT_STOP);
  const names = auto.filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
  const re = names.length ? new RegExp(names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
  JTC = { st, list, by, alias, re, back: null };
  return JTC;
}
function jtAl(a){ return String(a || "").replace(/^!/, ""); }
function jtGet(n){ if (!n) return null; const J = jt(); return J.by.get(n) || J.alias.get(n) || J.by.get(stripParen(n)) || null; }
function jtCountry(n){ const e = jtGet(n); return e && e.t === "C" ? e : null; }
// 名前の途中に一致しただけのもの（「インド」と「インドネシア」、「ナポレオン」と「ナポレオン3世」など）は除く
function jtEdge(s, a, b){
  const n = s.slice(a, b), pre = s[a - 1] || "", nx = s[b] || "", K = /[ァ-ヶー]/;
  if (K.test(n[0]) && /[ァ-ヶー=＝]/.test(pre)) return false;
  if (K.test(n[n.length - 1]) && /[ァ-ヶー=＝0-9０-９]/.test(nx)) return false;
  return true;
}
function jtScan(text, fn){
  const J = jt(), s = String(text || ""); if (!J.re || !s) return;
  const re = new RegExp(J.re.source, "g"); let m;
  while ((m = re.exec(s))){ if (jtEdge(s, m.index, m.index + m[0].length)) fn(m[0], m.index); }
}
function jtFind(text){ const out = []; jtScan(text, n => { const e = jtGet(n); if (e && !out.includes(e)) out.push(e); }); return out; }
// 文中の項目名をリンクにする（同じ項目は最初の1回だけ）
function jtLinkify(text, self){
  const s = String(text || ""); let h = "", last = 0; const used = new Set([jtGet(self)]);
  jtScan(s, (n, a) => {
    const e = jtGet(n);
    if (!e || used.has(e) || a < last) return; used.add(e);
    h += nl(s.slice(last, a)) + `<button class="jl" data-act="jt" data-n="${esc(n)}">${esc(n)}</button>`; last = a + n.length;
  });
  return h + nl(s.slice(last));
}
function jtBack(){
  const J = jt(); if (J.back) return J.back;
  const B = new Map(), get = e => { if (!B.has(e)) B.set(e, { inP: [], inX: [], causeOf: [], resultOf: [], ev: [], people: [] }); return B.get(e); };
  const push = (arr, e) => { if (!arr.includes(e)) arr.push(e); };
  J.list.forEach(e => {
    e.p.forEach(n => { const t = jtGet(n); if (t && t !== e) push(get(t).inP, e); });
    e.x.forEach(n => { const t = jtGet(n); if (t && t !== e) push(get(t).inX, e); });
    e.c.forEach(it => jtFind(it).forEach(t => { if (t !== e && t.t !== "C") push(get(t).causeOf, e); }));
    e.r.forEach(it => jtFind(it).forEach(t => { if (t !== e && t.t !== "C") push(get(t).resultOf, e); }));
    e.cs.forEach(n => { const t = jtCountry(n); if (t) push(e.t === "P" ? get(t).people : get(t).ev, e); });
  });
  J.back = B; return B;
}
function jtB(e){ return jtBack().get(e) || { inP: [], inX: [], causeOf: [], resultOf: [], ev: [], people: [] }; }
function jtByYear(a, b){ return (a.year ?? 1e9) - (b.year ?? 1e9) || (a.yearEnd ?? a.year ?? 0) - (b.yearEnd ?? b.year ?? 0) || a.name.localeCompare(b.name, "ja"); }
// 「1831〜1833、1839〜1840」のような長い書き方は、一覧では最初の年だけにする
function jtYearShort(e){
  if (e.yraw){ const t = e.yt || ""; if (t.length <= 10) return t; const m = t.match(/^(.*?)([〜・、])/); return m ? m[1] + (m[2] === "〜" ? "〜" : "…") : t.slice(0, 10) + "…"; }
  return e.year == null ? "" : yearStr(e.year) + (e.yearEnd != null ? "〜" + yearStr(e.yearEnd) : "") + (e.approx ? "頃" : ""); }
function jtCut(s, n){ s = String(s || "").split("\n")[0]; return s.length > n ? s.slice(0, n) + "…" : s; }
function jtRow(e, o = {}){
  const sub = e.t === "C" ? jtCut(e.d, 60) : e.t === "P" ? [e.yt, e.cs.join("・")].filter(Boolean).join(" ・ ") + (o.desc !== false && e.d ? "｜" + jtCut(e.d, 50) : "") : (o.desc && e.d ? jtCut(e.d, 60) : e.cs.join("・"));
  const yr = e.t === "E" ? jtYearShort(e) : o.label ? JT_TYPES[e.t] : "";
  return `<button class="ev ${o.cur ? "cur" : ""}" data-act="${o.cur ? "" : "jt"}" data-n="${esc(e.name)}">${yr || e.t === "E" ? `<span class="yr ${e.t === "E" ? "" : "jty"}">${esc(yr)}</span>` : ""}
    <span class="evb"><span class="tt">${esc(e.name)}</span>${sub ? `<span class="ds">${esc(sub)}</span>` : ""}</span></button>`;
}
function jtChip(n){
  const e = jtGet(n);
  return e ? `<button class="rchip" data-act="jt" data-n="${esc(e.name)}">${esc(n)}</button>`
           : `<button class="rchip gray" data-act="jtFind" data-q="${esc(stripParen(n))}">${esc(n)}</button>`;
}
function jtChipsFor(text){
  const l = jtFind(text).filter(e => e.t !== "C").slice(0, 6);
  return l.length ? `<div class="muted small" style="margin-top:10px">事典で見る</div><div class="chipline" style="margin-top:4px">${l.map(e => `<button class="rchip" data-act="jt" data-n="${esc(e.name)}">${esc(e.name)}</button>`).join("")}</div>` : "";
}
function jtBadge(e){ return `<span class="jtb jt${e.t}">${JT_TYPES[e.t]}</span>`; }
function jtChLabel(e){ return e.ch.map(no => { const c = chOf(no); return c && c.no === no ? `第${no}章 ${c.short}` : `第${no}章`; }).join("・"); }
function jtUl(items, self){ return `<ul class="jtl">${items.map(t => `<li>${jtLinkify(t, self)}</li>`).join("")}</ul>`; }
function jtCardsAbout(e){
  const keys = [e.name, stripParen(e.name), ...(e.al || []).map(jtAl)].filter(k => k && k.length >= 2);
  return live().filter(c => !isEv(c) && keys.some(k => cardText(c).includes(k))).slice(0, 8);
}
function jtFlowNear(e, country){
  const same = jtB(country).ev.filter(x => x.year != null).sort(jtByYear), i = same.indexOf(e);
  if (i < 0) return "";
  return same.slice(Math.max(0, i - 2), i).map(x => jtRow(x)).join("") + jtRow(e, { cur: true }) + same.slice(i + 1, i + 3).map(x => jtRow(x)).join("");
}
function jtSheetHTML(top){
  const e = jtGet(top.n); if (!e) return null;
  const B = jtB(e), shown = new Set([e]);
  const rows = (title, arr, o) => { const l = arr.filter(x => !shown.has(x)); l.forEach(x => shown.add(x)); return l.length ? `<h3 class="sub">${title}</h3>` + l.map(x => jtRow(x, o)).join("") : ""; };
  let h = sheetTop("") + `<div class="muted small">${jtBadge(e)}${e.ch.length ? " ・ " + esc(jtChLabel(e)) : ""}${e.t === "C" && e.region ? " ・ " + rDot(e.region) : ""}${e.edited ? " ・ 自分で直した項目" : ""}</div>`;
  if (e.t === "E") h += `<div class="evy">${esc(!e.yt ? "" : e.yraw ? e.yt : jtYearShort(e) + "年")}</div>`;
  h += `<div class="evt">${esc(e.name)}</div>`;
  if (e.t === "P" && e.yt) h += `<div class="muted small">${esc(e.yt)}</div>`;
  if (e.t === "C" && e.al.length) h += `<div class="muted small">ふくまれる王朝・ほかの呼び方：${esc(e.al.map(jtAl).join("・"))}</div>`;
  if (e.d) h += `<p style="margin:6px 0 0">${jtLinkify(e.d, e.name)}</p>`;
  if (e.t !== "C" && e.cs.length) h += `<div class="chipline">${e.cs.map(jtChip).join("")}</div>`;
  if (e.t === "E"){
    if (e.c.length) h += `<h3 class="sub">原因・背景</h3>` + jtUl(e.c, e.name);
    if (e.r.length) h += `<h3 class="sub">結果・影響</h3>` + jtUl(e.r, e.name);
    const ps = e.p.map(jtGet).filter(x => x && x.t === "P"), miss = e.p.filter(n => !jtGet(n));
    if (ps.length || miss.length){ h += `<h3 class="sub">関連人物</h3>` + ps.map(x => jtRow(x)).join(""); ps.forEach(x => shown.add(x)); if (miss.length) h += `<div class="chipline">${miss.map(jtChip).join("")}</div>`; }
    if (e.x.length) h += `<h3 class="sub">関連事項</h3><div class="chipline" style="margin-top:4px">${e.x.map(jtChip).join("")}</div>`;
    h += rows("ここから起きたこと（ほかの項目の原因に登場）", B.causeOf.slice().sort(jtByYear));
    h += rows("ここに至るまで（ほかの項目の結果に登場）", B.resultOf.slice().sort(jtByYear));
    e.cs.map(jtCountry).filter(Boolean).filter((c, i, a) => a.indexOf(c) === i).slice(0, 3).forEach(c => {
      const f = jtFlowNear(e, c); if (f) h += `<h3 class="sub">${esc(c.name)}の流れ（前後）</h3>` + f;
    });
    h += rows("ほかの項目から関連づけ", B.inX.concat(B.inP).slice().sort(jtByYear), { label: true });
  } else if (e.t === "P"){
    const own = e.x.map(jtGet).filter(Boolean), miss = e.x.filter(n => !jtGet(n));
    const all = [...own, ...B.inP, ...B.inX, ...B.causeOf, ...B.resultOf].filter((x, i, a) => a.indexOf(x) === i && x !== e);
    const evl = all.filter(x => x.t === "E").sort(jtByYear), etc = all.filter(x => x.t !== "E");
    if (evl.length || miss.length){ h += `<h3 class="sub">関わった出来事（${evl.length}）</h3>` + evl.map(x => jtRow(x, { desc: true })).join(""); if (miss.length) h += `<div class="chipline">${miss.map(jtChip).join("")}</div>`; }
    evl.forEach(x => shown.add(x));
    if (etc.length) h += `<h3 class="sub">関係する人物・国</h3>` + etc.map(x => jtRow(x, { label: true })).join("");
    etc.forEach(x => shown.add(x));
    const cs = e.cs.map(jtCountry).filter(Boolean);
    if (e.year != null && cs.length){
      const near = jtB(cs[0]).people.filter(x => x !== e && x.year != null && Math.abs(x.year - e.year) <= 60 && !shown.has(x)).sort(jtByYear).slice(0, 6);
      if (near.length) h += `<h3 class="sub">同じころの${esc(cs[0].name)}の人物</h3>` + near.map(x => jtRow(x)).join("");
    }
  } else {
    if (e.f.length) h += `<h3 class="sub">流れ</h3><div class="tl">${e.f.map(([y, t]) => `<div class="tlr"><span class="yr">${esc(y)}</span><span class="tlt">${jtLinkify(t, e.name)}</span></div>`).join("")}</div>`;
    const evl = B.ev.slice().sort(jtByYear), ppl = B.people.slice().sort(jtByYear);
    if (evl.length) h += `<details class="jtd"><summary>この国が関わる出来事（${evl.length}）</summary>${evl.map(x => jtRow(x)).join("")}</details>`;
    if (ppl.length) h += `<details class="jtd"><summary>この国の人物（${ppl.length}）</summary>${ppl.map(x => jtRow(x)).join("")}</details>`;
  }
  if (e.memo) h += `<h3 class="sub">自分のメモ</h3><div class="memo" data-act="jtEdit" data-n="${esc(e.name)}">${nl(e.memo)}</div>`;
  const mine = e.t === "E" ? evs().filter(x => x.title === e.name || stripParen(x.title) === stripParen(e.name)) : [];
  if (mine.length) h += `<h3 class="sub">自分の年号カード</h3>` + mine.map(x => evRow(x, { region: true })).join("");
  const cs = e.t === "C" ? [] : jtCardsAbout(e);
  if (cs.length) h += `<h3 class="sub">関連する一問一答</h3>` + cs.map(c => `<button class="item" data-act="edit" data-id="${esc(c.id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div></button>`).join("");
  const wq = encodeURIComponent(stripParen(e.name) || e.name);
  h += `<div class="btns"><a class="btn line" href="https://ja.wikipedia.org/w/index.php?search=${wq}" target="_blank" rel="noopener noreferrer">Wikipedia</a><button class="btn sec" data-act="findIn" data-q="${esc(stripParen(e.name) || e.name)}">アプリ内で検索</button></div>`;
  h += `<div class="btns"><button class="btn" data-act="jtEdit" data-n="${esc(e.name)}">直す・メモを書く</button></div>`;
  if (e.base && !e.edited) h += `<p class="muted small" style="margin:10px 0 0">Claude が作った項目です。教科書・資料集とちがうところがあったら「直す」で書きかえてね。</p>`;
  return h;
}
function jtForm(e, isNew){
  return { t: e.t, name: e.name, isNew: !!isNew, base: !!e.base, edited: !!e.edited, yt: e.yt || "", cs: e.cs.join("、"), ch: e.ch.join("、"), d: e.d || "",
    c: e.c.join("\n"), r: e.r.join("\n"), p: e.p.join("、"), x: e.x.join("、"), region: e.region || "", al: e.al.join("、"),
    f: e.f.map(([y, t]) => `${y} ｜ ${t}`).join("\n"), memo: e.memo || "" };
}
function jtEditHTML(top){
  const f = top.f, T = f.t, inp = (k, label, ph) => `<label class="f">${label}</label><input type="text" data-bind="edit.${k}" value="${esc(f[k])}" placeholder="${esc(ph || "")}">`;
  const ta = (k, label, ph, cls) => `<label class="f">${label}</label><textarea class="${cls || "mid"}" data-bind="edit.${k}" placeholder="${esc(ph || "")}">${esc(f[k])}</textarea>`;
  let h = sheetTop(f.isNew ? "事典に項目を追加" : "直す：" + f.name);
  if (f.isNew) h += `<div class="seg s3">${["E", "P", "C"].map(t => `<button class="${T === t ? "on" : ""}" data-act="jtSetT" data-v="${t}">${JT_TYPES[t]}</button>`).join("")}</div>`;
  if (f.isNew || !f.base) h += inp("name", "名前", T === "E" ? "カノッサの屈辱" : T === "P" ? "グレゴリウス7世" : "フランス");
  if (T === "E"){
    h += inp("yt", "年（例：1077、前221、1337〜1453）", "1077") + inp("cs", "関わった国（「、」で区切る）", "神聖ローマ帝国、ローマ教皇")
      + ta("d", "説明", "") + ta("c", "原因・背景（1行に1つ）", "叙任権をめぐる対立") + ta("r", "結果・影響（1行に1つ）", "教皇権の伸長")
      + inp("p", "関連人物（「、」で区切る）", "グレゴリウス7世、ハインリヒ4世") + inp("x", "関連事項（「、」で区切る）", "叙任権闘争");
  } else if (T === "P"){
    h += inp("yt", "生没年・在位など", "在位1056〜1106") + inp("cs", "国（「、」で区切る）", "神聖ローマ帝国") + ta("d", "何をした人物か", "")
      + inp("x", "関わった出来事・事項（「、」で区切る）", "カノッサの屈辱、叙任権闘争");
  } else {
    h += inp("region", "地域", REGIONS.join("・")) + inp("al", "ほかの呼び方（「、」で区切る）", "") + ta("d", "概要", "")
      + ta("f", "流れ（1行に「年 ｜ 内容」）", "987 ｜ カペー朝が始まる", "tall");
  }
  if (T !== "C") h += inp("ch", "章の番号（任意・「、」で区切る）", "10");
  h += ta("memo", "自分のメモ（覚え方・論述で使えそうなこと など）", "");
  h += `<p class="muted small">関連人物・関連事項・原因・結果に、事典にある名前を書くと自動でリンクになるよ。</p><div class="btns"><button class="btn" data-act="jtSave">保存</button></div>`;
  if (!f.isNew && (f.edited || !f.base)) h += `<div class="btns"><button class="btn danger ${S.confirmDel ? "sure" : ""}" data-act="jtReset">${S.confirmDel ? (f.base ? "本当にもとに戻す" : "本当に削除する") : f.base ? "Claude が作った内容にもどす" : "この項目を削除"}</button></div>`;
  return h;
}
function jtLists(){
  const J = jt(), q = S.jt.q.trim().toLowerCase();
  if (q){
    const has = e => [e.name, ...e.al.map(jtAl), e.yt, e.d, ...e.c, ...e.r, ...e.p, ...e.x, ...e.cs, e.memo, ...e.f.map(x => x.join(" "))].join(" ").toLowerCase().includes(q);
    return J.list.filter(has);
  }
  return J.list;
}
function jtChipIntoView(){ const on = document.querySelector("#jt-chips .chip.on"); if (on && on.scrollIntoView) on.scrollIntoView({ inline: "center", block: "nearest" }); }
function jitenHTML(){
  const J = jt(), n = t => J.list.filter(e => e.t === t).length;
  return `<input type="search" id="jq" placeholder="事典を検索（出来事・人物・国・原因・結果）" value="${esc(S.jt.q)}"><div style="height:10px"></div>
    <div class="seg s3">${["E", "P", "C"].map(t => `<button class="${S.jt.type === t ? "on" : ""}" data-act="jtType" data-v="${t}">${JT_TYPES[t]}（${n(t)}）</button>`).join("")}</div>
    <div style="height:10px"></div><div id="jt-body"></div>`;
}
function renderJtBody(){
  const el = $("#jt-body"); if (!el) return;
  const J = jt();
  if (!J.list.length){ el.innerHTML = `<div class="card"><p class="muted">事典のデータ（jiten.js）を読み込めませんでした。</p></div>`; return; }
  const q = S.jt.q.trim();
  if (q){
    const hit = jtLists(), g = t => hit.filter(e => e.t === t).sort(jtByYear);
    el.innerHTML = hit.length ? ["E", "P", "C"].filter(t => g(t).length).map(t => `<div class="card"><h2>${JT_TYPES[t]}（${g(t).length}）</h2>${g(t).slice(0, 150).map(e => jtRow(e, { desc: true })).join("")}</div>`).join("")
      : `<div class="card"><p class="muted">「${esc(q)}」は事典に見つかりませんでした。</p><button class="btn sec" data-act="findIn" data-q="${esc(q)}">ノートで検索する</button></div>`;
    return;
  }
  const T = S.jt.type; let h = "";
  if (T === "C"){
    const cs = J.list.filter(e => e.t === "C");
    regionOrder(cs).forEach(r => {
      h += `<div class="card"><div class="sech">${rDot(r)}</div>${cs.filter(e => (e.region || "") === r).map(e => jtRow(e)).join("")}</div>`;
    });
  } else {
    const all = J.list.filter(e => e.t === T), chs = [...new Set(all.flatMap(e => e.ch))].sort((a, b) => a - b);
    if (S.jt.ch && !chs.includes(S.jt.ch)) S.jt.ch = 0;
    const mine = (S.jt.ch ? all.filter(e => e.ch.includes(S.jt.ch)) : all).sort(jtByYear);
    h += `<div class="chips" id="jt-chips">${[0, ...chs].map(no => `<button class="chip ${no === S.jt.ch ? "on" : ""}" data-act="jtCh" data-d="${no}">${no ? `${no} ${esc((chOf(no) || {}).no === no ? chOf(no).short : "")}` : "すべて"}</button>`).join("")}</div>`;
    h += `<div class="card"><p class="muted small" style="margin:0 0 4px">${mine.length}件 ・ 古い順</p>${mine.map(e => jtRow(e, { desc: T === "E" })).join("")}</div>`;
  }
  h += `<div class="card"><p class="muted small" style="margin:0 0 10px">事典は Claude が作ったものです。教科書・資料集で確かめながら使って、ちがうところは項目の「直す」で書きかえてね。自分で項目を足すこともできるよ。</p>
    <button class="btn line" data-act="jtNew">＋ 自分で項目を追加</button></div>`;
  el.innerHTML = h;
}
function jtChapCardHTML(ch){
  const l = jt().list.filter(e => e.ch.includes(ch.no)); if (!l.length) return "";
  const ev = l.filter(e => e.t === "E").sort(jtByYear), pp = l.filter(e => e.t === "P").sort(jtByYear);
  const chip = e => `<button class="rchip" data-act="jt" data-n="${esc(e.name)}">${esc(e.name)}</button>`;
  return `<div class="card"><h2>この章の事典</h2><p class="muted small" style="margin-top:-4px">出来事をタップすると、原因・結果・関連人物・国の流れが見られるよ。</p>
    ${ev.length ? `<div class="muted small">出来事（${ev.length}）</div><div class="chipline" style="margin:4px 0 10px">${ev.map(chip).join("")}</div>` : ""}
    ${pp.length ? `<div class="muted small">人物（${pp.length}）</div><div class="chipline" style="margin:4px 0 10px">${pp.map(chip).join("")}</div>` : ""}
    <button class="btn sec" data-act="goJiten" data-d="${ch.no}">事典でこの章を開く</button></div>`;
}

/* ---------- 画面：一覧・設定 ---------- */
function listHTML(){
  return `<input type="search" id="q" placeholder="検索（問題・答え・メモ・タグ）" value="${esc(S.q)}"><div style="height:10px"></div>
    ${kvChips(S.listKind, "lKind", "k", [["all", "すべて"], ["card", "一問一答"], ["event", "出来事"], ["srs", "復習に入っている"]])}
    ${chips(S.listDeck, "lDeck", ["すべて", ...decks()])}<div class="card" style="padding:4px 14px" id="list-items"></div>`;
}
function renderListItems(){
  const el = $("#list-items"); if (!el) return;
  const q = S.q.trim().toLowerCase(), k = S.listKind;
  const items = live().filter(c => inDeck(c, S.listDeck) && (k === "all" || (k === "srs" ? c.srs !== false : (k === "event") === isEv(c))))
    .filter(c => !q || [c.front, c.back, c.memo, c.title, rName(c.region), ...tagsOf(c)].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  if (!items.length){ el.innerHTML = `<p class="muted">${k === "srs" && !q ? "毎日の復習に入っている問題はありません。" : live().length ? "見つかりませんでした。" : "まだ問題がありません。"}</p>`; return; }
  const shown = items.slice(0, 300);
  const tagStr = c => tagsOf(c).length ? " ・ " + tagsOf(c).map(esc).join(" ") : "";
  el.innerHTML = shown.map(c => isEv(c)
    ? `<button class="item" data-act="ev" data-id="${esc(c.id)}"><div class="iq">${esc(c.title)}</div><div class="ia">${esc(yearLabel(c))}</div>
      <div class="im">出来事 ・ ${esc(rName(c.region))}${tagStr(c)} ・ ${c.srs === false ? "復習なし" : dueLabel(c)}</div></button>`
    : `<button class="item" data-act="edit" data-id="${esc(c.id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div>
      <div class="im">${esc(deckOf(c))}${tagStr(c)} ・ ${c.srs === false ? "復習なし" : dueLabel(c)}</div></button>`).join("")
    + (items.length > shown.length ? `<p class="muted small">ほか ${items.length - shown.length} 件（検索で絞り込んでね）</p>` : "");
}
function settingsHTML(){
  const s = settings(), t = token(), dirty = lsGet(LS.dirty, false);
  if (!S.form) S.form = { owner: s.owner, repo: s.repo, path: s.path, token: "" };
  const f = S.form;
  const stMsg = { ok: "同期済み", syncing: "同期中…", offline: "オフライン（つながったら自動で送ります）", error: "エラー：" + S.sync.msg, unset: "未設定", idle: "—" }[S.sync.state] || "—";
  let h = `<div class="card"><h2>同期</h2>
    <div class="kv"><span>状態</span><span>${esc(t ? stMsg : "未設定")}</span></div>
    <div class="kv"><span>未送信の変更</span><span>${dirty ? "あり" : "なし"}</span></div>
    <div class="kv"><span>最後に同期</span><span>${fmtDate(lsGet(LS.last, 0))}</span></div>
    <div style="height:8px"></div><button class="btn sec" data-act="syncNow" ${t ? "" : "disabled"}>今すぐ同期</button></div>`;
  h += `<div class="card"><h2>GitHub の設定</h2>
    <label class="f">GitHub のユーザー名</label><input type="text" data-bind="form.owner" value="${esc(f.owner)}" autocapitalize="off" autocorrect="off" spellcheck="false">
    <label class="f">記録用リポジトリ（非公開）</label><input type="text" data-bind="form.repo" value="${esc(f.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false">
    <label class="f">ファイル名</label><input type="text" data-bind="form.path" value="${esc(f.path)}" autocapitalize="off" autocorrect="off" spellcheck="false">
    <label class="f">トークン ${t ? `<span class="small">（保存済み：…${esc(t.slice(-4))}。変えるときだけ入力）</span>` : ""}</label>
    <input type="password" data-bind="form.token" value="${esc(f.token)}" placeholder="github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
    <p class="muted small">トークンはこの端末の中にだけ保存され、公開リポジトリやコードには入りません。ホーム画面に追加したアプリと Safari は保存場所が別なので、<b>ホーム画面から開いたアプリ</b>で入力してね。</p>`;
  if (S.testMsg) h += `<div class="note ${S.testMsg.cls}">${S.testMsg.html}</div>`;
  h += `<button class="btn" data-act="saveSettings">保存して接続を確かめる</button>
    ${t ? `<div style="height:8px"></div><button class="btn danger" data-act="clearToken">この端末からトークンを消す</button>` : ""}</div>`;
  h += `<div class="card"><h2>バックアップ</h2><p class="muted small" style="margin-top:-4px">全部の問題・出来事・まとめと復習記録を JSON ファイルにして保存できるよ。</p>
    <div class="btns"><button class="btn sec" data-act="exportFile">書き出す</button><button class="btn line" data-act="exportCopy">コピー</button></div>
    <div style="height:8px"></div><button class="btn line" data-act="importFile">バックアップを読み込む</button></div>`;
  const nEv = evs().length, nNote = S.cards.filter(c => !c.deleted && c.kind === "note").length;
  h += `<p class="muted small" style="text-align:center">一問一答 ${live().length - nEv}問 ・ 出来事 ${nEv}件 ・ まとめ ${nNote}件</p>`;
  return h;
}

/* ---------- シート（下から出る画面） ---------- */
function topSheet(){ return S.sheet[S.sheet.length - 1] || null; }
function pushSheet(it){ S.sheet.push(it); S.confirmDel = false; renderSheet(); const inner = $("#sheet .inner"); if (inner) inner.scrollTop = 0; }
function popSheet(){ S.sheet.pop(); S.confirmDel = false; renderSheet(); }
function closeSheet(){ S.sheet = []; S.confirmDel = false; renderSheet(); }
function sheetTop(title){
  return `<div class="shtop">${S.sheet.length > 1 ? `<button class="link" data-act="back">‹ 戻る</button>` : "<span></span>"}<button class="link" data-act="closeEdit">閉じる</button></div>${title ? `<h2>${esc(title)}</h2>` : ""}`;
}
function renderSheet(){
  const sh = $("#sheet");
  for (;;){
    const top = topSheet();
    if (!top){ sh.classList.remove("open"); S.edit = null; return; }
    S.edit = top.f || null;
    const h = top.t === "ev" ? evSheetHTML(top) : top.t === "evEdit" ? evEditHTML(top) : top.t === "memo" ? memoSheetHTML(top)
      : top.t === "jt" ? jtSheetHTML(top) : top.t === "jtEdit" ? jtEditHTML(top) : cardSheetHTML(top);
    if (h === null){ S.sheet.pop(); continue; }   // 消された項目は飛ばす
    $("#sheet-inner").innerHTML = h; sh.classList.add("open"); return;
  }
}
function cardSheetHTML(top){
  const c = card(top.id); if (!c) return null;
  const e = top.f, rel = eventsIn(c);
  return sheetTop("問題を直す") + `
    <label class="f">問題</label><textarea data-bind="edit.front">${esc(e.front)}</textarea>
    <label class="f">答え</label><textarea data-bind="edit.back">${esc(e.back)}</textarea>
    <label class="f">メモ</label><textarea data-bind="edit.memo">${esc(e.memo)}</textarea>
    <div class="row2"><div><label class="f">科目</label><input type="text" data-bind="edit.deck" value="${esc(e.deck)}"></div>
    <div><label class="f">タグ</label><input type="text" data-bind="edit.tags" value="${esc(e.tags)}"></div></div>
    ${rel.length ? `<label class="f">関連する出来事</label><div class="chipline" style="margin-top:0">${rel.map(evChip).join("")}</div>` : ""}
    <div class="btns"><button class="btn" data-act="saveEdit">保存</button></div>
    <h3 class="sub">毎日の復習</h3><div class="kv"><span>${c.srs === false ? "入っていない" : "入っている"}</span><span>${c.srs === false ? "" : esc(dueLabel(c))}</span></div>
    <div class="btns" style="margin-top:4px"><button class="btn sec" data-act="srsToggle" data-id="${esc(c.id)}">${c.srs === false ? "毎日の復習に入れる" : "毎日の復習から外す"}</button></div>
    ${c.srs === false ? "" : `<div class="btns"><button class="btn line" data-act="dueNow">今日の復習に出す</button></div>`}
    <div class="btns"><button class="btn danger ${S.confirmDel ? "sure" : ""}" data-act="del">${S.confirmDel ? "本当に削除する" : "この問題を削除"}</button></div>`;
}
function evSheetHTML(top){
  const e = card(top.id); if (!isEv(e)) return null;
  const list = evs(), cent = centuryOf(e.year);
  const linked = linkedOf(e, list), miss = unresolvedOf(e, list), flow = flowOf(e, list), same = sameTimeOf(e, list), cs = cardsAbout(e);
  const memo = noteOf(noteKey(e.region, cent));
  let h = sheetTop("") + `<div class="muted small">${rDot(e.region)} ・ ${esc(centLabel(cent))}${tagsOf(e).length ? " ・ " + tagsOf(e).map(esc).join(" ") : ""}</div>
    <div class="evy">${esc(yearLabel(e))}</div><div class="evt">${esc(e.title)}</div>`;
  if (e.desc) h += `<p style="margin:2px 0 0">${nl(e.desc)}</p>`;
  const je = jtGet(e.title) || jtGet(stripParen(e.title));
  if (je) h += `<div class="chipline"><button class="rchip" data-act="jt" data-n="${esc(je.name)}">事典で原因・結果・人物を見る</button></div>`;
  if (tagsOf(e).includes("要確認")) h += `<div class="note warn small">「要確認」がついています。年号や内容を教科書・資料集で確かめてね。</div>`;
  if (linked.length || miss.length){
    h += `<h3 class="sub">関連する出来事</h3>` + linked.map(x => evRow(x, { region: true })).join("");
    if (miss.length) h += `<div class="chipline">${miss.map(n => `<button class="rchip gray" data-act="findIn" data-q="${esc(n)}">${esc(n)}（未登録・検索）</button>`).join("")}</div>`;
  }
  h += `<h3 class="sub">${esc(rName(e.region))}の流れ</h3>` + flow.prev.map(x => evRow(x)).join("") + evRow(e, { cur: true }) + flow.next.map(x => evRow(x)).join("");
  h += `<h3 class="sub">同じころのほかの地域（前後25年）</h3>` + (same.length ? same.map(x => evRow(x, { region: true })).join("") : `<p class="muted small">まだ登録がありません</p>`);
  if (cs.length) h += `<h3 class="sub">関連する一問一答</h3>` + cs.map(c => `<button class="item" data-act="edit" data-id="${esc(c.id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div></button>`).join("");
  if (memo) h += `<h3 class="sub">まとめ（${esc(rName(e.region))}・${esc(centLabel(cent))}）</h3><div class="memo">${nl(memo)}</div>`;
  const wq = encodeURIComponent(stripParen(e.title) || e.title), gq = encodeURIComponent(e.title + " 世界史");
  h += `<h3 class="sub">調べる</h3><div class="btns" style="margin-top:4px"><button class="btn sec" data-act="findIn" data-q="${esc(stripParen(e.title) || e.title)}">アプリ内で検索</button></div>
    <div class="btns"><a class="btn line" href="https://ja.wikipedia.org/w/index.php?search=${wq}" target="_blank" rel="noopener noreferrer">Wikipedia</a>
    <a class="btn line" href="https://www.google.com/search?q=${gq}" target="_blank" rel="noopener noreferrer">Google</a></div>`;
  h += `<h3 class="sub">毎日の復習</h3><div class="kv"><span>${e.srs === false ? "入っていない" : "入っている"}</span><span>${e.srs === false ? "" : esc(dueLabel(e))}</span></div>
    <div class="btns" style="margin-top:4px"><button class="btn sec" data-act="srsToggle" data-id="${esc(e.id)}">${e.srs === false ? "毎日の復習に入れる" : "毎日の復習から外す"}</button></div>
    <div class="btns"><button class="btn" data-act="evEdit" data-id="${esc(e.id)}">この出来事を直す</button></div>`;
  return h;
}
function evForm(e){
  const rel = (Array.isArray(e.related) ? e.related : []).map(id => card(id)).filter(isEv).map(x => x.title);
  return { title: e.title || "", year: yearInput(e), region: e.region || "", desc: e.desc || "", tags: tagsOf(e).join(", "),
    related: [...rel, ...(Array.isArray(e.relNames) ? e.relNames : [])].join("、"), srs: e.srs !== false };
}
function evEditHTML(top){
  const e = card(top.id); if (!isEv(e)) return null;
  return sheetTop("出来事を直す") + evFormFields("edit", top.f) + `<div class="btns"><button class="btn" data-act="saveEv">保存</button></div>
    <div class="btns"><button class="btn danger ${S.confirmDel ? "sure" : ""}" data-act="del">${S.confirmDel ? "本当に削除する" : "この出来事を削除"}</button></div>`;
}
function memoSheetHTML(top){
  return sheetTop("まとめ：" + noteLabel(top.key)) + `<textarea class="tall" data-bind="edit.text" placeholder="・この時代の流れ&#10;・ほかの地域とのつながり&#10;・覚え方">${esc(top.f.text)}</textarea>
    <p class="muted small">自分の言葉でまとめると覚えやすいよ。Claude に「${esc(noteLabel(top.key))}の要点を箇条書きで」と頼んで貼ってもOK（そのときは教科書で確かめてね）。空にして保存すると消えます。</p>
    <div class="btns"><button class="btn" data-act="saveMemo">保存</button></div>`;
}

function renderMain(){
  const m = $("#main"), v = S.view;
  m.innerHTML = v === "home" ? homeHTML() : v === "quiz" ? quizHTML() : v === "review" ? reviewHTML() : v === "practice" ? practiceHTML()
    : v === "year" ? yearHTML() : v === "note" ? noteHTML() : v === "jiten" ? jitenHTML() : v === "add" ? addHTML() : v === "list" ? listHTML() : settingsHTML();
  if (v === "list") renderListItems();
  if (v === "note") renderNoteBody();
  if (v === "jiten"){ renderJtBody(); jtChipIntoView(); }
  $("#ttl").textContent = { home: "問題", quiz: "問題", review: "復習", practice: "練習", year: "年号", note: "ノート", jiten: "事典", add: "追加", list: "一覧", settings: "設定" }[v] || "世界史";
  const tab = v === "review" || v === "practice" || v === "quiz" ? "home" : v;
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.v === tab));
  renderPill();
}

/* ---------- バックアップ ---------- */
function backupText(){ return JSON.stringify({ app: "sekaishi", version: 1, exported: Date.now(), cards: S.cards }, null, 1); }
function importBackup(text){
  let data; try { data = JSON.parse(text); } catch(e){ toast("JSON を読み取れませんでした"); return; }
  const cards = Array.isArray(data) ? data : data && Array.isArray(data.cards) ? data.cards : null;
  if (!cards){ toast("問題データが見つかりませんでした"); return; }
  const valid = cards.filter(c => c && typeof c.id === "string" && (c.deleted || c.kind === "meta" || (c.kind === "note" && typeof c.text === "string") || (c.kind === "jt" && c.data && typeof c.data === "object")
    || (typeof c.front === "string" && typeof c.back === "string")));
  const before = S.cards.filter(c => !c.deleted).length;
  S.cards = merge(S.cards, valid); commit();
  toast(`読み込みました（${S.cards.filter(c => !c.deleted).length - before}件増えました）`); renderMain();
}

/* ---------- 操作 ---------- */
function setPath(p, v){ const [a, b] = p.split("."); if (S[a]) S[a][b] = v; }
function afterEdit(){
  if (S.view === "list") renderListItems();
  else if (S.view === "note") renderNoteBody();
  else if (S.view === "jiten") renderJtBody();
  else if (["review", "practice", "home", "year", "quiz"].includes(S.view)) renderMain();
}
function focusYin(){ const i = $("#yin"); if (i) i.focus(); }
const act = {
  nav(el){
    let v = el.dataset.v;
    if (v === "home" && S.quiz) v = "quiz";   // 解いている途中なら続きへ
    if (v !== "review") S.session = null;
    if (v !== "settings"){ S.form = null; S.testMsg = null; }
    S.add.confirmStarterDel = false;
    S.view = v; renderMain(); window.scrollTo(0, 0);
  },
  deck(el){ S.deck = el.dataset.d; renderMain(); },
  start(){
    const due = dueList(S.deck); if (!due.length) return;
    S.session = { queue: due.map(c => c.id), idx: 0, shown: false, done: 0, again: 0 };
    S.view = "review"; renderMain(); window.scrollTo(0, 0);
  },
  show(){ S.session.shown = true; renderMain(); },
  rate(el){
    const s = S.session, id = s.queue[s.idx], c = card(id); if (!c) return;
    const r = +el.dataset.r;
    updateCard(id, schedule(c, r)); commit();
    s.done++; if (r === 0){ s.again++; s.queue.push(id); }
    s.idx++; s.shown = false; renderMain(); window.scrollTo(0, 0);
  },
  quit(){ S.session = null; S.view = "home"; renderMain(); },
  rOut(){
    const s = S.session, id = s.queue[s.idx]; if (!card(id)) return;
    updateCard(id, { srs: false }); commit();
    s.queue = s.queue.filter((x, i) => i < s.idx || x !== id);   // この先に「もう一度」で残っている分も出さない
    s.shown = false; toast("毎日の復習から外しました"); renderMain(); window.scrollTo(0, 0);
  },
  pDeck(el){ S.pset.deck = el.dataset.d; S.pset.tag = ""; renderMain(); },
  pTag(el){ S.pset.tag = el.dataset.d; renderMain(); },
  pOrder(el){ S.pset.order = el.dataset.d === "ランダム" ? "random" : "created"; renderMain(); },
  pCount(el){ S.pset.count = el.dataset.d === "全部" ? 0 : parseInt(el.dataset.d, 10); renderMain(); },
  pStart(){
    let pool = practicePool(); if (!pool.length) return;
    pool = S.pset.order === "random" ? shuffle(pool) : pool.sort((a, b) => (a.created || 0) - (b.created || 0));
    if (S.pset.count) pool = pool.slice(0, S.pset.count);
    S.practice = { queue: pool.map(c => c.id), idx: 0, shown: false, res: {}, round: 1 };
    renderMain(); window.scrollTo(0, 0);
  },
  pShow(){ S.practice.shown = true; renderMain(); },
  pAns(el){ const P = S.practice; P.res[P.queue[P.idx]] = el.dataset.ok === "1"; P.idx++; P.shown = false; renderMain(); window.scrollTo(0, 0); },
  pRetry(){ const P = S.practice; const wrong = P.queue.filter(id => P.res[id] === false && card(id));
    S.practice = { queue: shuffle(wrong), idx: 0, shown: false, res: {}, round: P.round + 1 }; renderMain(); window.scrollTo(0, 0); },
  pAgain(){ const P = S.practice; S.practice = { queue: S.pset.order === "random" ? shuffle(P.queue) : P.queue, idx: 0, shown: false, res: {}, round: P.round + 1 }; renderMain(); window.scrollTo(0, 0); },
  pEnd(){ S.practice = null; renderMain(); },

  /* 年号ドリル */
  ySet(el){
    const k = el.dataset.k, v = el.dataset.v;
    S.yset[k] = k === "n" || k === "total" ? +v : k === "near" ? v === "1" : v;
    renderMain();
  },
  yStart(){
    const p = S.yset, pool = yPool();
    if (!yReady(p.mode, pool, p.n)){ S.yd = null; renderMain(); return; }
    const d = { mode: p.mode, n: p.n, near: p.near, idx: 0, score: 0, wrong: [], ids: pool.map(e => e.id) };
    if (p.mode === "sort") d.total = p.total;
    else { d.queue = shuffle(pool).slice(0, p.total).map(e => e.id); d.total = d.queue.length; }
    S.yd = d; yMake(); renderMain(); window.scrollTo(0, 0); focusYin();
  },
  yPick(el){ const c = S.yd.cur; if (!c.picked.includes(el.dataset.id) && c.picked.length < c.order.length) c.picked.push(el.dataset.id); renderMain(); },
  yUnpick(el){ S.yd.cur.picked.splice(+el.dataset.i, 1); renderMain(); },
  yCheck(){
    const d = S.yd, c = d.cur; if (d.answered || c.picked.length < c.order.length) return;
    const ok = c.order.every((id, i) => c.picked[i] === id);
    if (ok) d.score++; else c.order.forEach((id, i) => { if (c.picked[i] !== id) d.wrong.push(id); });
    d.answered = true; d.lastOk = ok; renderMain();
  },
  yChoose(el){
    const d = S.yd, c = d.cur, e = card(c.id); if (d.answered || !e) return;
    const i = +el.dataset.i, ok = d.mode === "y4" ? c.choices[i] === e.year : c.choices[i] === e.id;
    if (ok) d.score++; else d.wrong.push(e.id);
    d.sel = i; d.answered = true; d.lastOk = ok; renderMain();
  },
  yBc(el){ S.yd.cur.bc = el.dataset.v === "1"; renderMain(); focusYin(); },
  yInCheck(){
    const d = S.yd, c = d.cur, e = card(c.id); if (d.answered || !e) return;
    const s = z2h(c.input).trim(), digits = s.replace(/\D/g, "");
    if (!digits || !+digits){ toast("年号を入れてね"); focusYin(); return; }
    const bc = c.bc || /^(前|紀元前|[-−]|BC)/i.test(s);
    d.mine = bc ? -digits : +digits;
    const ok = d.mine === e.year;
    if (ok) d.score++; else d.wrong.push(e.id);
    d.answered = true; d.lastOk = ok; renderMain();
  },
  yNext(){ const d = S.yd; d.idx++; if (d.idx < d.total) yMake(); renderMain(); window.scrollTo(0, 0); focusYin(); },
  yQuit(){ S.yd = null; renderMain(); window.scrollTo(0, 0); },
  yWrongReview(){
    const d = S.yd; const ids = [...new Set(d.wrong)].filter(id => isEv(card(id)));
    ids.forEach(id => updateCard(id, { srs: true, due: Date.now() })); commit();
    d.wrongDone = true; toast(ids.length + "件を今日の復習に入れました"); renderMain();
  },

  /* ノート */
  nMode(el){ S.note.mode = el.dataset.v; S.note.q = ""; renderMain(); },
  nRegion(el){ S.note.region = el.dataset.d; renderNoteBody(); },
  nCent(el){ S.note.cent = +el.dataset.d; renderNoteBody(); },
  nStep(el){
    const cents = [...new Set(evs().map(e => centuryOf(e.year)))].sort((a, b) => a - b);
    const i = cents.indexOf(S.note.cent) + +el.dataset.v;
    if (i >= 0 && i < cents.length){ S.note.cent = cents[i]; renderNoteBody(); const on = document.querySelector("#cent-chips .chip.on"); if (on && on.scrollIntoView) on.scrollIntoView({ inline: "center", block: "nearest" }); }
  },
  nLine(el){ S.note.line = el.dataset.d; renderNoteBody(); },
  memo(el){ const key = el.dataset.k; pushSheet({ t: "memo", key, f: { text: noteOf(key) } }); },
  saveMemo(){ const top = topSheet(); setNote(top.key, top.f.text); commit(); popSheet(); toast("まとめを保存しました"); afterEdit(); },
  findIn(el){ closeSheet(); S.session = null; S.note.q = el.dataset.q || ""; S.view = "note"; renderMain(); window.scrollTo(0, 0); },

  /* シート */
  ev(el){ if (card(el.dataset.id)) pushSheet({ t: "ev", id: el.dataset.id }); },
  jt(el){ const e = jtGet(el.dataset.n); if (e) pushSheet({ t: "jt", n: e.name }); },
  jtType(el){ S.jt.type = el.dataset.v; S.jt.q = ""; renderMain(); window.scrollTo(0, 0); },
  jtCh(el){ S.jt.ch = +el.dataset.d; renderJtBody(); jtChipIntoView(); },
  jtFind(el){ closeSheet(); S.session = null; S.jt.q = el.dataset.q || ""; S.view = "jiten"; renderMain(); window.scrollTo(0, 0); },
  goJiten(el){ closeSheet(); S.jt = { type: "E", ch: +el.dataset.d || 0, q: "" }; S.view = "jiten"; renderMain(); window.scrollTo(0, 0); },
  jtEdit(el){ const e = jtGet(el.dataset.n); if (e) pushSheet({ t: "jtEdit", n: e.name, f: jtForm(e, false) }); },
  jtNew(){ pushSheet({ t: "jtEdit", n: null, f: jtForm(jtBlank(S.jt.type), true) }); },
  jtSetT(el){ const f = topSheet().f; f.t = el.dataset.v; renderSheet(); },
  jtSave(){
    const top = topSheet(), f = top.f, name = String(f.name || "").trim();
    if (!name){ toast("名前を書いてね"); return; }
    const old = top.n, clash = jt().by.get(name);
    if ((f.isNew || name !== old) && clash){ toast("同じ名前の項目がもうあります"); return; }
    const data = { t: f.t, yt: f.yt.trim(), cs: jtNames(f.cs), ch: jtNames(z2h(f.ch)).map(Number).filter(Boolean), d: f.d.trim(),
      c: jtItems(f.c), r: jtItems(f.r), p: jtNames(f.p), x: jtNames(f.x), region: f.region.trim(), al: jtNames(f.al),
      f: jtSplit(f.f, /\n/).map(l => { const m = l.match(/^(.*?)\s*[｜|]\s*(.*)$/); return m ? [m[1].trim(), m[2].trim()] : ["", l.trim()]; }),
      memo: f.memo.trim() };
    if (f.t !== "E"){ data.c = []; data.r = []; data.p = []; }
    if (f.t === "C"){ data.yt = ""; data.cs = []; data.ch = []; } else { data.region = ""; data.al = []; data.f = []; }
    if (!f.isNew && old && name !== old) putCard({ id: "jt|" + old, deleted: true });
    putCard({ id: "jt|" + name, kind: "jt", data }); commit();
    S.sheet.pop(); if (f.isNew){ S.jt.type = f.t; pushSheet({ t: "jt", n: name }); } else { if (topSheet() && topSheet().t === "jt") topSheet().n = name; renderSheet(); }
    toast("保存しました"); afterEdit();
  },
  jtReset(){
    if (!S.confirmDel){ S.confirmDel = true; renderSheet(); return; }
    const top = topSheet(), base = top.f.base; putCard({ id: "jt|" + top.n, deleted: true }); commit();
    S.sheet.pop(); if (!base) closeSheet(); else renderSheet();
    toast(base ? "もとに戻しました" : "削除しました"); afterEdit();
  },
  evEdit(el){ const e = card(el.dataset.id); if (isEv(e)) pushSheet({ t: "evEdit", id: e.id, f: evForm(e) }); },
  edit(el){
    const c = card(el.dataset.id); if (!c) return;
    if (isEv(c)){ pushSheet({ t: "evEdit", id: c.id, f: evForm(c) }); return; }
    pushSheet({ t: "card", id: c.id, f: { front: c.front || "", back: c.back || "", memo: c.memo || "", deck: deckOf(c), tags: tagsOf(c).join(", ") } });
  },
  back(){ popSheet(); },
  closeEdit(){ closeSheet(); },
  saveEdit(){
    const top = topSheet(), e = top.f;
    if (!e.front.trim() || !e.back.trim()){ toast("問題と答えは空にできません"); return; }
    updateCard(top.id, { front: e.front.trim(), back: e.back.trim(), memo: e.memo.trim(), deck: e.deck.trim() || DEFAULT_DECK, tags: parseTags(e.tags) });
    commit(); popSheet(); toast("保存しました"); afterEdit();
  },
  saveEv(){
    const top = topSheet(), f = top.f, old = card(top.id); if (!old) return;
    const y = parseYearText(f.year);
    if (!f.title.trim()){ toast("出来事名を書いてね"); return; }
    if (!y){ toast("年の書き方を確認してね"); return; }
    const rel = resolveRelated(f.related, top.id);
    const patch = evFields({ title: f.title.trim(), year: y.year, yearEnd: y.yearEnd, approx: y.approx, region: f.region.trim(), desc: f.desc.trim(),
      tags: parseTags(f.tags), related: rel.ids, relNames: rel.miss, srs: f.srs });
    if (old.srs === false && f.srs) patch.due = Date.now();
    updateCard(top.id, patch); commit(); popSheet(); toast("保存しました"); afterEdit();
  },
  dueNow(){ updateCard(topSheet().id, { srs: true, due: Date.now() }); commit(); popSheet(); toast("今日の復習に入れました"); afterEdit(); },
  srsToggle(el){
    const e = card(el.dataset.id); if (!e) return;
    updateCard(e.id, e.srs === false ? { srs: true, due: Date.now() } : { srs: false }); commit();
    toast(e.srs === false ? "毎日の復習に入れました" : "毎日の復習から外しました"); renderSheet(); afterEdit();
  },
  del(){
    if (!S.confirmDel){ S.confirmDel = true; renderSheet(); return; }
    deleteCard(topSheet().id); commit(); popSheet(); toast("削除しました"); afterEdit();
  },
  setRegion(el){
    const p = el.dataset.p, obj = p === "edit" ? S.edit : S[p]; if (!obj) return;
    obj.region = obj.region === el.dataset.d ? "" : el.dataset.d;
    document.querySelectorAll(`[data-act="setRegion"][data-p="${p}"]`).forEach(b => b.classList.toggle("on", b.dataset.d === obj.region));
    const inp = document.getElementById(p + "-region"); if (inp) inp.value = obj.region;
  },

  /* 追加 */
  aMode(el){ S.add.mode = el.dataset.m; S.add.confirmStarterDel = false; renderMain(); },
  bKind(el){ S.add.bulkKind = el.dataset.v; renderMain(); },
  goAddEvent(){ S.view = "add"; S.add.mode = "event"; renderMain(); window.scrollTo(0, 0); },
  addOne(){
    const a = S.add;
    if (!a.front.trim() || !a.back.trim()){ toast("問題と答えを書いてね"); return; }
    createCard({ front: a.front.trim(), back: a.back.trim(), memo: a.memo.trim(), deck: a.deck.trim() || DEFAULT_DECK, tags: parseTags(a.tags) });
    commit(); a.front = ""; a.back = ""; a.memo = ""; toast("追加しました"); renderMain();
  },
  addEvent(){
    const f = S.aev, y = parseYearText(f.year), title = f.title.trim();
    if (!title){ toast("出来事名を書いてね"); return; }
    if (!y){ toast("年の書き方を確認してね"); return; }
    if (evs().some(e => e.title === title && e.year === y.year)){ toast("同じ出来事がもう登録されています"); return; }
    const rel = resolveRelated(f.related, null);
    createEvent({ title, year: y.year, yearEnd: y.yearEnd, approx: y.approx, region: f.region.trim(), desc: f.desc.trim(),
      tags: parseTags(f.tags), related: rel.ids, relNames: rel.miss, srs: f.srs });
    commit();
    Object.assign(f, { title: "", year: "", desc: "", related: "" });   // 地域・タグは続けて使えるように残す
    toast(rel.miss.length ? "追加しました（関連の一部はまだ未登録）" : "追加しました"); renderMain();
  },
  addBulk(){
    const a = S.add;
    if (a.bulkKind === "card" || a.mode !== "bulk"){
      const p = parseBulk(a.bulk);
      if (!p.ok.length){ toast("読み取れる問題がありません"); return; }
      const deck = a.deck.trim() || DEFAULT_DECK, tags = parseTags(a.tags);
      p.ok.forEach(x => createCard({ front: x.front, back: x.back, deck, tags }));
      commit(); a.bulk = ""; toast(p.ok.length + "問を追加しました"); renderMain();
      return;
    }
    const p = parseBulkEvents(a.bulk, a.bulkRegion.trim());
    if (!p.ok.length){ toast("読み取れる出来事がありません"); return; }
    const added = []; let dup = 0;
    p.ok.forEach(x => {
      if (evs().some(e => e.title === x.title && e.year === x.year)){ dup++; return; }
      const id = newId(); createEvent(Object.assign({}, x, { srs: a.bsrs }), id); added.push({ id, relText: x.relText });
    });
    added.forEach(({ id, relText }) => { if (!relText) return; const rel = resolveRelated(relText, id); updateCard(id, { related: rel.ids, relNames: rel.miss }); });
    commit(); a.bulk = "";
    toast(`${added.length}件を追加しました` + (dup ? `（重複${dup}件はとばしました）` : "")); renderMain();
  },
  async copyPrompt(el){
    try{ await navigator.clipboard.writeText(el.dataset.k === "event" ? PROMPT_EVENT : PROMPT_CARD); toast("コピーしました。Claude に貼ってね"); }
    catch(e){ toast("コピーできませんでした。上の文を長押しでコピーしてね"); }
  },
  /* 章別 */
  chSel(el){ S.note.chap = +el.dataset.d; S.note.chDel = null; lsSet(LS.chap, S.note.chap); renderNoteBody(); chChipIntoView(); },
  chStep(el){
    const list = chList(), i = list.findIndex(c => c.no === S.note.chap) + +el.dataset.v;
    if (i < 0 || i >= list.length) return;
    S.note.chap = list[i].no; S.note.chDel = null; lsSet(LS.chap, S.note.chap); renderNoteBody();
    if (el.dataset.top) window.scrollTo(0, 0);
    chChipIntoView();
  },
  chOpen(el){
    S.note.q = ""; S.note.mode = "chap"; S.note.chap = +el.dataset.d; S.note.chDel = null; lsSet(LS.chap, S.note.chap);
    S.view = "note"; renderMain(); window.scrollTo(0, 0); chChipIntoView();
  },
  goChap(){ S.note.q = ""; S.note.mode = "chap"; S.note.chDel = null; S.view = "note"; renderMain(); window.scrollTo(0, 0); chChipIntoView(); },
  chAdd(el){
    const ch = chOf(S.note.chap); if (!ch) return;
    const srs = el.dataset.v === "1", t = Date.now(), tag = chTag(ch); let n = 0;
    ch.qa.forEach(([q, a], i) => {
      const id = chId(ch, q); if (card(id)) return;
      putCard({ id, deck: DEFAULT_DECK, tags: [tag], front: q, back: a, memo: "", created: t + i, due: t,
                interval: 0, ease: 2.5, reps: 0, lapses: 0, srs });
      n++;
    });
    S.note.chDel = null; commit();
    toast(`${n}問を追加しました` + (srs ? "（今日の復習に入りました）" : "（練習で使えます）")); renderNoteBody();
  },
  chSrs(el){
    const ch = chOf(S.note.chap); if (!ch) return;
    const on = el.dataset.v === "1", list = chCards(ch);
    list.forEach(c => updateCard(c.id, { srs: on }));
    commit(); toast(on ? `${list.length}問を毎日の復習に入れました` : `${list.length}問を毎日の復習から外しました`); renderNoteBody();
  },
  chDel(){
    const ch = chOf(S.note.chap); if (!ch) return;
    if (S.note.chDel !== ch.no){ S.note.chDel = ch.no; renderNoteBody(); return; }
    let n = 0; chCards(ch).forEach(c => { deleteCard(c.id); n++; });
    S.note.chDel = null; commit(); toast(n + "問を削除しました"); renderNoteBody();
  },
  /* 問題 */
  qSet(el){ const k = el.dataset.k, v = el.dataset.v; S.qset[k] = k === "count" ? +v : v; saveQset(); renderMain(); },
  qStart(){
    const p = S.qset; let pool = quizPool(); if (!pool.length) return;
    if (p.order === "fresh"){
      const a = shuffle(pool.filter(c => !c.qn)), b = shuffle(pool.filter(c => c.qn)).sort((x, y) => (x.qlast || 0) - (y.qlast || 0));
      pool = [...a, ...b];
    } else pool = shuffle(pool);
    if (p.count) pool = pool.slice(0, p.count);
    S.quiz = { queue: pool.map(c => c.id), idx: 0, shown: false, judged: null, res: {}, round: 1, set: Object.assign({}, p) };
    S.view = "quiz"; renderMain(); window.scrollTo(0, 0);
  },
  qShow(){ S.quiz.shown = true; renderMain(); },
  qJudge(el){
    const Q = S.quiz, id = Q.queue[Q.idx], c = card(id); if (!c) return;
    const ok = el.dataset.ok === "1"; Q.judged = ok; Q.res[id] = ok;
    updateCard(id, { qn: (c.qn || 0) + 1, qok: (c.qok || 0) + (ok ? 1 : 0), qng: (c.qng || 0) + (ok ? 0 : 1), qlast: Date.now() });
    commit(30000); renderMain();
  },
  qNext(el){
    const Q = S.quiz, id = Q.queue[Q.idx], c = card(id), d = el.dataset.do, t = Date.now();
    if (c && d){
      if (d === "send") updateCard(id, { srs: true, due: t });
      else if (d === "today") updateCard(id, { due: t });
      else if (d === "out") updateCard(id, { srs: false });
      commit(30000);
      toast(d === "send" ? "毎日の復習に送りました" : d === "today" ? "今日の復習に回しました" : "毎日の復習から外しました");
    }
    Q.idx++; Q.shown = false; Q.judged = null; renderMain(); window.scrollTo(0, 0);
  },
  qSendWrong(){
    const Q = S.quiz, t = Date.now(); let n = 0;
    Q.queue.filter(id => Q.res[id] === false).forEach(id => { const c = card(id); if (c && c.srs === false){ updateCard(id, { srs: true, due: t }); n++; } });
    commit(); toast(`${n}問を毎日の復習に送りました`); renderMain();
  },
  qRetry(){
    const Q = S.quiz, wrong = shuffle(Q.queue.filter(id => Q.res[id] === false && card(id)));
    if (!wrong.length) return;
    S.quiz = { queue: wrong, idx: 0, shown: false, judged: null, res: {}, round: Q.round + 1, set: Q.set };
    renderMain(); window.scrollTo(0, 0);
  },
  qQuit(){ S.quiz = null; S.view = "home"; renderMain(); window.scrollTo(0, 0); },
  chQuiz(){
    const ch = chOf(S.note.chap); if (!ch) return;
    S.qset.chap = String(ch.no); S.qset.region = ""; S.qset.era = ""; if (S.qset.order === "wrong") S.qset.order = "random"; saveQset();
    S.quiz = null; S.session = null; S.view = "home"; renderMain(); window.scrollTo(0, 0);
  },
  chPractice(){
    const ch = chOf(S.note.chap); if (!ch) return;
    S.pset.deck = "すべて"; S.pset.tag = chTag(ch); S.practice = null; S.session = null;
    S.view = "practice"; renderMain(); window.scrollTo(0, 0);
  },
  starterAdd(){
    let n = 0;
    starterList().forEach(x => {
      const id = starterId(x); if (card(id)) return;
      createEvent(Object.assign({}, x, { tags: [STARTER_TAG, ...x.tags], srs: false }), id); n++;
    });
    commit(); toast(n + "件を追加しました"); renderMain();
  },
  starterDel(){
    if (!S.add.confirmStarterDel){ S.add.confirmStarterDel = true; renderMain(); return; }
    let n = 0; starterList().forEach(x => { const id = starterId(x); if (card(id)){ deleteCard(id); n++; } });
    S.add.confirmStarterDel = false; commit(); toast(n + "件を削除しました"); renderMain();
  },

  /* 一覧・設定 */
  lDeck(el){ S.listDeck = el.dataset.d; renderMain(); },
  lKind(el){ S.listKind = el.dataset.v; renderMain(); },
  goSrsList(){ S.listKind = "srs"; S.listDeck = "すべて"; S.q = ""; S.view = "list"; renderMain(); window.scrollTo(0, 0); },
  syncNow(){ sync(true); },
  async saveSettings(){
    const f = S.form;
    const s = { owner: f.owner.trim(), repo: f.repo.trim() || "sekaishi-data", path: f.path.trim().replace(/^\/+/, "") || "cards.json" };
    if (!s.owner){ S.testMsg = { cls: "err", html: "ユーザー名を入れてね" }; renderMain(); return; }
    const newTok = f.token.trim();
    if (newTok && !/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(newTok)){ S.testMsg = { cls: "err", html: "トークンの形が違うみたい。<code>github_pat_</code> で始まる文字列を全部貼り付けてね" }; renderMain(); return; }
    lsSet(LS.settings, s);
    if (newTok) setToken(newTok);
    f.token = "";
    if (!token()){ S.testMsg = { cls: "warn", html: "設定を保存しました。トークンを入れると同期が始まるよ" }; renderMain(); return; }
    S.testMsg = { cls: "", html: "確認中…" }; renderMain();
    try{
      const r = await gh(repoUrl(s));
      if (!r.ok) throw new HttpError(r.status);
      const repo = await r.json();
      if (!repo.private){
        S.testMsg = { cls: "err", html: `<b>${esc(s.repo)} は公開リポジトリです！</b> このままだと記録が誰でも見られるので、同期はしません。リポジトリを Private にするか、別の非公開リポジトリ名を入れてね。` };
        renderMain(); return;
      }
      S.testMsg = { cls: "", html: "つながりました。同期します…" }; renderMain();
      await sync(true);
      S.testMsg = S.sync.state === "ok" ? { cls: "", html: `✓ 非公開リポジトリ <b>${esc(s.repo)}</b> に保存できています` } : { cls: "err", html: esc(S.sync.msg || "同期できませんでした") };
    } catch(e){
      S.testMsg = { cls: "err", html: esc(e instanceof TypeError ? "通信できませんでした。ネットにつながっているか確認してね" : e.message) };
    }
    S.form = null; renderMain();
  },
  clearToken(){ setToken(""); S.sync = { state: "unset", msg: "" }; S.testMsg = { cls: "", html: "トークンを消しました" }; renderMain(); },
  exportFile(){
    try{
      const blob = new Blob([backupText()], { type: "application/json" });
      const a = document.createElement("a"); const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = `sekaishi-backup-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch(e){ toast("書き出せませんでした。「コピー」を使ってね"); }
  },
  async exportCopy(){
    try{ await navigator.clipboard.writeText(backupText()); toast("コピーしました"); }
    catch(e){ toast("コピーできませんでした"); }
  },
  importFile(){ $("#import-file").click(); }
};

document.addEventListener("click", e => {
  if (e.target.id === "sheet"){ closeSheet(); return; }
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const f = act[el.dataset.act]; if (f) f(el, e);
});
function onField(e){
  const t = e.target;
  if (t.dataset.bind){
    setPath(t.dataset.bind, t.type === "checkbox" ? t.checked : t.value);
    const [p, k] = t.dataset.bind.split(".");
    if (k === "year"){ const info = document.getElementById(p + "-yinfo"); if (info) info.innerHTML = yearInfo(t.value); }
    if (k === "region" && (p === "aev" || p === "edit")) document.querySelectorAll(`[data-act="setRegion"][data-p="${p}"]`).forEach(b => b.classList.toggle("on", b.dataset.d === t.value.trim()));
    if (t.dataset.bind === "add.bulk" || t.dataset.bind === "add.bulkRegion"){
      const a = S.add, info = $("#bulk-info"), btn = $("#bulk-btn");
      if (a.bulkKind === "card"){ const p2 = parseBulk(a.bulk); if (info) info.textContent = bulkInfo(p2); if (btn) btn.textContent = p2.ok.length + "問を追加"; }
      else { const p2 = parseBulkEvents(a.bulk, a.bulkRegion.trim()); if (info) info.textContent = bulkEvInfo(p2); if (btn) btn.textContent = p2.ok.length + "件を追加"; }
    }
  }
  if (t.id === "q"){ S.q = t.value; renderListItems(); }
  if (t.id === "nq"){ S.note.q = t.value; renderNoteBody(); }
  if (t.id === "jq"){ S.jt.q = t.value; renderJtBody(); }
  if (t.id === "yin" && S.yd && S.yd.cur) S.yd.cur.input = t.value;
}
document.addEventListener("input", onField);
document.addEventListener("change", e => {
  const t = e.target;
  if (t.type === "checkbox") onField(e);
  if (t.dataset.ysel){ S.yset[t.dataset.ysel] = t.value; renderMain(); }
  if (t.dataset.qsel){ S.qset[t.dataset.qsel] = t.value; saveQset(); renderMain(); }
});
document.addEventListener("keydown", e => {
  if (e.target.id === "yin" && e.key === "Enter" && !e.isComposing){ e.preventDefault(); act.yInCheck(); }
});
$("#import-file").addEventListener("change", e => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  file.text().then(importBackup).catch(() => toast("ファイルを読めませんでした"));
  e.target.value = "";
});
window.addEventListener("online", () => { renderPill(); sync(); });
window.addEventListener("offline", renderPill);
let lastVis = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastVis > 30000){ lastVis = Date.now(); sync(); }
});

/* ---------- 起動 ---------- */
ensureChapterCards();
renderMain();
sync();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
