#!/usr/bin/env node
// 课程资源 / 任务 / 附件层
//
// 解决三件过去每次都要重新摸索的事：
//   1. 跨课程列出待完成任务与截止时间（不用一页页翻任务抽屉）
//   2. 找到并下载课程资源原件（PPT/PDF/DOCX），绕开 ow365 在线预览
//   3. 在**不打开卷子**的前提下读题（queryResource 内嵌试卷），避免白启动 120 分钟计时
//
//   node scripts/resources.mjs courses [--json]
//   node scripts/resources.mjs tasks [--course 名称|id] [--due 2026-11-26] [--all] [--json]
//   node scripts/resources.mjs files [--course 名称|id] [--filter 正则] [--sizes]
//   node scripts/resources.mjs get <名称子串|--filter 正则> [--course ...] [--out 目录] [--text] [--force]
//   node scripts/resources.mjs text <文件...> [--out 目录]
//   node scripts/resources.mjs docx <输入.html|md> [--out 输出.docx]
//   node scripts/resources.mjs paper <node_id|名称子串> [--course ...] [--json]
//
// 设计要点：不依赖页面 JS。资源查看页会挂起 Runtime.evaluate（ow365 iframe + 反调试），
// 所以 cookie 走 CDP 的 Network.getCookies，数据请求走 Node 原生 fetch。
// 纯 Node + 可选 LibreOffice（旧版 .ppt/.doc、html→docx 时才需要）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename, extname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { connect } from "./lib/cdp.mjs";

const BASE = "https://whut.ai-augmented.com";
const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = "Asia/Shanghai";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? def : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const has = (name) => argv.includes("--" + name);
const positional = argv.filter((a, i) => i > 0 && !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));

let jarCache = null;
async function cookieHeader() {
  if (jarCache) return jarCache;
  const api = await connect({ mode: "auto" });
  try {
    const r = await api.rpc("Network.getCookies", { urls: [BASE + "/"] });
    const jar = (r && r.cookies) || [];
    const token = jar.find((c) => c.name === "WT-prd-access-token");
    if (!token) throw new Error("没拿到登录态：先在隔离浏览器里登录理工智课");
    jarCache = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    return jarCache;
  } finally {
    await api.close();
  }
}

