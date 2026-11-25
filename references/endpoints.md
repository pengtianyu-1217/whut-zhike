# 课程资源、任务与试卷接口（2026-11 实测）

所有接口都在 `https://whut.ai-augmented.com` 下。认证只有两样东西：

- Cookie `WT-prd-access-token=<token>`
- 请求头 `Authorization: Bearer <token>`（就是上面那个 cookie 的值），外加 `x-language: zh-CN`

**不需要页面 JS。** 资源查看页会加载 ow365 在线预览 iframe，`Runtime.evaluate` 在那种页面上会挂起；
卷子页有反调试。所以取数一律走：

1. CDP `Network.getCookies({ urls: ["https://whut.ai-augmented.com/"] })` —— 页面卡死也能拿到 cookie；
2. Node 原生 `fetch` + 上面的头。

## 接口一览

| 用途 | 请求 | 关键返回 |
|---|---|---|
| 我的课程 | `GET /api/jx-iresource/group/student/groups?time_flag=1` | `data[]`：`id`（group_id）、`site_name`、`site_id` |
| 课程全部节点 | `GET /api/jx-iresource/resource/queryCourseResources/v2?group_id=` | `data[]`：`id/parent_id/path/name/type/quote_id/resource_type` |
| 单节点详情 | `GET /api/jx-iresource/resource/queryResource/v3?node_id=&group_id=` | `data.resource`（作业节点里就是整张试卷，含 `questions`） |
| 待办任务 | `GET /api/jx-stat/group/task/queryTaskNotices?group_id=&role=1` | `data.student_tasks[]`：`node_id/task_id/start_time/end_time/finish` |
| 任务流程/答题记录 | `GET /api/jx-iresource/survey/course/task/flow/v2?node_id=&group_id=` | `data.task`（含 `paper_publish_id`）、`task_flow_record[]` |
| 试卷与题目 | `GET /api/jx-iresource/survey/course/queryStuPaper/v2?paper_id=&group_id=&node_id=` | `data.questions[]`、`data.publish_record`、`data.answer_record` |
| 资源下载地址 | `GET /api/jx-oresource/cloud/file_down/<quote_id>/v2?filename=<名字>` | `data.download_url`（OSS 签名直链）、`data.size` |

### 节点类型

`type`：`1/2` 目录、`6` 资源文件、`7` 作业/测练、`8` 讨论、`9` 视频。
`resource_type`：`2` 文件、`11` 试卷。

### 两个 URL 模板

```
资源页    /app/jx-web/mycourse/<group_id>/resource/<node_id>
试卷页    /app/jx-web/course_paper/mycourse/<group_id>/<node_id>/<publish_id>/<paper_id>?isNotPreview=false&site_id=<site_id>
```

`publish_id` 取自 `flow/v2` 的 `data.task.paper_publish_id`；`paper_id` 取自 `queryResource/v3` 的
`data.resource.id`。

## 下载：只认 v2

- ✅ `cloud/file_down/<quote_id>/v2` —— 返回明文 JSON，`data.download_url` 是带签名的 OSS 直链，另有 `size`、
  `filename`。签名短时有效，拿到就下，不要缓存。
- ❌ `cloud/file_access/<quote_id>` —— **预览**接口。PPT/PDF 这类会返回一个 307 字节的 HTML：
  「该资源不支持预览」；带 `?download=1` 会报参数不允许。不要用它判断“能不能下载”。
- ❌ `cloud/file_down/<quote_id>/v3` —— 返回的是加密串（base64 包着 wasm 编码的 JSON），要跑前端
  `release-*.wasm` 才能解。没必要。
- ❌ `cloud/file_down/<quote_id>` —— 已废弃（`3003182 该接口已废弃`）。

## 试卷：先读后开

`queryResource/v3` 返回的 `resource.questions` 就是题目本身，配合 `queryStuPaper/v2` 可以**在不打开卷子的
情况下**把题干、选项、分值、题型全部读出来。这一点很重要：

- 打开卷子页会触发 `POST /api/jx-iresource/survey/createRecord/v2`，`limit_time` 从那一刻开始倒计时；
- 离线读完题、写好答案，再一次性打开 → `fill` → `submit`，不浪费计时。

`queryStuPaper/v2` 返回 `data.answer_record` 时说明已有答题记录；为 `null` 表示还没开始。

## 抽样卷的判定

看 `queryStuPaper/v2` 的 `data`：

- `is_sampling`：`2` 表示抽样卷，`1` 表示整卷固定；
- `random_rule`：抽样卷会给出每题型的抽题数与分值，比如
  `[{ "type": "1", "number": 10, "score": 1 }, ...]`；
- `questions[]` 的长度是**题库总量**，`answer_record.sampling_questions` 才是本场抽中的题号。

三者合起来就能判断“再来一次会不会换题”：只要 `is_sampling=2` 且题库量远大于抽样量，第二次作答就是
另一套题，不能拿上一套答案重交。

## 提交后的判定

页面头部可能长时间停在「提交中」，不要据此判断失败。以接口为准：

- `queryStuPaper/v2` → `data.answer_record.status = 2` 且 `answer_time` 有值 = 已提交；
- `answer_record.score` / `actual_score` 是得分，`answer_num` 是题数；
- 逐题记录在 `answer_record.answers`（数组，不是字符串）：`correct` 为 `2` 判对、`1` 判错，`score` 是该题得分；
- `task_flow_record` 里 `flow_type=2` 的记录 = 提交动作。
