#!/usr/bin/env node
// 自主观看 / 任务卡驱动：按课程、截止日期、卡片类型精确定位任务，批量完成“点我完成任务”。
//
//   node scripts/watch.mjs list [--course 课程] [--kind watch|homework|discuss] [--due 2026-11-25]
//   node scripts/watch.mjs open "<标题>" [--course 课程] [--kind ...] [--due ...]
//   node scripts/watch.mjs run  [--course 课程] [--due 2026-11-25] [--batch 4] [--limit 50]
//                               [--ppt 130] [--rate 16] [--deadline 180]
//   node scripts/watch.mjs status ["<标题>"]
//
// 硬规则：
//   1. 只用元素级 click（React fiber 的 memoizedProps.onClick），不用坐标点击、不动系统鼠标；
//   2. 每个标签页各自计时，到点只点它自己的“点我完成任务”；
//   3. 至少保留一个课程首页标签页，最后一个标签页被关掉浏览器会直接退出；
//   4. 结束后必须看到“任务已完成”，否则计为失败，下次 run 会重新拾起。
import { connect, listTargets, sleep } from './lib/cdp.mjs';

const PORT = Number(process.env.CDP_PORT || 9222);
const HOME_URL = 'https://whut.ai-augmented.com/app/jx-web/mycourse';
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';

