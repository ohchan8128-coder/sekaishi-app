"use strict";
/*
 * 世界史 復習アプリ
 * - 問題データは端末(localStorage)に保存し、GitHubの非公開リポジトリと同期する
 * - トークンはこの端末の localStorage にだけ保存する（コードには書かない）
 */
const DAY = 86400000;
const DEFAULT_DECK = "世界史";
const LS = { cards: "sk.cards", token: "sk.token", settings: "sk.settings", dirty: "sk.dirty", last: "sk.lastSync" };

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
  add: { mode: "one", deck: DEFAULT_DECK, tags: "", front: "", back: "", memo: "", bulk: "" },
  q: "", listDeck: "すべて", edit: null, confirmDel: false,
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
function live(){ return S.cards.filter(c => !c.deleted); }
function card(id){ return S.cards.find(c => c.id === id && !c.deleted); }
function tagsOf(c){ return Array.isArray(c.tags) ? c.tags : []; }
function parseTags(s){ return String(s || "").split(/[,、，\s]+/).map(t => t.trim()).filter(Boolean).slice(0, 8); }
function deckOf(c){ return c.deck || DEFAULT_DECK; }
function decks(){ const s = new Set([DEFAULT_DECK]); live().forEach(c => s.add(deckOf(c))); return [...s]; }
function inDeck(c, d){ return d === "すべて" || deckOf(c) === d; }
function shuffle(a){ a = a.slice(); for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function fmtDate(t){ if (!t) return "—"; const d = new Date(t); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`; }
function toast(m){ const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900); }
function dueList(d){
  const end = endOfToday();
  return live().filter(c => inDeck(c, d) && (c.due || 0) <= end)
    .sort((a, b) => ((a.reps ? 0 : 1) - (b.reps ? 0 : 1)) || ((a.due || 0) - (b.due || 0)));
}
function fmtIv(days){ if (days <= 0) return "10分"; if (days < 30) return days + "日"; if (days < 365) return Math.round(days / 30) + "か月"; return "1年"; }
function dueLabel(c){
  if (!c.reps) return "新規";
  const diff = Math.round((startOfDay(c.due || 0) - startOfDay(Date.now())) / DAY);
  return diff <= 0 ? "今日復習" : diff === 1 ? "明日" : diff + "日後";
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
function commit(){
  S.localVer++;
  if (!lsSet(LS.cards, S.cards)) toast("端末に保存できませんでした（容量不足？）");
  lsSet(LS.dirty, true);
  renderPill(); scheduleSync();
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
  if (S.view === "home") renderMain();
  else if (S.view === "list") renderListItems();
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

/* ---------- 画面 ---------- */
function chips(cur, act, list){
  return `<div class="chips">${list.map(d => `<button class="chip ${d === cur ? "on" : ""}" data-act="${act}" data-d="${esc(d)}">${esc(d || "すべて")}</button>`).join("")}</div>`;
}
function homeHTML(){
  const due = dueList(S.deck), newN = due.filter(c => !c.reps).length;
  const pool = live().filter(c => inDeck(c, S.deck)); const t0 = startOfDay(Date.now());
  const within = n => pool.filter(c => c.reps && (c.due || 0) > endOfToday() && (c.due || 0) < t0 + (n + 1) * DAY).length;
  let h = chips(S.deck, "deck", ["すべて", ...decks()]);
  if (!token()) h += `<div class="note">記録を GitHub に保存するには、まず<b>設定</b>でトークンを入れてね。今のままでもこの端末の中には保存されるよ。</div>`;
  h += `<div class="card hero"><div class="big">${due.length}</div><div class="lbl">今日の問題</div>
    <div class="sub">復習 ${due.length - newN}・新しい問題 ${newN}</div>
    <button class="btn" data-act="start" ${due.length ? "" : "disabled"}>${due.length ? "始める" : "今日の分は終わり！"}</button></div>`;
  h += `<div class="card"><h2>この先の予定</h2><div class="stats">
    <div><b>${within(1)}</b><span>明日</span></div><div><b>${within(7)}</b><span>7日以内</span></div><div><b>${pool.length}</b><span>登録した問題</span></div></div></div>`;
  if (!live().length){
    h += `<div class="card"><h2>使い方</h2><ol class="guide">
      <li>「追加」で一問一答を書く。Claude に作ってもらった問題は「まとめて取り込む」に貼り付ける</li>
      <li>毎日「復習」を開くと、忘れかけた問題だけが出てくる</li>
      <li>答えを見たら「もう一度／難しい／正解／簡単」で自己採点。覚えている問題ほど間隔が伸びる</li>
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
  h += `<div class="links"><button class="link" data-act="edit" data-id="${esc(c.id)}">この問題を直す</button><button class="link" data-act="quit">中断する</button></div>`;
  return h;
}
function qHTML(c, shown){
  const meta = [deckOf(c), ...tagsOf(c)].map(esc).join(" ・ ");
  let h = `<div class="card q"><div class="meta">${meta}${c.reps ? "" : " ・ 新しい問題"}</div><div class="front">${nl(c.front)}</div>`;
  if (shown){ h += `<div class="back">${nl(c.back)}</div>`; if (c.memo) h += `<details><summary>メモを見る</summary><div>${esc(c.memo)}</div></details>`; }
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
function addHTML(){
  const a = S.add;
  let h = `<div class="card"><div class="seg">
      <button class="${a.mode === "one" ? "on" : ""}" data-act="aMode" data-m="one">1問ずつ書く</button>
      <button class="${a.mode === "bulk" ? "on" : ""}" data-act="aMode" data-m="bulk">まとめて取り込む</button></div>
    <div class="row2"><div><label class="f">科目</label><input type="text" list="decklist" data-bind="add.deck" value="${esc(a.deck)}">
      <datalist id="decklist">${decks().map(d => `<option value="${esc(d)}">`).join("")}</datalist></div>
      <div><label class="f">タグ（任意）</label><input type="text" data-bind="add.tags" value="${esc(a.tags)}" placeholder="中世ヨーロッパ"></div></div>`;
  if (a.mode === "one"){
    h += `<label class="f">問題</label><textarea data-bind="add.front" placeholder="1077年、ハインリヒ4世が教皇に謝罪した出来事は？">${esc(a.front)}</textarea>
      <label class="f">答え</label><textarea data-bind="add.back" placeholder="カノッサの屈辱">${esc(a.back)}</textarea>
      <label class="f">メモ（任意・復習のとき見られる）</label><textarea data-bind="add.memo">${esc(a.memo)}</textarea>
      <div style="height:12px"></div><button class="btn" data-act="addOne">追加する</button></div>`;
  } else {
    const parsed = parseBulk(a.bulk);
    h += `<label class="f">1行に1問、「問題 ｜ 答え」の形で貼り付け</label>
      <textarea class="tall" data-bind="add.bulk" placeholder="1077年、ハインリヒ4世が教皇に謝罪した出来事は？ ｜ カノッサの屈辱">${esc(a.bulk)}</textarea>
      <p class="muted small" id="bulk-info">${bulkInfo(parsed)}</p>
      <button class="btn" data-act="addBulk" id="bulk-btn">${parsed.ok.length}問を追加</button></div>`;
  }
  return h;
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
  if (!p.ok.length && !p.bad.length) return "Claude に「この範囲の一問一答を『問題 ｜ 答え』の形で作って」と頼んで、出てきたものをそのまま貼ってね。";
  return `読み取れた問題：${p.ok.length}問` + (p.bad.length ? `　／　読み取れなかった行：${p.bad.length}行（「｜」が入っているか確認してね）` : "");
}
function listHTML(){
  return `<input type="search" id="q" placeholder="検索（問題・答え・メモ・タグ）" value="${esc(S.q)}"><div style="height:10px"></div>
    ${chips(S.listDeck, "lDeck", ["すべて", ...decks()])}<div class="card" style="padding:4px 14px" id="list-items"></div>`;
}
function renderListItems(){
  const el = $("#list-items"); if (!el) return;
  const q = S.q.trim().toLowerCase();
  const items = live().filter(c => inDeck(c, S.listDeck))
    .filter(c => !q || [c.front, c.back, c.memo, ...tagsOf(c)].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  if (!items.length){ el.innerHTML = `<p class="muted">${live().length ? "見つかりませんでした。" : "まだ問題がありません。"}</p>`; return; }
  const shown = items.slice(0, 300);
  el.innerHTML = shown.map(c => `<button class="item" data-act="edit" data-id="${esc(c.id)}"><div class="iq">${esc(c.front)}</div><div class="ia">${esc(c.back)}</div>
      <div class="im">${esc(deckOf(c))}${tagsOf(c).length ? " ・ " + tagsOf(c).map(esc).join(" ") : ""} ・ ${dueLabel(c)}</div></button>`).join("")
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
  h += `<div class="card"><h2>バックアップ</h2><p class="muted small" style="margin-top:-4px">全部の問題と復習記録を JSON ファイルにして保存できるよ。</p>
    <div class="btns"><button class="btn sec" data-act="exportFile">書き出す</button><button class="btn line" data-act="exportCopy">コピー</button></div>
    <div style="height:8px"></div><button class="btn line" data-act="importFile">バックアップを読み込む</button></div>`;
  h += `<p class="muted small" style="text-align:center">登録 ${live().length}問</p>`;
  return h;
}
function sheetHTML(){
  const e = S.edit;
  return `<h2>問題を直す</h2>
    <label class="f">問題</label><textarea data-bind="edit.front">${esc(e.front)}</textarea>
    <label class="f">答え</label><textarea data-bind="edit.back">${esc(e.back)}</textarea>
    <label class="f">メモ</label><textarea data-bind="edit.memo">${esc(e.memo)}</textarea>
    <div class="row2"><div><label class="f">科目</label><input type="text" data-bind="edit.deck" value="${esc(e.deck)}"></div>
    <div><label class="f">タグ</label><input type="text" data-bind="edit.tags" value="${esc(e.tags)}"></div></div>
    <div class="btns"><button class="btn line" data-act="closeEdit">閉じる</button><button class="btn" data-act="saveEdit">保存</button></div>
    <div class="btns"><button class="btn sec" data-act="dueNow">今日の復習に入れる</button></div>
    <div class="btns"><button class="btn danger ${S.confirmDel ? "sure" : ""}" data-act="del">${S.confirmDel ? "本当に削除する" : "この問題を削除"}</button></div>`;
}
function renderSheet(){
  const sh = $("#sheet");
  if (!S.edit){ sh.classList.remove("open"); return; }
  $("#sheet-inner").innerHTML = sheetHTML(); sh.classList.add("open");
}
function renderMain(){
  const m = $("#main"), v = S.view;
  m.innerHTML = v === "home" ? homeHTML() : v === "review" ? reviewHTML() : v === "practice" ? practiceHTML()
    : v === "add" ? addHTML() : v === "list" ? listHTML() : settingsHTML();
  if (v === "list") renderListItems();
  $("#ttl").textContent = { home: "世界史", review: "復習", practice: "練習", add: "追加", list: "一覧", settings: "設定" }[v] || "世界史";
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.v === (v === "review" ? "home" : v)));
  renderPill();
}

/* ---------- バックアップ ---------- */
function backupText(){ return JSON.stringify({ app: "sekaishi", version: 1, exported: Date.now(), cards: S.cards }, null, 1); }
function importBackup(text){
  let data; try { data = JSON.parse(text); } catch(e){ toast("JSON を読み取れませんでした"); return; }
  const cards = Array.isArray(data) ? data : data && Array.isArray(data.cards) ? data.cards : null;
  if (!cards){ toast("問題データが見つかりませんでした"); return; }
  const valid = cards.filter(c => c && typeof c.id === "string" && (c.deleted || (typeof c.front === "string" && typeof c.back === "string")));
  const before = live().length;
  S.cards = merge(S.cards, valid); commit();
  toast(`読み込みました（${live().length - before}問増えました）`); renderMain();
}

/* ---------- 操作 ---------- */
function setPath(p, v){ const [a, b] = p.split("."); if (S[a]) S[a][b] = v; }
const act = {
  nav(el){
    const v = el.dataset.v;
    if (v !== "review") S.session = null;
    if (v !== "settings"){ S.form = null; S.testMsg = null; }
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
  aMode(el){ S.add.mode = el.dataset.m; renderMain(); },
  addOne(){
    const a = S.add;
    if (!a.front.trim() || !a.back.trim()){ toast("問題と答えを書いてね"); return; }
    createCard({ front: a.front.trim(), back: a.back.trim(), memo: a.memo.trim(), deck: a.deck.trim() || DEFAULT_DECK, tags: parseTags(a.tags) });
    commit(); a.front = ""; a.back = ""; a.memo = ""; toast("追加しました"); renderMain();
  },
  addBulk(){
    const a = S.add, p = parseBulk(a.bulk);
    if (!p.ok.length){ toast("読み取れる問題がありません"); return; }
    const deck = a.deck.trim() || DEFAULT_DECK, tags = parseTags(a.tags);
    p.ok.forEach(x => createCard({ front: x.front, back: x.back, deck, tags }));
    commit(); a.bulk = ""; toast(p.ok.length + "問を追加しました"); renderMain();
  },
  lDeck(el){ S.listDeck = el.dataset.d; renderMain(); },
  edit(el){
    const c = card(el.dataset.id); if (!c) return;
    S.edit = { id: c.id, front: c.front || "", back: c.back || "", memo: c.memo || "", deck: deckOf(c), tags: tagsOf(c).join(", ") };
    S.confirmDel = false; renderSheet();
  },
  closeEdit(){ S.edit = null; renderSheet(); },
  saveEdit(){
    const e = S.edit;
    if (!e.front.trim() || !e.back.trim()){ toast("問題と答えは空にできません"); return; }
    updateCard(e.id, { front: e.front.trim(), back: e.back.trim(), memo: e.memo.trim(), deck: e.deck.trim() || DEFAULT_DECK, tags: parseTags(e.tags) });
    commit(); S.edit = null; renderSheet(); toast("保存しました"); afterEdit();
  },
  dueNow(){ updateCard(S.edit.id, { due: Date.now() }); commit(); S.edit = null; renderSheet(); toast("今日の復習に入れました"); afterEdit(); },
  del(){
    if (!S.confirmDel){ S.confirmDel = true; renderSheet(); return; }
    deleteCard(S.edit.id); commit(); S.edit = null; renderSheet(); toast("削除しました"); afterEdit();
  },
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
function afterEdit(){ if (S.view === "list") renderListItems(); else if (S.view === "review" || S.view === "practice" || S.view === "home") renderMain(); }

document.addEventListener("click", e => {
  if (e.target.id === "sheet"){ act.closeEdit(); return; }
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const f = act[el.dataset.act]; if (f) f(el, e);
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.dataset.bind) setPath(t.dataset.bind, t.value);
  if (t.dataset.bind === "add.bulk"){
    const p = parseBulk(t.value); const info = $("#bulk-info"), btn = $("#bulk-btn");
    if (info) info.textContent = bulkInfo(p); if (btn) btn.textContent = p.ok.length + "問を追加";
  }
  if (t.id === "q"){ S.q = t.value; renderListItems(); }
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
renderMain();
sync();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
