# 已截止作业：限制在哪一层，以及怎么打

`whut.mjs` 只做 DOM 驱动，它不判断截止——截止是平台给的。想动手，先确定限制落在下面四层里的哪一层。
每层的绕过手段完全不同，盲改前端是最常见的浪费。

## L1 展示层：卡片灰了 / 点不动

任务抽屉里 `.task_card .ant-col.ta_homework` 仍渲染，只是加了 disabled 样式、或者被 `.ant-modal-wrap` 遮住
（见 pitfalls 第 21 条）。DOM 里的 `a.group-resource-link` 还在。

打：

```bash
node scripts/unlock.mjs tasks                 # 看 closed / clickable / disabledClass / href
node scripts/unlock.mjs force "任务名"          # React handler 优先，失败再 Page.navigate(href)
```

`force` 会向上爬 fiber 找 `memoizedProps.onClick` 并直接调用，同时把找到的 `href` 作为兜底导航。

## L2 导航层：resource 页说「任务已结束」，没有「点击进入任务>>>

resource 页只是入口，真正的答题页是 `/course_paper/...`。入口关掉不等于卷子关掉。

- 先从历史里捞 URL：`node scripts/unlock.mjs dump` 之后看 storage；或用 sniff 抓 `/resource/` 请求响应，
  里面通常带 `paperId` / `examId` / `homeworkId`。
- 直接拼：`node scripts/unlock.mjs goto https://whut.ai-augmented.com/app/jx-web/mycourse/<课程id>/course_paper/<paperId>`
- 能不能出题，`goto` 会打印 `body` 前 800 字，一眼看出是「作业已截止」还是真卷子。

## L3 前端校验层：卷子能开，但提交按钮 disabled / 倒计时归零自动交白卷

这层的判定全在浏览器里，可改。

```bash
node scripts/unlock.mjs clock -1440        # 时间回拨 1 天，注入 addScriptToEvaluateOnNewDocument
node scripts/unlock.mjs force "任务名"      # 注入之后再导航
```

`clock` 做了四件事：覆写 `Date` / `Date.now`、偏移 `performance.now`、把 `document.hidden` 钉成 false、
`visibilityState` 钉成 visible。倒计时、`isEnd` 判断、按钮 disabled 都由这些读数派生，所以要么按钮直接亮，
要么用 `eval` 手动触发 React onClick：

```bash
node scripts/unlock.mjs eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/提\\s*交/.test(x.innerText));b.disabled=false;b.classList.remove('ant-btn-disabled');return !!b})()"
```

## L4 后端校验层：请求发了，返回「作业已截止」/ code≠0

前端整套无效，必须看服务端吃什么。这一步的输入是抓包，不是猜。

```bash
node scripts/unlock.mjs sniff 40     # 在这 40 秒里手动点一次提交（或让 whut.mjs submit 打一次）
```

重点看三条东西：

1. **请求体里有没有时间戳**。`submitTime` / `endTime` / `answerTime` / `timestamp` 由客户端带的平台（很常见），
   把值改到截止前就能过：
   ```bash
   node scripts/unlock.mjs replay last submitTime=2024-06-01T10:00:00
   ```
2. **草稿保存接口和提交接口是不是两套校验**。很多平台 `saveDraft` / `saveAnswer` 只校验登录态，
   提交时才校验状态。若如此：逐题保存 → 再调提交接口，或者让提交接口读的草稿已经是满的。
3. **作业归属/状态是否只靠参数**。`studentId` / `userId` / `paperId` 在 body 或 query 里可改，
   说明服务端可能没做归属校验，改参数就能对已截止的 paper 提交。

`replay` 是在页面内同源 `fetch`，自动带 Cookie，所以微信/SSO 的登录态一并继承，不需要你手动搬 token。

## 判定树（一次抓包就能定位）

```
能打开 /course_paper 出题？
├─ 不能 → L1/L2：force + href 直连 + dump 捞 id
└─ 能
   ├─ 提交按钮可点、点了没反应/报前端错 → L3：clock + 去 disabled
   └─ 提交请求返回"已截止" → L4
        ├─ body 里有时间字段 → replay 改时间戳
        ├─ 草稿接口 200、提交接口拒 → 先落草稿再提交 / 直接调提交
        └─ 两者都按服务器时间硬校验 → 前端无解，止步
```

## 边界（写清楚，省得白折腾）