function flag(name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const num = (name, fallback) => {
  const v = flag(name);
  return v == null ? fallback : Number(v);
};
const positional = argv.slice(1).filter((a, i, arr) =>
  !a.startsWith('--') && !(arr[i - 1] || '').startsWith('--'));

const COURSE = flag('course');
const DUE = flag('due');
const KIND = flag('kind', cmd === 'run' ? 'watch' : 'any');
const BATCH = num('batch', 4);
const LIMIT = num('limit', 100);
const PPT_MS = num('ppt', 130) * 1000;
const RATE = num('rate', 16);
const VIDEO_DEADLINE = num('deadline', 180) * 1000;

const HELPERS = String.raw`
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getFiber = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  };
  const fakeEvt = { preventDefault() {}, stopPropagation() {}, nativeEvent: {}, target: null, currentTarget: null, type: 'click', button: 0 };
  const clickEl = (el) => {
    const f = getFiber(el);
    const p = f && f.memoizedProps;
    if (p && typeof p.onClick === 'function') { p.onClick(fakeEvt); return 'react'; }
    el.click();
    return 'dom';
  };
  const ensureDrawer = async () => {
    if (document.querySelectorAll('.task_card .ant-col').length) return 'open';
    const sq = [...document.querySelectorAll('.square')].find((x) => txt(x.innerText).includes('待完成任务'));
    if (!sq) return 'missing';
    clickEl(sq);
    await sleep(1500);
    return 'opened';
  };
  const showAll = async () => {
    const cb = [...document.querySelectorAll('label.ant-checkbox-wrapper')]
      .find((x) => txt(x.innerText).includes('仅显示可完成任务'));
    if (cb && cb.className.includes('checked')) { clickEl(cb); await sleep(700); }
    const all = [...document.querySelectorAll('label.ant-radio-wrapper')]
      .find((x) => txt(x.innerText) === '显示全部任务');
    if (all && !all.className.includes('checked')) { clickEl(all); await sleep(1200); }
  };
  const kindOf = (c) => c.classList.contains('ta_homework') ? 'homework'
    : c.classList.contains('ta_watch') ? 'watch'
    : c.classList.contains('ta_discuss') ? 'discuss' : 'other';
  const cardOf = (c) => ({
    kind: kindOf(c),
    title: txt(c.querySelector('a.group-resource-link') && c.querySelector('a.group-resource-link').innerText),
    course: txt(c.querySelector('a.group_link.inline') && c.querySelector('a.group_link.inline').innerText),
    due: txt(c.querySelector('.xy_taskCard_bottom span') && c.querySelector('.xy_taskCard_bottom span').innerText),
    tags: [...c.querySelectorAll('.ta_taskType .ant-tag')].map((t) => txt(t.innerText)).join(','),
  });
`;

const LIST_JS = `(async () => {
  ${HELPERS}
  await ensureDrawer();
  await showAll();
  return JSON.stringify([...document.querySelectorAll('.task_card .ant-col')].map(cardOf));
})()`;

const statusJS = `(() => {
  const t = document.body.innerText.replace(/\\s+/g, ' ');
  const v = document.querySelector('video');
  return JSON.stringify({
    done: t.includes('任务已完成') || [...document.querySelectorAll('.ta_icon_btn')].some((e) => e.innerText.includes('已完成')),
    pct: (t.match(/已观看[:：]\\s*([\\d.]+)%/) || [])[1] || null,
    learned: (t.match(/已学习\\s*\\d+\\s*秒[^。]{0,40}/) || [])[0] || null,
    hint: (t.match(/任务已截止[^。]{0,20}|当前任务已结束[^。]{0,20}|已学习\\s*\\d+\\s*秒[^。]{0,40}/) || [])[0] || null,
    cur: v ? Math.round(v.currentTime) : null,
    dur: v ? Math.round(v.duration) : null,
    paused: v ? v.paused : null,
    rate: v ? v.playbackRate : null,
    hidden: document.hidden,
    visibility: document.visibilityState,
  });
})()`;

const CONFIRM_JS = `(() => {
  const b = [...document.querySelectorAll('button.ant-btn')].find((e) => e.getClientRects().length && e.innerText.trim() === '确定');
  if (!b) return 'no-dialog';
  b.click();
  return 'clicked';
})()`;

const START_JS = `(() => {
  const b = [...document.querySelectorAll('.ta_icon_btn')].find((e) => e.innerText.includes('点我完成任务'));
  if (!b) return [...document.querySelectorAll('.ta_icon_btn')].some((e) => e.innerText.includes('已完成')) ? 'already' : 'no-button';
  const k = Object.keys(b).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
  const f = k ? b[k] : null;
  const p = f && f.memoizedProps;
  if (f && f.memoizedProps && typeof f.memoizedProps.onClick === 'function') f.memoizedProps.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, target: null, currentTarget: null, type: 'click', button: 0 });
  else b.click();
  return 'clicked';
})()`;

const PUMP_JS = (rate) => `(() => {
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  v.muted = true;
  if (v.playbackRate < ${rate}) v.playbackRate = ${rate};
  if (v.paused) { try { v.play(); } catch (e) {} }
  return Math.round(v.currentTime) + '/' + Math.round(v.duration) + '@' + v.playbackRate;
})()`;

const pages = async () => (await listTargets(PORT)).filter((t) => t.type === 'page');

async function homeTarget(create = true) {
  const ps = await pages();
  const hit = ps.find((t) => t.url === HOME_URL || /\/app\/jx-web\/mycourse$/.test(t.url)) ||
    ps.find((t) => t.url.includes('/app/jx-web/mycourse') && !t.url.includes('/resource/') && !t.url.includes('course_paper'));
  if (hit || !create) return hit;
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(HOME_URL)}`, { method: 'PUT' });
  const t = await r.json();
  await sleep(4000);
  return t;
}

async function closeTab(id) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`); } catch {}
}

// Edge 在最后一个标签页关闭时会直接退出浏览器，所以关任何标签前都要先确认“保活页”还在
let keeperId = null;

