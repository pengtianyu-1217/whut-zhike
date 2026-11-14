#!/usr/bin/env node
// 攻坚入口：绕过展示层/导航层限制、时间回拨、抓包重放、页面求值。
//   node scripts/unlock.mjs list
//   node scripts/unlock.mjs tasks
//   node scripts/unlock.mjs force "<任务名|序号>"
//   node scripts/unlock.mjs clock [-30]
//   node scripts/unlock.mjs sniff [秒]
//   node scripts/unlock.mjs dump
//   node scripts/unlock.mjs replay <序号|last> [k=v ...]
//   node scripts/unlock.mjs eval "<expr>"
//   node scripts/unlock.mjs goto <url>
import { connect, listTargets, sleep } from "./lib/cdp.mjs";

const CARDS_FN = String.raw`(() => {
  const cards = [...document.querySelectorAll(".task_card .ant-col.ta_homework")];
  const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$")); return k ? el[k] : null; };
  return cards.map((c, i) => {
    const a = c.querySelector("a.group-resource-link");
    const txt = (sel) => (c.querySelector(sel)?.innerText || "").trim();
    const all = (c.innerText || "").replace(/\s+/g, " ");
    let onClick = false;
    for (let n = a ? fiberOf(a) : null; n; n = n.return) {
      if (n.memoizedProps && typeof n.memoizedProps.onClick === "function") { onClick = true; break; }
    }
    const badge = [...c.querySelectorAll("span,div")].map((e) => (e.innerText || "").trim())
      .filter((t) => /已截止|已结束|已过期|不可作答|已锁定/.test(t));
    return {
      i, title: (a?.innerText || "").trim(), href: a?.getAttribute("href") || null,
      course: txt("a.group_link.inline"), deadline: txt(".xy_taskCard_bottom span"), type: txt(".ta_taskType"),
      closed: badge.length > 0 || /已截止|已结束|已过期|不可作答/.test(all),
      clickable: !!onClick, raw: all.slice(0, 160),
    };
  });
})()`;

const OPEN_FN = (needle) => `(() => {
  const cards = [...document.querySelectorAll(".task_card .ant-col.ta_homework")];
  const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$")); return k ? el[k] : null; };
  const needle = ${JSON.stringify(needle)};
  let hit = /^\\d+$/.test(needle) ? cards[Number(needle)] : null;
  if (!hit) hit = cards.find((c) => (c.innerText || "").replace(/\\s+/g, "").includes(needle.replace(/\\s+/g, "")));
  if (!hit) return { ok: false, err: "card not found", total: cards.length };
  const a = hit.querySelector("a.group-resource-link");
  const fire = (el, name) => {
    for (let n = fiberOf(el); n; n = n.return) {
      const p = n.memoizedProps;
      if (p && typeof p[name] === "function") {
        p[name]({ preventDefault() {}, stopPropagation() {}, nativeEvent: {}, currentTarget: el, target: el });
        return true;
      }
    }
    return false;
  };
  const clicked = a ? (fire(a, "onClick") || fire(hit, "onClick")) : fire(hit, "onClick");
  return { ok: true, href: a?.getAttribute("href") || null, clicked, title: (a?.innerText || "").trim() };
})()`;

const ENTER_FN = String.raw`(() => {
  const el = [...document.querySelectorAll("body *")].find((e) => /点击进入任务/.test((e.innerText || "").trim()) && e.children.length < 4);
  if (!el) return { ok: false, err: "enter button not found" };
  const fiberOf = (n) => { const k = Object.keys(n).find((x) => x.startsWith("__reactFiber$")); return k ? n[k] : null; };
  for (let n = fiberOf(el); n; n = n.return) {
    const p = n.memoizedProps;
    if (p && typeof p.onClick === "function") { p.onClick({ preventDefault() {}, stopPropagation() {} }); return { ok: true, how: "react" }; }
  }
  el.click();
  return { ok: true, how: "native" };
})()`;