async function api(path, { method = "GET", body } = {}) {
  const cookie = await cookieHeader();
  const token = (cookie.match(/WT-prd-access-token=([^;]+)/) || [])[1];
  const r = await fetch(BASE + path, {
    method,
    headers: {
      cookie,
      authorization: "Bearer " + token,
      "content-type": "application/json; charset=utf-8",
      "x-language": "zh-CN",
      referer: BASE + "/app/jx-web/mycourse",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path} :: ${String(text).slice(0, 160)}`);
  if (json && json.success === false) throw new Error(`接口失败 ${path} :: ${json.message || json.code}`);
  return json;
}

const now = (iso) => new Date(iso);
const day = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d); // YYYY-MM-DD
};
const minute = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, hour12: false, dateStyle: "short", timeStyle: "medium" }).format(d);
};

async function courses() {
  const j = await api("/api/jx-iresource/group/student/groups?time_flag=1");
  return j.data || [];
}

function pickCourse(list, needle) {
  if (!needle) throw new Error("这个命令需要 --course <名称或id>");
  const k = String(needle).trim();
  const hit = list.find((c) => c.id === k) || list.find((c) => String(c.site_name || "").includes(k));
  if (!hit) throw new Error(`找不到课程: ${k}（先用 resources.mjs courses 看列表）`);
  return hit;
}

const NODE_TYPE = { 1: "目录", 2: "目录", 6: "资源", 7: "作业/测练", 8: "讨论", 9: "视频" };
const QUESTION_TYPE = { 1: "单选", 2: "多选", 3: "多选", 4: "填空", 5: "判断", 6: "简答", 7: "附件" };
const FILE_RE = /\.(pptx?|ppsx?|docx?|xlsx?|pdf|zip|rar|7z|txt|md|csv|mp4|mov|mp3|wav|png|jpe?g|gif)$/i;
const isFileNode = (n) => n && (n.type === 6 || FILE_RE.test(n.name || "")) && n.quote_id && String(n.type) !== "7";

async function courseNodes(groupId) {
  const j = await api(`/api/jx-iresource/resource/queryCourseResources/v2?group_id=${groupId}`);
  const nodes = j.data || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pathOf = (n) => {
    const parts = [];
    let cur = n;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur.type === 1 || cur.type === 2) parts.unshift(cur.name);
      cur = byId.get(cur.parent_id);
    }
    return parts.join(" / ");
  };
  return { nodes, byId, pathOf };
}

async function courseTasks(group, nodes, pathOf) {
  const j = await api(`/api/jx-stat/group/task/queryTaskNotices?group_id=${group.id}&role=1`);
  const tasks = (j.data && j.data.student_tasks) || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return tasks.map((t) => {
    const n = byId.get(t.node_id) || {};
    return {
      course: group.site_name,
      group_id: group.id,
      site_id: group.site_id,
      node_id: t.node_id,
      task_id: t.task_id,
      name: n.name || t.node_id,
      path: n.id ? pathOf(n) : "",
      node_type: n.type,
      kind: NODE_TYPE[n.type] || "任务",
      start: t.start_time,
      end: t.end_time,
      finish: t.finish,
      finish_time: t.finish_time,
      quote_id: n.quote_id || null,
    };
  });
}

// ---------- 资源下载 ----------

const safeName = (s) => String(s || "file").replace(/[\\/:*?"<>|]/g, "_").trim();

async function downloadNode(node, outDir, { force = false } = {}) {
  if (!node.quote_id) throw new Error(`${node.name}: 缺少 quote_id，无法下载`);
  const meta = await api(`/api/jx-oresource/cloud/file_down/${node.quote_id}/v2?filename=${encodeURIComponent(node.name || "file")}`);
  const url = meta && meta.data && meta.data.download_url;
  const size = (meta && meta.data && meta.data.size) || 0;
  if (!url) throw new Error(`${node.name}: 没有下载地址`);
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, safeName(node.name));
  if (!force && existsSync(target) && (!size || statSync(target).size >= size)) {
    return { name: node.name, file: target, size: statSync(target).size, cached: true };
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${node.name}: 下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(target, buf);
  return { name: node.name, file: target, size: buf.length, cached: false };
}

// ---------- 文本抽取（无依赖读 zip） ----------

function unzip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip/OOXML 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    const lnameLen = buf.readUInt16LE(local + 26);
    const lextraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnameLen + lextraLen;
    const raw = buf.slice(start, start + csize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");

function slidesText(zip) {
  const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  slides.sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const out = [];
  for (const key of slides) {
    const xml = zip.get(key).toString("utf8");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]));
    const body = texts.join(" | ").replace(/\s+/g, " ").trim();
    out.push(`\n\n[${key.replace(/^ppt\/slides\//, "").replace(/\.xml$/, "")}] ${body}`);
  }
  return out.join("").trim();
}

function docText(zip) {
  const key = [...zip.keys()].find((k) => k === "word/document.xml");
  if (!key) throw new Error("docx 里没有 word/document.xml");
  let xml = zip.get(key).toString("utf8");
  xml = xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n");
  return unescapeXml(xml.replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}

function sofficeBin() {
  if (process.env.SOFFICE) return process.env.SOFFICE;
  const candidates = [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "soffice";
}

function convert(file, to, filter, outDir) {
  const spec = filter ? `${to}:${filter}` : to;
  execFileSync(sofficeBin(), ["--headless", "--convert-to", spec, "--outdir", outDir, file], { stdio: "ignore" });
  const base = basename(file).replace(/\.[^.]+$/, "");
  const out = join(outDir, `${base}.${to}`);
  if (!existsSync(out)) throw new Error(`转换失败: ${basename(file)} → ${to}（需要 LibreOffice）`);
  return out;
}

function extractText(file) {
  const ext = extname(file).toLowerCase();
  const tmp = join(dirname(file), ".whut-tmp");
  mkdirSync(tmp, { recursive: true });
  try {
    if (ext === ".pptx" || ext === ".ppsx") return slidesText(unzip(readFileSync(file)));
    if (ext === ".docx") return docText(unzip(readFileSync(file)));
    if (ext === ".ppt" || ext === ".pps") {
      const pptx = convert(file, "pptx", null, tmp);
      return slidesText(unzip(readFileSync(pptx)));
    }
    if (ext === ".doc") {
      const docx = convert(file, "docx", "MS Word 2007 XML", tmp);
      return docText(unzip(readFileSync(docx)));
    }
    if (ext === ".pdf") {
      const txt = join(tmp, basename(file).replace(/\.pdf$/i, "") + ".txt");
      try {
        execFileSync("pdftotext", ["-layout", file, txt], { stdio: "ignore" });
        if (existsSync(txt)) return readFileSync(txt, "utf8").trim();
      } catch { /* 无 pdftotext */ }
      throw new Error("PDF 需要 pdftotext（poppler）；或用 LibreOffice 另存为文本");
    }
    if (ext === ".html" || ext === ".htm") {
      return readFileSync(file, "utf8").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    }
    if (ext === ".txt" || ext === ".md" || ext === ".csv") return readFileSync(file, "utf8");
    throw new Error(`暂不支持从 ${ext} 抽取文本`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeText(file, outDir) {
  const body = extractText(file);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, basename(file).replace(/\.[^.]+$/, "") + ".txt");
  writeFileSync(out, body, "utf8");
  return { name: basename(file), out, chars: body.length };
}

// ---------- 读题（不建答题记录） ----------

async function paperBundle(group, nodeId) {
  const res = await api(`/api/jx-iresource/resource/queryResource/v3?node_id=${nodeId}&group_id=${group.id}`);
  const paper = (res.data && res.data.resource) || null;
  if (!paper) throw new Error(`节点 ${nodeId} 没有内嵌试卷（可能不是作业/测练）`);
  const flow = await api(`/api/jx-iresource/survey/course/task/flow/v2?node_id=${nodeId}&group_id=${group.id}`);
  const task = (flow.data && flow.data.task) || {};
  const records = (flow.data && flow.data.task_flow_record) || [];
  const publishId = task.paper_publish_id;
  const url = publishId
    ? `${BASE}/app/jx-web/course_paper/mycourse/${group.id}/${nodeId}/${publishId}/${paper.id}?isNotPreview=false&site_id=${group.site_id || ""}`
    : null;
  return { paper, task, records, url };
}

const draftText = (v) => {
  const s = String(v == null ? "" : v);
  if (!s.trim().startsWith("{")) return s;
  try { return (JSON.parse(s).blocks || []).map((b) => b.text || "").join("").trim(); } catch { return s; }
};

// ---------- 命令 ----------

const cmds = {
  async courses() {
    const list = await courses();
    if (has("json")) return console.log(JSON.stringify(list.map((c) => ({ id: c.id, name: c.site_name, site_id: c.site_id })), null, 2));
    for (const c of list) console.log([c.id, c.site_name].join(" | "));
    console.log(`\n共 ${list.length} 门进行中的课`);
  },

  async tasks() {
    const list = await courses();
    const only = flag("course");
    const includeDone = has("all");
    const picked = only ? [pickCourse(list, only)] : list;
    const all = [];
    for (const c of picked) {
      const { nodes, pathOf } = await courseNodes(c.id);
      const tasks = await courseTasks(c, nodes, pathOf);
      all.push(...tasks);
    }
    let rows = includeDone ? all : all.filter((t) => Number(t.finish) !== 2);
    const due = flag("due");
    const dueStart = flag("due-start");
    if (due) rows = rows.filter((t) => day(t.end) === String(due));
    if (dueStart) rows = rows.filter((t) => day(t.start) === String(dueStart));
    rows.sort((a, b) => String(a.end).localeCompare(String(b.end)));
    if (has("json")) return console.log(JSON.stringify(rows, null, 2));
    for (const t of rows) {
      console.log([t.course, t.path ? t.path + " / " + t.name : t.name, t.kind, `截止 ${minute(t.end)}`, `node=${t.node_id}`].join(" | "));
    }
    console.log(`\n共 ${rows.length} 条${includeDone ? "" : "未完成"}任务${due ? `（${due} 截止）` : ""}${dueStart ? `（${dueStart} 开始）` : ""}`);
  },

  async files() {
    const list = await courses();
    const c = pickCourse(list, flag("course"));
    const re = flag("filter") ? new RegExp(flag("filter"), "i") : null;
    const { nodes, pathOf } = await courseNodes(c.id);
    const files = nodes.filter((n) => isFileNode(n) && (!re || re.test(n.name || "")));
    if (has("json")) return console.log(JSON.stringify(files.map((n) => ({ id: n.id, name: n.name, quote_id: n.quote_id, path: pathOf(n) })), null, 2));
    for (const n of files) console.log([n.name, pathOf(n), `node=${n.id}`].join(" | "));
    console.log(`\n${c.site_name} 共 ${files.length} 个可下载资源`);
  },

  async get() {
    const keyword = positional[0] || flag("filter");
    if (!keyword) throw new Error("用法: resources.mjs get <名称子串|--filter 正则> --course <课程>");
    const list = await courses();
    const c = pickCourse(list, flag("course"));
    const { nodes } = await courseNodes(c.id);
    const re = new RegExp(String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const targets = nodes.filter((n) => isFileNode(n) && re.test(n.name || ""));
    if (!targets.length) throw new Error(`没有匹配 "${keyword}" 的资源`);
    const out = resolve(String(flag("out", "./whut-resources")));
    const results = [];
    for (const n of targets) {
      try {
        const r = await downloadNode(n, out, { force: has("force") });
        if (has("text")) {
          try { r.text = writeText(r.file, out); } catch (e) { r.textError = e.message; }
        }
        results.push({ ok: true, ...r });
      } catch (e) {
        results.push({ ok: false, name: n.name, error: e.message });
      }
      console.log(JSON.stringify(results[results.length - 1]));
    }
    console.log(`\n下载 ${results.filter((r) => r.ok).length}/${results.length} → ${out}`);
  },

  async text() {
    const files = positional.filter((p) => existsSync(p));
    if (!files.length) throw new Error("用法: resources.mjs text <文件...> [--out 目录]");
    const out = resolve(String(flag("out", "./whut-text")));
    for (const f of files) {
      try { console.log(JSON.stringify({ ok: true, ...writeText(f, out) })); }
      catch (e) { console.log(JSON.stringify({ ok: false, file: f, error: e.message })); }
    }
  },

  async docx() {
    const src = positional[0];
    if (!src || !existsSync(src)) throw new Error("用法: resources.mjs docx <输入.html> [--out 输出.docx]");
    const tmp = resolve(String(flag("out", "./")));
    mkdirSync(tmp, { recursive: true });
    const made = convert(resolve(src), "docx", "MS Word 2007 XML", tmp);
    const want = flag("out");
    if (want && !String(want).endsWith(".docx")) throw new Error("--out 需要是 .docx 路径");
    if (want) { copyFileSync(made, resolve(String(want))); rmSync(made, { force: true }); }
    console.log(JSON.stringify({ ok: true, docx: want ? resolve(String(want)) : made }));
  },

  async paper() {
    const keyword = positional[0];
    if (!keyword) throw new Error("用法: resources.mjs paper <node_id|名称子串> --course <课程>");
    const list = await courses();
    const c = pickCourse(list, flag("course"));
    const { nodes, pathOf, byId } = await courseNodes(c.id);
    let node = byId.get(String(keyword));
    if (!node) {
      const hits = nodes.filter((n) => n.type === 7 && String(n.name || "").includes(String(keyword)));
      if (!hits.length) throw new Error(`没找到作业节点 "${keyword}"`);
      if (hits.length > 1) throw new Error(`匹配到多个，请用 node_id 指定：${hits.map((n) => n.id).join(", ")}`);
      node = hits[0];
    }
    const { paper, task, records, url } = await paperBundle(c, node.id);
    const questions = (paper.questions || []).map((q, i) => ({
      n: i + 1,
      qid: q.id,
      type: QUESTION_TYPE[q.type] || q.type,
      score: q.score,
      stem: draftText(q.title),
      options: (q.answer_items || []).map((o) => draftText(o.value)).filter((v) => v && v !== "请在此处作答"),
    }));
    const sampled = Number(paper.is_sampling) === 2 || !!paper.random_rule;
    const summary = {
      course: c.site_name,
      name: node.name,
      path: pathOf(node),
      node_id: node.id,
      paper_id: paper.id,
      publish_id: task.paper_publish_id,
      total_score: paper.total_score,
      window: { start: minute(task.start_time), end: minute(task.end_time) },
      repeat: paper.repetition,
      sampling: sampled,
      random_rule: paper.random_rule || null,
      answer_record: (records.find((r) => r.answer_record_id) || {}).answer_record_id || null,
      url,
      questions,
    };
    if (has("json")) return console.log(JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, questions: undefined }, null, 2));
    if (sampled) console.log("注意: 该卷为抽样卷，重新作答会重新抽题——不要把上一套答案直接重交。");
    for (const q of questions) {
      console.log(`\n【${q.n}】(${q.type}${q.score ? ", " + q.score + "分" : ""}) ${q.stem}`);
      if (q.options.length) console.log("   " + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | "));
    }
  },
};

if (!cmds[cmd]) {
  console.log(`resources.mjs — 课程资源 / 任务 / 读题
  courses [--json]
  tasks [--course 名称|id] [--due YYYY-MM-DD] [--due-start YYYY-MM-DD] [--all] [--json]
  files --course <课程> [--filter 正则] [--json]
  get <名称子串|--filter 正则> --course <课程> [--out 目录] [--text] [--force]
  text <文件...> [--out 目录]
  docx <输入.html> [--out 输出.docx]
  paper <node_id|名称子串> --course <课程> [--json]`);
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...positional).catch((e) => { console.error("ERR:", e.message); process.exit(1); });
