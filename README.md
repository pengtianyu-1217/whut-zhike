# whut-zhike

理工智课（whut.ai-augmented.com）自动化 skill：在**独立 Edge 实例**里通过 CDP 驱动页面，完成读题、填答、逐槽位精确校验、提交前的强制人工复核，以及自主观看任务的批量计时完成。

## 它能做什么

- **答题驱动**（`whut.mjs`）：支持匹配、单选、多选、判断、填空、简答、附件上传，混合卷按题型逐题识别；`fill` 后逐槽位比对，任何 `FAIL` 都是停止信号，`submit` 在确认框打开后还会二次校验。
- **观看任务**（`watch.mjs`）：批量完成自主观看（PPT/MP4），每个标签页各自计时，倍速播放可加速累计；不读题、不做内容判断。
- **已截止攻坚**（`unlock.mjs`）：绕过禁用样式直连任务、时间回拨注入、API 抓包、页面内同源重放；只解决"进不去"和"点了不算"，答题仍走 `whut.mjs`。
- **本地题库**（`quiz.mjs`）：答题沉淀为本地 JSONL（`answers-cache.jsonl`），下次命中直接生成答案文件；纯本地，不外发答案。
- **抓包与诊断**（`netlog.mjs` / `probe-paper.js`）：常驻记录 `/api/` 请求到 JSONL，单卷诊断答题记录与时间窗。

## 硬性规则

1. **提交前必须人工复核**：fill → 打印答案摘要 → 等待明确的"提交"指令 → 才能提交，绝不自动提交。
2. **不动系统级输入**：没有 pyautogui、不按坐标点击，一切通过 CDP 送到隔离标签页。
3. 不在站点上开 DevTools、不 reload 卷子页（反调试脚本会把它重定向到 about:blank）。

## 环境要求

- Node.js 22+（需要全局 WebSocket）
- Microsoft Edge / Chrome（Chromium 均可），以远程调试端口启动：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\whut-edge-profile"
```

手动登录一次并保持该实例运行即可（最小化没关系，关掉就停止自动化）。

## 快速开始

```bash
node scripts/validate.mjs      # 发布闸门：manifest/引用文件/个人信息扫描/JS 语法
node scripts/whut.mjs check    # CDP 健康检查：tab 类型、登录态、题目数、状态
```

典型闭环（新卷子）：

```bash
node scripts/unlock.mjs goto "<paperUrl>"     # 打开卷子（已截止的也能开）
node scripts/quiz.mjs record                  # 只看答题记录，不创建
node scripts/quiz.mjs prompt                  # 出待答清单，交给 AI 或人
node scripts/quiz.mjs lookup > answers.json   # 题库命中的直接成答案文件
node scripts/whut.mjs fill answers.json       # 填 → 人工核对
node scripts/whut.mjs submit answers.json     # 提交
node scripts/quiz.mjs save answers.json       # 沉淀进本地题库
```

全部命令与参数见 [SKILL.md](SKILL.md)。

## 脚本分层

```
scripts/
  whut.mjs        主驱动  check/home/tasks/open-task/enter/state/probe/fill/submit/...
  watch.mjs       任务卡  list/open/run/status（按 course+due 定位，自主观看批量完成）
  unlock.mjs      攻坚    tasks/force/clock/sniff/dump/replay/eval/goto
  quiz.mjs        题库    dump/prompt/lookup/save/record/stats
  netlog.mjs      常驻抓包 → JSONL
  x.mjs           页面内 JS 执行器
  probe-paper.js  单卷诊断
  lib/cdp.mjs     共享 CDP 层：目标打分、RPC、求值、抓包、反调试
  validate.mjs    发布闸门（17 项检查）
```

深入资料见 `references/`：[pitfalls.md](references/pitfalls.md)（踩坑实录）、[deadline-bypass.md](references/deadline-bypass.md)（截止机制四层判定）、[answers-format.md](references/answers-format.md)（答案文件格式）、[testing.md](references/testing.md)（验证记录）。

## 已知限制

- 不支持：排序、编程、问卷/量表、题组、连线拖拽、讨论帖（讨论帖对同学可见，不自动化）。
- 不处理验证码/登录，需要手动登录；不提取 PPT/PDF 文本（教材习题需自己翻书）。
- **不生成答案**：本工具只负责填、验、提交，题目本身还是要人（或 AI）来解。
- MP4 观看必须真实播放累计（seek 到末尾不计入）；已截止的观看任务无法补做。

## 免责声明

本项目仅供学习交流与个人课程流程自动化，请遵守所在学校/平台的相关规定；对因使用本工具造成的账号限制、成绩问题等后果不承担责任。

## License

[MIT](LICENSE)
