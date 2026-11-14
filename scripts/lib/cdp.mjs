// 共享 CDP 层：目标选择、RPC、页面求值、网络抓包、反调试规避。
// 所有脚本都从这里连浏览器，避免重复实现。
const DEFAULT_PORT = 9222;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  if (!res) throw new Error(`no CDP on :${port} - 启动隔离 Edge: --remote-debugging-port=${port}`);
  return res.json();
}

function scoreTarget(t, mode, name, override) {
  const u = t.url || "";
  let s = 0;
  if (override && u.includes(override)) s += 1e4;
  if (name && (t.title || "").includes(name)) s += 5e3;
  if (u === "about:blank") s -= 1e3;
  if (/^(edge|devtools|chrome):/.test(u)) s -= 5e4;
  const isPaper = u.includes("course_paper");
  const isRes = u.includes("/resource/");
  const isHome = u.includes("/app/jx-web/mycourse") && !isRes && !isPaper;
  const table = {
    paper: [isPaper, 500, isHome, 100, isRes, 10],
    resource: [isRes, 500, isHome, 100, isPaper, 10],
    home: [isHome, 500, isPaper, 100, isRes, 10],
    auto: [isPaper, 500, isRes, 100, isHome, 50],
  }[mode] || [];
  for (let i = 0; i < table.length; i += 2) if (table[i]) s += table[i + 1];
  return s;
}

export async function connect({ port = DEFAULT_PORT, mode = "auto", name = null, targetId = null } = {}) {
  const list = await listTargets(port);
  const pages = list.filter((t) => t.type === "page");
  if (!pages.length) throw new Error(`no page on :${port}`);
  const override = process.env.CDP_MATCH || null;
  const target = targetId
    ? pages.find((t) => t.id === targetId)
    : pages.sort((a, b) => scoreTarget(b, mode, name, override) - scoreTarget(a, mode, name, override))[0];
  if (!target) throw new Error("target not found: " + (targetId || mode));

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

  let seq = 0;
  const pending = new Map();
  const net = [];

  const rawCall = (method, params = {}, timeout = 25000) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { pending.delete(id); reject(e); }
    setTimeout(() => { if (pending.delete(id)) reject(new Error("timeout " + method)); }, timeout);
  });

  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === "Debugger.paused") { ws.send(JSON.stringify({ id: ++seq, method: "Debugger.resume" })); return; }
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      net.push({ i: net.length, rid: m.params.requestId, url: r.url, method: r.method, body: r.postData ?? null, status: null, resp: null });
      return;
    }
    if (m.method === "Network.responseReceived") {
      const e = net.find((x) => x.rid === m.params.requestId);
      if (e) { e.status = m.params.response.status; e.mime = m.params.response.mimeType; }
      return;
    }
    if (m.method === "Network.loadingFinished") {
      const e = net.find((x) => x.rid === m.params.requestId);
      if (e && /json|text/.test(e.mime || "")) {
        rawCall("Network.getResponseBody", { requestId: m.params.requestId }, 8000)
          .then((b) => { e.resp = String((b && b.body) || "").slice(0, 4000); }).catch(() => {});
      }
    }
  });

  const api = { ws, target, net };

  api.rpc = rawCall;
  api.evalJS = async (expression, timeout = 60000) => {
    const r = await api.rpc("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
    }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  // 反调试 + 后台标签解冻（顺序有讲究，见 references/pitfalls.md 第 2/3/22 条）
  await api.rpc("Runtime.enable");
  await api.rpc("Debugger.enable").catch(() => {});
  await api.rpc("Debugger.setSkipAllPauses", { skip: true }).catch(() => {});
  for (let i = 0; i < 3; i++) await api.rpc("Debugger.resume", {}, 2000).catch(() => {});
  await api.rpc("Page.enable").catch(() => {});
  await api.rpc("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await api.rpc("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await api.rpc("Network.enable", { maxPostDataSize: 65536 }).catch(() => {});

  api.close = () => new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try { ws.addEventListener("close", fin); } catch {}
    try { ws.close(); } catch { fin(); }
    setTimeout(fin, 400);
  });

  return api;
}

// 注入页面内 API 客户端：同源 fetch + Bearer token + URL 解 id
export const PAGE_API = String.raw`(function () {
  window.__whutApi = async function (path, opt) {
    opt = opt || {};
    var tok = (document.cookie.match(/WT-prd-access-token=([^;]+)/) || [])[1];
    var r = await fetch("https://whut.ai-augmented.com" + path, {
      credentials: "include",
      method: opt.method || "GET",
      headers: { authorization: "Bearer " + tok, "content-type": "application/json; charset=utf-8", "x-language": "zh-CN" },
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    var json = null;
    try { json = await r.json(); } catch (e) {}
    return { status: r.status, json: json };
  };
  window.__whutIds = function () {
    var m = location.pathname.match(/course_paper\/mycourse\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) return null;
    return { group_id: m[1], node_id: m[2], task_id: m[3], paper_id: m[4] };
  };
  return "ok";
})()`;

export async function ensurePageApi(api) {
  return api.evalJS(PAGE_API);
}