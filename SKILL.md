---
name: whut-zhike
description: Automate 理工智课 (whut.ai-augmented.com) quizzes and assignments in an isolated Edge instance via CDP — matching, multi-select, true/false, fill-in-the-blank, short-answer, single-choice and attachment questions, with exact-answer verification before submission. Also batch-completes 自主观看 tasks (PPT/MP4) with per-tab timers, opens ambiguous task cards by course + deadline, diagnoses 已截止/deadline-blocked papers, sniffs submission APIs, and keeps a local answer cache. Use when the user asks to answer/fill/submit 理工智课 or whut courses, to 完成自主观看/观看任务/watch 任务, or mentions 匹配题, 简答题, 单选题, 多选题, 判断题, 填空题, 附件, 作业/测练, 自主观看, 已截止, 题库, 抓包, CFA准则.
argument-hint: "<check|tasks|open-task|enter|state|probe|fill|submit|watch|unlock|quiz|sniff|clean|close> [args]"
license: MIT
compatibility: Node.js 22+ (global WebSocket) and Microsoft Edge/Chrome started with --remote-debugging-port=9222. Tested on Windows with Edge.
metadata:
  version: "1.3.0"
  platform: "whut.ai-augmented.com"
  language: "zh-CN"
---

# 理工智课自动答题

Drive `whut.ai-augmented.com` through CDP against a **separate Edge instance**. The agent reads
questions, fills answers, verifies them exactly, and submits only after the user approves.

## Hard rules

1. **Review before submit.** Fill → print the answer summary → wait for the user's explicit
   "提交" → `submit`. Never auto-submit.
2. **Never use OS-level input.** No pyautogui, no coordinate clicking on the user's desktop.
   Everything goes through CDP addressed to the isolated tab.
3. **Never open DevTools** on the site and **never `Page.reload` a paper page** — the anti-debug
   script redirects it to `about:blank`.
4. **Target the right tab.** Paper commands hit `/course_paper/`; task commands hit
   `/app/jx-web/mycourse`; `/resource/` is only for `enter`. The script scores tabs automatically.
5. **讨论帖子不自动化**：讨论任务对其他同学可见、需要观点判断，除非用户明确要求。
   **自主观看可以用 `watch.mjs`**，但只在用户点名要做观看任务时才跑；它是"打开 → 计满时长 → 点完成"，
   不做任何内容判断。

## Install and health check

Start a dedicated browser (Windows example; any Chromium browser works):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\whut-edge-profile"
```

Log in manually once and keep the instance running. Minimizing is fine; closing it stops
automation. Then from the skill directory:

```bash
node scripts/whut.mjs check
```

`check` reports `{ok, url, title, kind, loggedIn, questions, type, status, attempts, targets}`.
`kind` is `home` / `resource` / `paper` / `blank`. Run it first after any break.

All commands below are `node scripts/whut.mjs <cmd>`; paths are relative to this skill directory.

## Release check

```bash
node scripts/validate.mjs   # manifest, license, references, no personal data, JS syntax
node scripts/whut.mjs check # live CDP health
```

`validate.mjs` is the publish gate: 17 checks covering the frontmatter, name/directory match,
description length and triggers, license file, referenced files, personal-data/absolute-path scan,
and `node --check`. It exits non-zero on any failure.

## Answer file format

```json
{ "type": "match",  "answers": { "1": ["a","b","c","d","e","f"], "2": ["a","b","c","d"] } }
{ "type": "short",  "answers": { "1": "简答题答案文本……" } }
{ "type": "choice", "answers": { "1": "D", "2": "A" } }
{ "type": "multi",  "answers": { "1": ["A","C","D"] } }
{ "type": "judge",  "answers": { "1": "正确", "2": "错误" } }
{ "type": "gap",    "answers": { "1": ["第一个空","第二个空"] } }
{ "type": "attach", "answers": { "1": ["C:\\path\\report.pdf"] } }
```

A bare `{ "1": ..., "2": ... }` object is accepted; each question's type is auto-detected, so a
mixed paper can omit `type` (or pass `"mixed"`). Matching questions may have 4, 5, or 6 slots — the
letter array length must equal the slot count. Judge accepts `正确/错误`, `对/错`, `true/false`, `T/F`,
`√/×`, or `A/B`. Gap arrays are positional. Attach takes absolute local paths and waits up to 90 s
for the upload names to appear. See `references/answers-format.md` for a schema and worked examples.

## Workflow

```bash
node scripts/whut.mjs home
node scripts/whut.mjs tasks --all
node scripts/whut.mjs open-task "CFA准则-匹配题-2"
node scripts/whut.mjs enter "CFA准则-匹配题-2"     # optional task name disambiguates tabs
node scripts/whut.mjs state
node scripts/whut.mjs probe          # if kind is mixed/unknown, dump per-question controls