async function ensureKeeper() {
  const ps = await pages();
  if (keeperId && ps.some((t) => t.id === keeperId)) return true;
  const existing = ps.find((t) => t.url === HOME_URL || /\/app\/jx-web\/mycourse$/.test(t.url));
  if (existing) { keeperId = existing.id; return true; }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(HOME_URL)}`, { method: 'PUT' });
    const t = await r.json();
    await sleep(3500);
    const after = await pages();
    const hit = after.find((p) => p.id === (t && t.id)) ||
      after.find((p) => p.url === HOME_URL || /\/app\/jx-web\/mycourse$/.test(p.url));
    if (!hit) return false;
    keeperId = hit.id;
    return true;
  } catch { return false; }
}

async function safeClose(id) {
  const alive = await ensureKeeper();
  const count = (await pages()).length;
  if (!alive || count <= 1) return; // 宁可不关，也不要关掉浏览器
  if (id === keeperId) return;
  await closeTab(id);
}

async function withHome(fn) {
  const home = await homeTarget();
  if (!home) throw new Error('no home tab and could not create one');
  const api = await connect({ port: PORT, targetId: home.id });
  try { return await fn(api); } finally { await api.close(); }
}

function matchCard(card, title) {
  if (title && card.title !== title) return false;
  if (COURSE && card.course !== COURSE) return false;
  if (DUE && card.due !== DUE) return false;
  if (KIND && KIND !== 'any' && card.kind !== KIND) return false;
  return true;
}

async function openCard(title) {
  return withHome(async (api) => {
    const before = new Map((await pages()).map((t) => [t.id, t.url]));
    const raw = await api.evalJS(`(async () => {
      ${HELPERS}
      await ensureDrawer();
      await showAll();
      const cards = [...document.querySelectorAll('.task_card .ant-col')].map((c) => ({ c, ...cardOf(c) }))
        .filter((x) => (!${JSON.stringify(title)} || x.title === ${JSON.stringify(title)})
          && (!${JSON.stringify(COURSE)} || x.course === ${JSON.stringify(COURSE)})
          && (!${JSON.stringify(DUE)} || x.due === ${JSON.stringify(DUE)})
          && (${JSON.stringify(KIND)} === 'any' || x.kind === ${JSON.stringify(KIND)}));
      if (!cards.length) return JSON.stringify({ ok: false, err: 'card not found' });
      const a = cards[0].c.querySelector('a.group-resource-link');
      cards[0].c.scrollIntoView({ block: 'center' });
      return JSON.stringify({ ok: true, method: clickEl(a), title: cards[0].title });
    })()`);
    const r = JSON.parse(raw);
    if (!r.ok) throw new Error(r.err);
    for (let i = 0; i < 24; i++) {
      await sleep(400);
      const ps = await pages();
      const fresh = ps.find((p) => !before.has(p.id) && (p.url || '').includes('/resource/'));
      if (fresh) return fresh;
      // 少数情况下卡片直接在首页标签内跳转，而不是新开标签
      const moved = ps.find((p) => before.has(p.id) && before.get(p.id) !== p.url && (p.url || '').includes('/resource/'));
      if (moved) return moved;
    }
    throw new Error('card opened but no resource tab appeared');
  });
}

async function prep(title) {
  const tab = await openCard(title);
  const api = await connect({ port: PORT, targetId: tab.id });
  await sleep(1200);
  const confirm = await api.evalJS(CONFIRM_JS);
  await sleep(700);
  const kind = await api.evalJS(`document.querySelector('video') ? 'video' : 'doc'`);
  await api.evalJS(START_JS);
  return { api, tab, kind, confirm, startedAt: Date.now(), title };
}

async function finishDoc(p) {
  const wait = PPT_MS - (Date.now() - p.startedAt);
  if (wait > 0) await sleep(wait);
  let st = JSON.parse(await p.api.evalJS(statusJS));
  for (let round = 0; round < 4 && !st.done; round++) {
    if (round) await sleep(20000);
    await p.api.evalJS(START_JS);
    await sleep(2500);
    st = JSON.parse(await p.api.evalJS(statusJS));
    if (st.hint && st.hint.includes('截止')) break; // 截止任务无法标记完成，不再空转
  }
  return st;
}

async function runVideo(p) {
  const deadline = Date.now() + VIDEO_DEADLINE;
  let st = JSON.parse(await p.api.evalJS(statusJS));
  while (Date.now() < deadline && !st.done && !(Number(st.pct) >= 99.5) && !(st.cur != null && st.dur && st.cur >= st.dur - 1)) {
    await p.api.evalJS(PUMP_JS(RATE));
    await sleep(4000);
    st = JSON.parse(await p.api.evalJS(statusJS));
  }
  await p.api.evalJS(START_JS);
  await sleep(2500);
  st = JSON.parse(await p.api.evalJS(statusJS));
  return st;
}

async function listCards() {
  const raw = await withHome((api) => api.evalJS(LIST_JS));
  const cards = JSON.parse(raw).filter((c) => matchCard(c, null));
  return cards;
}

async function main() {
  if (cmd === 'list') {
    const cards = await listCards();
    console.log(JSON.stringify({ count: cards.length, cards }, null, 2));
    return;
  }

  if (cmd === 'open' || cmd === 'status') {
    const title = positional[0] || null;
    if (cmd === 'status') {
      const ps = await pages();
      const t = ps.find((p) => (p.url || '').includes('/resource/') && (!title || (p.title || '').includes(title)));
      if (!t) throw new Error('no resource tab' + (title ? ' matching ' + title : ''));
      const api = await connect({ port: PORT, targetId: t.id });
      const st = await api.evalJS(statusJS);
      await api.close();
      console.log(t.title + ' -> ' + st);
      return;
    }
    if (!title && !COURSE && !DUE) throw new Error('usage: open "<标题>" [--course ...] [--due ...] [--kind ...]');
    const tab = await openCard(title);
    console.log('OPENED ' + tab.title + ' ' + tab.url);
    return;
  }

  if (cmd !== 'run') throw new Error('unknown command: ' + cmd);

  if (!(await ensureKeeper())) throw new Error('no keep-alive home tab; open the course list first');

  const all = await listCards();
  const items = all.slice(0, LIMIT);
  console.log(JSON.stringify({ planned: items.length, cards: items.map((c) => c.title) }, null, 2));
  if (!items.length) { console.log('nothing to do'); return; }

  const results = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const preps = [];
    for (const it of batch) {
      try { preps.push(await prep(it.title)); }
      catch (e) { results.push({ title: it.title, ok: false, err: String(e.message || e) }); }
    }

    const docs = preps.filter((p) => p.kind === 'doc');
    const vids = preps.filter((p) => p.kind === 'video');

    for (const p of vids) { try { await p.api.evalJS(PUMP_JS(RATE)); } catch {} }
    for (const p of vids) {
      try {
        const st = await runVideo(p);
        results.push({ title: p.title, ok: st.done, kind: 'video', pct: st.pct, hint: st.hint });
      } catch (e) {
        results.push({ title: p.title, ok: false, kind: 'video', err: String(e.message || e) });
      } finally { await p.api.close(); await safeClose(p.tab.id); }
    }
    // 每个 PPT 用自己的 startedAt 计时，互不影响
    for (const p of docs) {
      try {
        const st = await finishDoc(p);
        results.push({ title: p.title, ok: st.done, kind: 'doc', learned: st.learned, hint: st.hint });
      } catch (e) {
        results.push({ title: p.title, ok: false, kind: 'doc', err: String(e.message || e) });
      } finally { await p.api.close(); await safeClose(p.tab.id); }
    }
    const ok = results.filter((r) => r.ok).length;
    console.log(`BATCH ${i / BATCH + 1}: ok ${ok}/${results.length} — ` +
      JSON.stringify(results.slice(-batch.length).map((r) => (r.ok ? 'OK ' : 'FAIL ') + r.title)));
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`SUMMARY ok=${ok} fail=${results.length - ok}`);
  for (const r of results.filter((x) => !x.ok)) console.log('FAIL ' + JSON.stringify(r));
  if (ok < results.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error('ERROR ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