const DUMP_FN = String.raw`(() => {
  const HIT = /deadline|end_?time|endTime|expire|close_?time|截止|overdue|isEnd|status/i;
  const out = { url: location.href, storage: {}, globals: {}, keys: [] };
  const seen = new Set();
  const scan = (obj, tag, depth) => {
    if (!obj || typeof obj !== "object" || depth > 3 || seen.has(obj)) return;
    seen.add(obj);
    for (const k of Object.keys(obj).slice(0, 80)) {
      if (HIT.test(k)) {
        let v; try { v = obj[k]; } catch { continue; }
        if (typeof v !== "object") out.globals[tag + "." + k] = v;
        out.keys.push(tag + "." + k);
      }
      try { if (obj[k] && typeof obj[k] === "object") scan(obj[k], tag + "." + k, depth + 1); } catch {}
    }
  };
  for (const s of ["localStorage", "sessionStorage"]) {
    try {
      for (const k of Object.keys(window[s])) {
        const v = window[s][k];
        out.storage[s + ":" + k] = String(v).length > 400 ? String(v).slice(0, 400) + "..." : v;
        if (HIT.test(k) || HIT.test(String(v).slice(0, 2000))) out.keys.push(s + ":" + k);
      }
    } catch {}
  }
  for (const g of Object.keys(window)) if (/^__|INITIAL|store|STORE|state|DATA/.test(g)) { try { scan(window[g], g, 0); } catch {} }
  return out;
})()`;

function clockScript(minutes) {
  const ms = Math.round(minutes * 60000);
  return `(() => {
  const OFFSET = ${ms}, RealDate = Date, now = () => RealDate.now() + OFFSET;
  class FakeDate extends RealDate {
    constructor(...a) { a.length === 0 ? super(now()) : super(...a); }
    static now() { return now(); }
  }
  FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  try { Object.defineProperty(window, "Date", { value: FakeDate, writable: true, configurable: true }); } catch (e) {}
  const rp = performance.now.bind(performance);
  try { performance.now = () => rp() + OFFSET; } catch (e) {}
  try { Object.defineProperty(document, "hidden", { get: () => false, configurable: true }); } catch (e) {}
  try { Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true }); } catch (e) {}
  return OFFSET;
})()`;
}