# solve the questions, write answers.json, then:
node scripts/whut.mjs fill answers.json
# show the summary to the user and WAIT for approval
node scripts/whut.mjs submit answers.json
node scripts/whut.mjs clean --resources   # optional: drop task-detail tabs
```

`state` output is per question, with `type` on each entry and `kind` = the shared type or `mixed`:
- match: `{ rows:[{row,left,tags}], options:[...] }`
- short: `{ answer }`
- choice / judge: `{ options:[...], checked }`
- multi: `{ options:[...], checked:[...] }`
- gap: `{ blanks:[{index,value,placeholder}] }`
- attach: `{ files:[...] }`

`fill` / `submit` print per-slot `OK`/`FAIL` and exit code 2 on any mismatch. `submit` refuses to
click unless every question is covered with the expected slot count, then re-checks after the
confirmation dialog opens (the platform re-renders from form state and can drop unsynced answers).

## 自主观看任务（watch.mjs）

`scripts/watch.mjs` 负责"打开资源 → 计满观看时长 → 点我完成任务"，不读题、不做内容判断。
只在用户明确要求完成观看任务时使用；讨论任务仍然不自动化。

```bash
node scripts/watch.mjs list [--course 课程] [--kind watch|homework|discuss|any] [--due "2026-11-25 23:59"]
node scripts/watch.mjs open "<标题>" [--course 课程] [--kind ...] [--due ...]   # 精确定位一张卡片
node scripts/watch.mjs run  [--course 课程] [--due "2026-11-25 23:59"] [--batch 4] [--limit 50]
                            [--ppt 130] [--rate 16] [--deadline 180]