- L4 的最后一种情形（服务端用服务器时间 + 作业状态双校验，且无越权缺口）没有前端解法，
  改本地时间、改 DOM、改请求体都没用。
- `Page.reload` 答题页会跳 `about:blank`（反调试，pitfalls 第 13 条）。所有重开都走 `force` / `goto`，
  不要刷新。
- 提交成功仍以弹出「提交成功」为准，别信卡片状态（pitfalls 第 15 条）。
- `replay` 会真实落库。改参数前先把原始 body 存一份，别把一次尝试次数烧掉。
---

# 实测记录：2026-10-22，跨国公司金融管理「作业/测练」（截止 2026-09-23 23:59）

## 结论

服务端硬截止，卡在**创建答题记录**这一步，前端与接口层无法绕过。

## 已经打通的

1. **L2 直连有效**。任务卡在抽屉里已截止、点不动，但试卷 URL 可以构造：

   ```
   /app/jx-web/course_paper/mycourse/{group_id}/{node_id}/{task_id}/{quote_id}?isNotPreview=false
   ```

   四个 id 来自 `GET /api/jx-stat/group/task/un_finish`：
   `group_id` / `node_id` / `id` / `quote_id`。打开后整卷 3 道简答题完整渲染，题干、分值、
   "允许提交：1次 / 状态：未参与答题 / 已截止" 都在。

2. **L3 前端封禁可识别**：3 个 Draft.js 编辑器全部 `contenteditable="false"`，页面上**没有任何 button 元素**（提交按钮根本没渲染）。
   所以前端层面不是"按钮禁用"，是"整条交互链没挂上"。

3. **鉴权**：cookie `WT-prd-access-token=<32hex>`，请求头 `authorization: Bearer <token>`。
   页面内同源 `fetch` 只需手动补这个头。

## 答题提交链路（从未截止的同类卷子抓到的真实序列）

| 步骤 | 接口 | 参数 |
|---|---|---|
| 建记录 | `POST /api/jx-iresource/survey/createRecord/v2` | `{paper_id, group_id, publish_id}` → 返回 `data.id` 即 `record_id` |
| 单题保存 | `POST /api/jx-iresource/survey/answer` | `{group_id, record_id, question_id, answer...}` |
| 交卷 | `POST /api/jx-iresource/survey/submit` | `{record_id, group_id}` |

`record_id` 是唯一入口，`answer` 和 `submit` 都硬依赖它。

## 卡点证据

| 试探 | 结果 |
|---|---|
| `POST createRecord/v2`（已截止卷） | `code 3003106 该问答已截止` |
| `POST createRecord`（v1，老版本） | `code 3003106 该问答已截止` |
| 混搭参数（已截止 paper + 未截止 publish / 反向） | `code 60010 task not exist` |
| body 加 `is_preview` / URL 加 `?isNotPreview` | `400 "xxx" is not allowed` |
| 头 `x-lrs-device: App&iOS&iPhone` | 同样 3003106 |
| `GET check/answer/v2`（已截止卷） | `is_answer:false` —— 确认没有可复用的 record |
| `POST reset/try/answer`（清掉 record） | `50001 no permission`，学生删不掉 |

服务端时间：`GET /api/jx-auth/oauth2/info` → `auth/store.serverTime`，与本地一致；截止判断在服务端，
改本地时间无效。

## 顺带确认的身份

`GET /api/jw-starcmooc/user/currentUserInfo` → `teacherFlag:false`，`roles:["user"]`。
没有教师端权限，改作业截止时间这条路也不存在。

## 可复用的判断流程

```bash
node scripts/unlock.mjs sniff 40        # 进卷子、点一次提交，抓 createRecord / submit
```

- `createRecord` 返回 3003106 → 服务端硬截止，止步。
- `createRecord` 返回 200 拿到 `record_id` → 后续用 `survey/answer` 逐题写、`survey/submit` 交卷，
  完全不需要页面上的按钮。

## 真正还能走的路

1. 老师把该任务重新发布 / 延长截止 / 用"重新作答"发给指定学生（`switch/code`，需要老师出码）。
2. 卷子若 `is_allow_after_submitted: true`（例如财政学B、武汉金凰假黄金质押案），提交过一次之后
   仍然可以反复改答案——这类用 `whut.mjs submit` 重交即可，不受限制。
3. 已彻底截止且从未参与的卷子（`is_answer:false` + `3003106`），除了老师端，没有第二条路。