async function openHome(api) {
  const href = await api.evalJS("location.href");
  if (/\/app\/jx-web\/mycourse/.test(href) && !/course_paper|\/resource\//.test(href)) return;
  await api.rpc("Page.navigate", { url: "https://whut.ai-augmented.com/app/jx-web/mycourse" });
  await sleep(4500);
}

const cmds = {
  async list() {
    const pages = (await listTargets()).filter((t) => t.type === "page");
    for (const t of pages) console.log(`${t.id}\t${t.url}`);
  },

  async tasks() {
    const api = await connect({ mode: "home" });
    try {
      await openHome(api);
      await api.evalJS(`(() => {
        const sq = [...document.querySelectorAll(".square")].find((e) => /待完成任务|任务/.test(e.innerText || ""));
        if (sq) sq.click(); return !!sq;
      })()`);
      await sleep(1200);
      await api.evalJS(`(() => {
        const labels = [...document.querySelectorAll("label.ant-radio-wrapper, .ant-radio-wrapper")];
        const all = labels.find((l) => /显示全部任务/.test(l.innerText || ""));
        if (all) (all.querySelector("input") || all).click();
        return true;
      })()`);
      await sleep(1800);
      console.log(JSON.stringify(await api.evalJS(CARDS_FN), null, 2));
    } finally { await api.close(); }
  },

  async force(needle) {
    if (!needle) throw new Error('用法: unlock.mjs force "<任务名|序号>"');
    const api = await connect({ mode: "home" });
    try {
      await openHome(api);
      await api.rpc("Page.addScriptToEvaluateOnNewDocument", { source: clockScript(-1440) }).catch(() => {});
      await api.evalJS(clockScript(-1440)).catch(() => {});
      const opened = await api.evalJS(OPEN_FN(needle));
      console.log("open:", JSON.stringify(opened));
      await sleep(3500);
      let target = (await listTargets()).find((t) => t.type === "page" && /course_paper|\/resource\//.test(t.url));
      if (!target && opened.href) {
        await api.rpc("Page.navigate", { url: opened.href });
        await sleep(4000);
        target = (await listTargets()).find((t) => t.type === "page" && /course_paper|\/resource\//.test(t.url));
      }
      if (target && /\/resource\//.test(target.url)) {
        const res = await connect({ mode: "resource", targetId: target.id });
        try { console.log("enter:", JSON.stringify(await res.evalJS(ENTER_FN))); } finally { await res.close(); }
        await sleep(4000);
      }
      const after = (await listTargets()).filter((t) => t.type === "page" && /whut|ai-augmented/.test(t.url)).map((t) => t.url);
      console.log("tabs:", JSON.stringify(after, null, 2));
    } finally { await api.close(); }
  },

  async clock(minutes) {
    const m = Number(minutes ?? -30);
    const api = await connect({ mode: "auto" });
    try {
      const id = await api.rpc("Page.addScriptToEvaluateOnNewDocument", { source: clockScript(m) });
      const applied = await api.evalJS(clockScript(m));
      console.log(JSON.stringify({ scriptId: id.identifier, offsetMs: applied, note: "对之后的导航生效，且已立即作用于当前页" }));
    } finally { await api.close(); }
  },

  async sniff(secs) {
    const s = Number(secs ?? 25);
    const api = await connect({ mode: "auto" });
    try {
      console.log("sniffing", s, "s on:", await api.evalJS("location.href"));
      await sleep(s * 1000);
      const view = api.net
        .filter((e) => /\/api\/|submit|answer|paper|homework|task|exam|save|grade/i.test(e.url))
        .map((e) => ({ i: e.i, method: e.method, status: e.status, url: e.url.replace("https://whut.ai-augmented.com", ""), body: e.body, resp: e.resp }));
      console.log(JSON.stringify(view, null, 2));
    } finally { await api.close(); }
  },

  async dump() {
    const api = await connect({ mode: "auto" });
    try { console.log(JSON.stringify(await api.evalJS(DUMP_FN), null, 2)); } finally { await api.close(); }
  },

  async replay(which, ...pairs) {
    const api = await connect({ mode: "auto" });
    try {
      await sleep(400);
      const pick = !which || which === "last"
        ? [...api.net].reverse().find((e) => e.method !== "GET" && /\/api\//.test(e.url))
        : api.net.find((e) => e.i === Number(which));
      if (!pick) throw new Error("没有匹配请求；先 sniff 抓一次");
      let body = pick.body || "";
      const patch = {};
      for (const kv of pairs) { const i = kv.indexOf("="); if (i > 0) patch[kv.slice(0, i)] = kv.slice(i + 1); }
      try { body = JSON.stringify(Object.assign(JSON.parse(body), patch)); } catch {}
      const expr = `(async () => {
        const tok = (document.cookie.match(/WT-prd-access-token=([^;]+)/) || [])[1];
        const r = await fetch(${JSON.stringify(pick.url)}, {
          method: ${JSON.stringify(pick.method)}, credentials: "include",
          headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer " + tok },
          body: ${JSON.stringify(body)} || undefined,
        });
        return { status: r.status, body: (await r.text()).slice(0, 2000) };
      })()`;
      console.log("replaying:", pick.method, pick.url);
      console.log(JSON.stringify(await api.evalJS(expr), null, 2));
    } finally { await api.close(); }
  },

  async eval(expr) {
    if (!expr) throw new Error("用法: unlock.mjs eval \"<expr>\"");
    const api = await connect({ mode: "auto" });
    try { console.log(JSON.stringify(await api.evalJS(expr), null, 2)); } finally { await api.close(); }
  },

  async goto(url) {
    if (!url) throw new Error("用法: unlock.mjs goto <url>");
    const full = /^https?:/.test(url) ? url : `https://whut.ai-augmented.com${url}`;
    const api = await connect({ mode: "auto" });
    try {
      await api.rpc("Page.navigate", { url: full });
      await sleep(4500);
      console.log(JSON.stringify({
        url: await api.evalJS("location.href"),
        title: await api.evalJS("document.title"),
        body: (await api.evalJS("document.body.innerText")).slice(0, 900),
      }, null, 2));
    } finally { await api.close(); }
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log(`unlock.mjs - 攻坚入口
  list | tasks | force "<名|序号>" | clock [分钟] | sniff [秒] | dump | replay <序号|last> [k=v] | eval "<expr>" | goto <url>`);
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...rest).catch((e) => { console.error("ERR:", e.message); process.exit(1); });