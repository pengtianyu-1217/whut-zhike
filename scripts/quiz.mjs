#!/usr/bin/env node
// 题库层：从试卷 API 直接取题、查本地缓存、把答过的题沉淀成库。
// 思路来自「小雅答答答」的共享答案机制，改成纯本地，不依赖第三方服务。
//
//   node scripts/quiz.mjs dump               导出当前卷全部题目
//   node scripts/quiz.mjs prompt             输出待答题清单（给 AI / 人）
//   node scripts/quiz.mjs lookup             查本地题库，命中项输出 answers.json
//   node scripts/quiz.mjs save <answers.json> 把本次题目+答案写入题库
//   node scripts/quiz.mjs record             只看答题记录，不创建
//   node scripts/quiz.mjs stats              题库统计
//
// 题库文件：scripts/../answers-cache.jsonl（一行一条，可手工编辑/分享）

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect, ensurePageApi } from "./lib/cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "..", "answers-cache.jsonl");

const norm = (s) => String(s || "").replace(/[\s\u3000]+/g, "").replace(/[（）()【】\[\]、，,。.：:；;”"'’‘?？!！]/g, "").toLowerCase();

// Draft.js 的 title 是一个 JSON 字符串，把 blocks 的 text 拼起来就是题干
function stemOf(title) {
  try {
    const j = typeof title === "string" ? JSON.parse(title) : title;
    return (j.blocks || []).map((b) => b.text || "").join("").trim();
  } catch { return String(title || ""); }
}

// 平台题型：优先按 answer_items 形态推断，raw type 一并输出供核对
// 平台题型枚举（实测标定）：1 单选 / 2,3 多选 / 4 填空 / 5 判断 / 6 简答 / 7 附件
const TYPE_MAP = { 1: "choice", 2: "multi", 3: "multi", 4: "gap", 5: "judge", 6: "short", 7: "attach" };

function draftText(v) {
  const s = String(v == null ? "" : v);
  if (!s.startsWith("{")) return s;
  try { return (JSON.parse(s).blocks || []).map((b) => b.text || "").join("").trim(); } catch { return s; }
}

function inferType(q) {
  const items = q.answer_items || [];
  if (items.some((i) => String(i.value) === "true")) return "judge";
  const mapped = TYPE_MAP[q.type];
  if (mapped) return mapped;
  if (String(q.file_size || "0") !== "0") return "attach";
  if (items.length >= 2) return q.max_choice_num === 1 ? "choice" : "multi";
  return "unknown";
}

async function withPaper(fn) {
  const api = await connect({ mode: "paper" });
  try {
    await ensurePageApi(api);
    const ids = await api.evalJS("window.__whutIds()");
    if (!ids) throw new Error("当前标签页不是 course_paper，先 unlock.mjs goto 或 force 打开试卷");
    const paper = await api.evalJS(`__whutApi("/api/jx-iresource/survey/course/queryStuPaper/v2?paper_id=${ids.paper_id}&group_id=${ids.group_id}&node_id=${ids.node_id}")`);
    const flow = await api.evalJS(`__whutApi("/api/jx-iresource/survey/course/task/flow/v2?node_id=${ids.node_id}&group_id=${ids.group_id}")`);
    if (!paper.json || !paper.json.data) throw new Error("试卷接口无数据: " + JSON.stringify(paper).slice(0, 200));
    return await fn({ api, ids, data: paper.json.data, flow: flow.json && flow.json.data });
  } finally {
    await api.close();
  }
}

function toQuestions(data) {
  return (data.questions || []).map((q, idx) => {
    const type = inferType(q);
    const opts = (q.answer_items || []).map((i) => draftText(i.value)).filter((v) => v !== "");
    return {
      n: idx + 1,
      qid: q.id,
      rawType: q.type,
      type,
      stem: stemOf(q.title),
      score: q.score,
      options: type === "judge" ? ["正确", "错误"] : opts,
      maxChoice: q.max_choice_num,
    };
  });
}

function loadCache() {
  if (!existsSync(CACHE)) return [];
  return readFileSync(CACHE, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function findAnswer(cache, stem) {
  const k = norm(stem);
  if (!k) return null;
  for (const row of cache) if (row.k === k) return row;
  for (const row of cache) if (row.k && (row.k.includes(k) || k.includes(row.k)) && Math.abs(row.k.length - k.length) <= 20) return row;
  return null;
}

const cmds = {
  async dump() {
    const out = await withPaper(async ({ ids, data, flow }) => {
      const recs = (flow && flow.task_flow_record) || [];
      return {
        ids,
        title: data.title,
        totalScore: data.total_score,
        window: {
          start: data.publish_record && data.publish_record.start_time,
          end: data.publish_record && data.publish_record.end_time,
          repetition: data.publish_record && data.publish_record.repetition,
          allowAfterSubmit: data.publish_record && data.publish_record.is_allow_after_submitted,
        },
        answerRecordId: recs.find((r) => r.answer_record_id)?.answer_record_id || null,
        questions: toQuestions(data),
      };
    });
    console.log(JSON.stringify(out, null, 2));
  },

  async prompt() {
    const out = await withPaper(async ({ data }) => toQuestions(data));
    const unexplained = out.filter((q) => !findAnswer(loadCache(), q.stem));
    const lines = [`请直接给出下面 ${unexplained.length} 道题的答案，输出 JSON：{"<题号>": <答案>}（判断题 true/false，选择题 "A"，多选 ["A","C"]，填空 ["空1","空2"，简单题直接写文字）`, ""];
    for (const q of unexplained) {
      lines.push(`【${q.n}】(${q.type}, ${q.score}分) ${q.stem}`);
      if (q.options.length) lines.push("   选项: " + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(" | "));
    }
    console.log(lines.join("\n"));
    if (!unexplained.length) console.log("(全部命中本地题库，直接 quiz lookup)");
  },

  async lookup() {
    const res = await withPaper(async ({ data }) => {
      const qs = toQuestions(data);
      const cache = loadCache();
      const answers = {};
      const miss = [];
      for (const q of qs) {
        const hit = findAnswer(cache, q.stem);
        if (hit) answers[String(q.n)] = hit.a; else miss.push(q.n);
      }
      return { total: qs.length, hit: Object.keys(answers).length, miss, answers };
    });
    console.log(JSON.stringify({ type: "mixed", answers: res.answers }, null, 2));
    if (res.miss.length) console.error(`\n未命中题号: ${res.miss.join(", ")}（用 quiz prompt 补齐后再 save）`);
  },

  async save(file) {
    if (!file) throw new Error("用法: node scripts/quiz.mjs save answers.json");
    const ans = JSON.parse(readFileSync(file, "utf8"));
    const flat = ans && ans.answers ? ans.answers : ans;
    const saved = await withPaper(async ({ data }) => {
      const qs = toQuestions(data);
      const rows = [];
      for (const q of qs) {
        const a = flat[String(q.n)];
        if (a === undefined || a === null) continue;
        rows.push(JSON.stringify({ k: norm(q.stem), stem: q.stem.slice(0, 200), type: q.type, a, ts: new Date().toISOString().slice(0, 19) }));
      }
      return rows;
    });
    if (saved.length) appendFileSync(CACHE, saved.join("\n") + "\n", "utf8");
    console.log(JSON.stringify({ appended: saved.length, file: CACHE }, null, 2));
  },

  async record() {
    const out = await withPaper(async ({ ids, data, flow }) => {
      const recs = (flow && flow.task_flow_record) || [];
      const rec = recs.find((r) => r.answer_record_id)?.answer_record_id || null;
      const pub = data.publish_record || {};
      const expired = pub.end_time ? new Date(pub.end_time).getTime() < Date.now() : null;
      return {
        ids, expired, end: pub.end_time, allowAfterSubmit: pub.is_allow_after_submitted,
        answerRecordId: rec,
        verdict: rec ? "已有答题记录，可直接 save + submit"
          : expired ? "无记录且已截止：createRecord 会被服务端拒绝（3003106）"
          : "无记录但未截止：页面会自动创建，或调 createRecord/v2",
      };
    });
    console.log(JSON.stringify(out, null, 2));
  },

  async stats() {
    const cache = loadCache();
    const byType = {};
    for (const r of cache) byType[r.type || "?"] = (byType[r.type || "?"] || 0) + 1;
    console.log(JSON.stringify({ entries: cache.length, byType, file: CACHE }, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmds[cmd]) {
  console.log(`quiz.mjs — 题库层
  dump | prompt | lookup | save <answers.json> | record | stats`);
  process.exit(cmd ? 1 : 0);
}
cmds[cmd](...rest).catch((e) => { console.error("ERR:", e.message); process.exit(1); });