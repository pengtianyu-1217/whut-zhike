# Validation and release checklist

## Smoke tests (non-destructive)

Run these after installing or after any code change:

```bash
node scripts/validate.mjs        # 17 manifest/packaging checks
node --check scripts/whut.mjs
node scripts/whut.mjs check      # ok + kind + loggedIn
node scripts/whut.mjs list       # should show the isolated page targets
node scripts/whut.mjs home       # course list
node scripts/whut.mjs tasks --all
node scripts/whut.mjs tasks --all   # must be idempotent (drawer already open)

node scripts/watch.mjs list --kind any     # cards with kind / title / course / due
node scripts/watch.mjs list --course 某课程 # filtered, 0 cards is a valid answer
```

`submit` on a page with no questions must fail safely:

```bash
node scripts/whut.mjs submit '{"1":["a"]}'
# ERROR no questions detected; run enter first
```

## Verified against the live site (2026-10)

- `check`, `home`, `tasks --all` (twice), `open-task`, `enter "<name>"`, `state`, `status`
- Matching fill/submit: 8 questions × 4 slots (CFA准则-匹配题)
- Short-answer fill/submit: 9 Draft.js answers (作业/测练, 18 分)
- Single-choice fill/submit: 5 radios (练习-4 受托责任, 50 分)
- Live short-answer `fill → state → clear` cycle on 航空延误案 (Draft.js, 1 question)
- `clear` on short answers: 1/1 cleared, verified empty afterwards
- Exact-match guard with the confirmation dialog open
- Graceful WebSocket close (no libuv assertion on Windows)

## Verified against the live site (2026-11)

- 跨国公司金融管理 作业/测练：6 道 Draft.js 简答，`fill` 逐题 OK → `submit` 成功
- 财政学B 作业/测练：混合卷（4 判断 + 4 填空 + 5 单选）13 题全部 OK → `submit` 成功
- 保险学B 武汉金凰假黄金质押案：1 道四问案例（1266 字）→ `submit` 成功
- `watch.mjs run --batch 4`：51 个自主观看资源（24 PPT + 27 MP4）全部完成，
  `SUMMARY ok=51 fail=0`，平台待完成计数 56 → 2
- 失败路径：已截止的观看任务返回 `hint: "任务已截止，无法设为完成"` 并以退出码 2 结束

## Pending live rehearsal

The matching/short/choice mechanics and the live short-answer `fill → clear` cycle are validated.
What remains is one end-to-end `fill → submit` of the unified CLI on a graded task (or a practice
quiz with 2 attempts), with the user's approval:

1. `open-task "<name>"` → `enter "<name>"`
2. `state` → write `answers.json`
3. `fill answers.json` → verify all `OK`
4. show the user the summary, wait for approval
5. `submit answers.json` → expect `SUBMITTED {"success":true,...}` and a 提交成功 modal
6. `tasks --all` → the pending count should drop

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Command succeeded |
| 1 | Error (no target, no dialog, button outside viewport, …) |
| 2 | Answer mismatch / incomplete / submission not confirmed |

## Safety checks before publishing

- No course IDs, student names, or answer keys are hard-coded in `scripts/whut.mjs`.
- `submit` never runs without an answer file and never auto-fills missing answers.
- Discussions stay out of scope. 自主观看 only runs when the user explicitly asks, via
  `watch.mjs`, and it never judges content — it just opens, waits, and clicks 完成.
- `watch.mjs` keeps a keep-alive home tab and never closes the last page target.
- The script never calls `Page.bringToFront`, so it does not steal OS focus.
- The script never opens DevTools and never reloads a paper page.

## Verified against the live site (2026-11, resources.mjs)

同一周的第二次实盘，验证了新增的资源/任务/读题链路：

- `resources.mjs courses` → 11 门在修课程，`id + site_name` 正确。
- `resources.mjs tasks --due <date>` → 跨课程 125 条任务里筛出 41 条未完成，截止时间与任务页一致；
  两门课的 4 条作业/测练被准确识别（`type=7`，`finish=0`）。
- `resources.mjs files --course <课>` → 按 `queryCourseResources/v2` 还原章节路径；
  `get --text` 下载 19 份 PPTX（合计约 119 MB）并抽文本，`ok=19/19`。
  旧版 `.ppt` 经 LibreOffice 转 pptx 后同样能抽（47 页 / 1.7 万字）。
- `resources.mjs paper <node> --course <课>` → 不创建记录即可读出 4 道题（3 简答 + 1 单选）与分值，
  输出试卷页 URL；同一接口对已提交的卷返回 `answer_record`，可确认状态。
- `resources.mjs docx answer.html --out answer.docx` → 生成可上传的附件；`whut.mjs fill` 的 attach 分支
  上传后回读文件名 `OK`。
- 两份作业（38 分 4 题、10 分 5 题）完整走完 `paper → fill → submit`，服务端
  `task_flow_record` 出现 `flow_type=2`，页面头部仍显示「提交中」但记录已落库。

## 抽样卷判定（2026-11）

- 固定卷：`is_sampling=1`、`random_rule=null`，`queryStuPaper.questions` 就是全部题目。
- 抽样卷：`is_sampling=2`，`random_rule` 形如 10 单选 + 10 多选 + 10 判断，`questions[]` 是题库（100 题），
  `answer_record.sampling_questions` 是本场抽中的 30 个题号。
- 结论：抽样卷的第二次作答会重新抽题，不能复交上一套答案；`repetition` 只是次数上限。

## 提交后的接口判定（2026-11）

- `answer_record.status=2` + `answer_time` 有值 = 已提交；`score` / `actual_score` = 得分。
- `answer_record.answers` 是数组，`correct=2` 判对、`1` 判错，`score` 是该题得分。
- 页面头部「提交中」是前端状态，可能一直不刷新；不要 reload 卷子页去催它。