node scripts/watch.mjs status ["<标题>"]      # 读当前 /resource/ 标签的完成状态
```

`list` 会顺带打开任务抽屉并切到"显示全部任务"，`kind` 取自卡片 class：
`ta_homework` / `ta_watch` / `ta_discuss`。因为作业卡标题常常都叫"作业/测练"，按
`--course` + `--due` 定位比按标题可靠。

判定规则（实测）：

- **PPT/文档**：第一次点"点我完成任务"开始计时，必须连续停留满 2 分钟，再点一次才算完成。
  提示为"已学习 N 秒，连续观看时间未达要求，至少观看 2 分钟"。
- **MP4**：按播放进度计，显示"已观看:NN%"。倍速播放（16× 已验证）能加速累计，
  但**直接 seek 到末尾不计入**——进度来自真实播放的心跳。
- 每个标签页必须**各自计时**：多标签并行没问题，但用"统一等 130 秒再逐页点击"会失败，
  因为各页计时起点不同。脚本给每个 tab 记 `startedAt`，到自己的点才点它自己的按钮。
- 已截止的任务点按钮会提示"任务已截止，无法设为完成"，脚本会立即停止重试并把该提示带进结果。
- 所有点击都是元素级（React fiber 的 `memoizedProps.onClick`），绑定 `targetId`，
  不按坐标、不抢焦点，所以多标签不会点错页。

标签页卫生：Edge 在**最后一个标签页关闭时会直接退出**，脚本维护一个"保活首页标签"，
关任何页面前先确认它还在；创建失败就宁可不关。手工操作时也别把最后一个标签清掉。

## Commands

| Command | Purpose |
|---|---|
| `check` | Health report: tab kind, login, questions, status, attempts |
| `list` | List CDP page targets |
| `home` | Navigate to the course list |
| `tasks [--all]` | Open 待完成任务 drawer; `--all` also unchecks 仅显示可完成（只列 `ta_homework`，全量用 `watch.mjs list`） |
| `open-task "<name>"` | Click a task link (opens drawer if needed)；标题重复时改用 `watch.mjs open --course --due` |
| `enter ["<name>"]` | Click 点击进入任务>>> and print the new paper URL |
| `clean [--resources]` | Dedupe tabs by URL; `--resources` closes every `/resource/` task tab |
| `close "<substring>"` | Close page tabs whose URL or title matches |
| `state` | Scrape stems, items, options, current answers |
| `probe` | Per-question DOM controls, classes, options, blanks, files, React prop summary |
| `fill <file\|json>` | Fill any supported type, mixed papers included, and verify |
| `submit <file\|json>` | Exact verify → confirm → submit → wait for success → dismiss |
| `clear` | Reset answers before refilling (match/short; other types unsupported) |
| `status` | Paper URL, header, 状态, question count |
| `unfreeze` | Force the tab active and test timers |
| `dismiss` | Close 提交成功 / confirm modal |
| `eval`, `eval-file`, `click`, `goto` | Ad-hoc escape hatches |

`watch.mjs` 有独立的 `list` / `open` / `run` / `status`，见上一节。

`CDP_MATCH` overrides tab selection (any substring of the target URL). `CDP_PORT` overrides 9222.

## What the driver handles

- Tab scoring by mode (`paper` / `resource` / `home` / `auto`) plus optional task-name title match.
- Anti-debug: `Debugger.enable` + `setSkipAllPauses` + auto-resume on `Debugger.paused`.
- Hidden-tab freeze: `Page.setWebLifecycleState({state:'active'})` and focus emulation, without
  `Page.bringToFront` (no focus theft).
- AntD `Select`: reads the option node's React fiber and invokes `memoizedProps.onClick`; native
  events cannot reach portal content. Slots are cleared via rc-select `setState({value: []})`.
- Draft.js: clear via the editor's `onChange(EditorState.createEmpty())`, then focus and one
  `Input.insertText` (`execCommand` duplicates; select-all + Backspace only deletes one char).
- Per-question type detection from container classes (`.question_multiple_subject`,
  `.question_estimate_subject`, `.question_gap_subject`, `.question_attach_subject`, …), so mixed
  papers no longer hinge on one global type.
- AntD radios/checkboxes: real click on the label by option index, verified via `:checked`; judge
  answers are mapped from `正确/错误`, `对/错`, `T/F`, `√/×`, or `A/B`.
- Gap: native value setter + `input`/`change`, falling back to focus + `Input.insertText`, then
  reading every textarea back for exact comparison.
- Attach: `DOM.setFileInputFiles` on the question's file input, then polls the rendered file names
  for up to 90 s.
- `scrollSmart`: finds the nearest `overflow-y:auto/scroll` ancestor, sets `scrollTop` with
  `scroll-behavior:auto`, re-measures up to 5× (fixes off-screen submit buttons).
- Tab hygiene: `open-task` closes stale `/resource/` tabs of the same course after the new one opens,
  `enter` closes other resource tabs of that course, and `clean` / `close` handle leftovers. Drafts
  live server-side, so closing a task tab does not lose filled answers.
- Graceful WebSocket close before exit (avoids a libuv assertion on Windows).

## Validation status

Verified against the live site: `check`, `home`, `tasks --all` (idempotent), `open-task`, `enter`
(named), `state` for match/short/choice, `status`, submit guards, graceful exit, and live
short-answer `fill → state → submit` submissions. The new `multi` / `judge` / `gap` / `attach`
paths (plus mixed-paper `state`, `probe`, `fill`, and submit-time verification) were validated
against a synthetic AntD fixture; run `probe` and treat any `FAIL` as a stop signal on the first
live paper of each new type. See `references/testing.md`.

2026-11 实盘：三份作业（6 道简答、4 判断 + 4 填空 + 5 单选、1 道四问案例）全部 `fill → submit`
成功；`watch.mjs run --batch 4` 一次跑完 51 个自主观看资源（PPT × 24、MP4 × 27），
`SUMMARY ok=51 fail=0`，待完成任务计数从 56 降到 2。

## Known limitations

- Supported: 匹配、单选、多选、判断、填空、简答、附件上传、自主观看（PPT/MP4）。Not implemented:
  排序、编程、问卷/量表、题组（Group）、连线拖拽、讨论帖 — use `probe` + `eval` for these.
- `multi` / `judge` / `gap` / `attach` 已在实盘混合卷（4 判断 + 4 填空 + 5 单选）上通过，
  但仍是逐槽位精确校验：第一次遇到新题型先跑 `state` → `fill` → `state`，任何 `FAIL` 都停下。
- 自主观看的 MP4 必须真实播放累计（16× 可加速），seek 到末尾不计入；已截止的观看任务无法补做。
- No captcha/login handling; the user must log in manually.
- No PPT/PDF text extraction — exercise-based questions such as “第五章和第六章习题” must be
  answered from the textbook.
- No answer generation: the agent (or a human) still has to solve the questions. The driver only
  fills, verifies, and submits.
- No score/result scraping or second-attempt retry strategy.
- If every tab becomes `about:blank` (extreme anti-debug), run `home` or `goto` to recover.

## Troubleshooting

- `no page on :9222` — the isolated browser was closed; ask the user to reopen it.
- 批量跑一段时间后 CDP 突然消失 — 最后一个标签页被关掉，Edge 直接退出了。重新打开浏览器，
  `watch.mjs` 会自己维护保活首页；手工 `clean` 时也要留一个首页标签。
- PPT 一直提示"已学习 N 秒" — 说明计时被重置（页面刷新、或用了全局计时统一点击）。改用
  `watch.mjs run`，它按每个标签自己的 `startedAt` 计时。
- "任务已截止，无法设为完成" — 该观看任务已过截止时间，平台不允许补做，跳过即可。
- Command hangs — the tab is frozen; run `unfreeze`, then retry.
- `submit button outside viewport` — nested scroller; `scrollSmart` retries, then aborts instead
  of clicking blindly.
- `INCOMPLETE` — refill the named slots, then submit again.
- `kind: mixed` or an unexpected type — run `probe` and inspect `controls` / `classes`; do not fill blind.
- `Qn: unsupported type` — 排序/编程/题组/问卷 questions need manual handling or `eval`.
- Paper tab blank — `home`, `open-task`, `enter` again. Do not reload.

Detailed incident notes: `references/pitfalls.md`.

## 已截止作业（unlock.mjs）

`whut.mjs` 只负责读题、填答、提交，截止限制来自平台而不是驱动。`scripts/unlock.mjs` 是配套的攻坚入口，
四层机制与判定树见 `references/deadline-bypass.md`。

```bash
node scripts/unlock.mjs tasks                                    # 含已截止卡片：closed / clickable / disabledClass / href
node scripts/unlock.mjs force "任务名"                            # React onClick 优先，绕过禁用样式与遮罩直连任务
node scripts/unlock.mjs clock -1440                              # 时间回拨注入，须在导航前执行
node scripts/unlock.mjs sniff 40                                 # 抓 XHR/fetch：方法 / URL / 请求体 / 响应体
node scripts/unlock.mjs dump                                     # 扫全局与 storage 里的 deadline / endTime 字段
node scripts/unlock.mjs replay last submitTime=2024-06-01T10:00:00  # 页面内同源重放，可改 body 字段
```

打开已截止的卷子后，仍用 `whut.mjs state/fill/submit` 走原有流程；`unlock.mjs` 只解决"进不去"和"点了不算"。

## 脚本分层

```
scripts/
  whut.mjs        主驱动  check/home/tasks/open-task/enter/state/probe/fill/submit/clear/...
  watch.mjs       任务卡  list/open/run/status（按 course+due 定位，自主观看批量完成）
  unlock.mjs      攻坚    tasks/force/clock/sniff/dump/replay/eval/goto
  quiz.mjs        题库    dump/prompt/lookup/save/record/stats
  netlog.mjs      常驻抓包 → JSONL（只记 /api/ 与本站域名）
  x.mjs           页面内 JS 执行器（配合 scripts/*.js 探针）
  probe-paper.js  单卷诊断：ids / 时间窗 / answer_record_id / createRecord 结果
  lib/cdp.mjs     共享 CDP 层：目标打分、RPC、求值、抓包、反调试
  validate.mjs    发布闸门
```

五个入口共用 `lib/cdp.mjs`，不再各自复制连接与反调试代码。

## 推荐闭环（新卷子）

```bash
node scripts/unlock.mjs goto "<paperUrl>"     # 1. 打开卷子（已截止的也能开）
node scripts/quiz.mjs record                 # 2. 只看答题记录，不创建
node scripts/quiz.mjs prompt                 # 3. 出待答清单，交给 AI 或人
node scripts/quiz.mjs lookup > answers.json  # 4. 命中的直接成答案文件
node scripts/whut.mjs fill answers.json      # 5. 填 → 人工核对
node scripts/whut.mjs submit answers.json    # 6. 提交
node scripts/quiz.mjs save answers.json      # 7. 沉淀进本地题库
```

## 题库文件

`answers-cache.jsonl`，一行一条 `{k,stem,type,a,ts}`。`k` 是归一化题干（去空白与标点、转小写），
`lookup` 先精确后模糊（长度差 ≤ 20）。纯本地，可手工编辑或分享；`stats` 看条目与类型分布。

## 从「小雅答答答」吸收的三点

1. **`answer_record_id` 从 `task/flow/v2` 的 `task_flow_record` 读**，不调 `createRecord`。
   打开未截止卷子时页面会自动建记录（`limit_time` 从那一刻起算），先读后建能避免白白消耗一次机会。
2. **提交成功后把 Q/A 沉淀成库**。原脚本上传到云端并配 5 个备用域名，这里改为本地 JSONL，
   不依赖第三方服务，也不会把答案外发。
3. **题型按服务端枚举判定**，不依赖 DOM class：`1` 单选 / `2,3` 多选 / `4` 填空 / `5` 判断 /
   `6` 简答 / `7` 附件。DOM class 会随平台改版失效，接口枚举更稳。

## 准确性约束

- `fill` / `submit` 仍做逐槽位精确比对，任何 `FAIL` 都是停止信号；`submit` 在确认框打开后二次校验。
- `quiz.mjs` 的题型映射是实测标定值（见 `references/testing.md`），换题型先跑 `quiz dump` 对一眼 `rawType`。
- 已截止且无答题记录的卷子，`quiz record` 会直接给出结论，不要再去点 `createRecord` 试运气。