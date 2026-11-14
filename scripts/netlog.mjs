#!/usr/bin/env node
// 常驻网络录像：把 ai-augmented 域下所有标签页的请求/响应写成 JSONL。
//   node scripts/netlog.mjs <out.jsonl>
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTargets, connect, sleep } from "./lib/cdp.mjs";

const OUT = process.argv[2] || join(tmpdir(), "whut-netlog.jsonl");
const conns = new Map();
const cursor = new Map();

const short = (s, n = 4000) => (s ? String(s).slice(0, n) : null);
const write = (o) => { try { appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + "\n"); } catch {} };

write({ ev: "start", pid: process.pid });

async function tick() {
  let list = [];
  try { list = await listTargets(); } catch { return; }
  const live = new Set();

  for (const t of list) {
    if (t.type !== "page" || !/ai-augmented/.test(t.url || "")) continue;
    live.add(t.id);
    if (!conns.has(t.id)) {
      try {
        const api = await connect({ targetId: t.id });
        conns.set(t.id, api);
        cursor.set(t.id, 0);
        write({ ev: "attach", tab: t.url, title: t.title });
      } catch { /* tab 可能在关闭中 */ }
    }
  }

  for (const [id, api] of [...conns]) {
    if (!live.has(id)) { try { await api.close(); } catch {} conns.delete(id); cursor.delete(id); write({ ev: "detach", tab: id }); continue; }
    const from = cursor.get(id) || 0;
    for (let i = from; i < api.net.length; i++) {
      const e = api.net[i];
      if (!/\/api\//.test(e.url) && !/ai-augmented\.com/.test(e.url)) continue;
      write({ ev: "req", tab: api.target.url, i: e.i, method: e.method, url: e.url, body: short(e.body), status: e.status });
      if (e.resp) write({ ev: "res", i: e.i, method: e.method, url: e.url, status: e.status, body: short(e.resp) });
    }
    cursor.set(id, api.net.length);
  }
}

await tick();
setInterval(tick, 1500);
setInterval(() => write({ ev: "beat", tabs: conns.size }), 30000);