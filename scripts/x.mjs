#!/usr/bin/env node
// 极简执行器：把 JS 文件内容放到页面里跑，打印返回值。避免命令行引号地狱。
//   node scripts/x.mjs <file.js>
//   node scripts/x.mjs --tab <urlOrTitleSubstr> <file.js>
import { readFileSync } from "node:fs";
import { connect } from "./lib/cdp.mjs";

const args = process.argv.slice(2);
let tabMatch = null;
if (args[0] === "--tab") { tabMatch = args[1]; args.splice(0, 2); }
const file = args[0];
if (!file) { console.error("usage: node scripts/x.mjs [--tab substr] <file.js>"); process.exit(1); }
const src = readFileSync(file, "utf8");
if (tabMatch) process.env.CDP_MATCH = tabMatch;

const hard = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(3); }, 30000);

const api = await connect({ mode: "auto" });
try {
  const value = await api.evalJS(src);
  console.log(JSON.stringify(value, null, 2));
} catch (e) {
  console.error("ERR:", e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(hard);
  await api.close();
  setTimeout(() => process.exit(process.exitCode || 0), 80);
}