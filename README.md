# whut-zhike

> 一个 AI agent skill：接入你的 agent 后，一句"帮我把智课作业做完"，读题、填答、校验、提交、看视频刷时长这些繁琐事就全交给它了。

## 通过什么原理完成什么工作

**原理：不碰你的鼠标键盘，靠 Chrome DevTools Protocol（CDP）驱动一个独立的 Edge 实例，在页面内部用 JS 完成一切操作。**

它和"按键精灵"式的模拟器完全不同：

- **通信层**：agent 通过 CDP 连到 `--remote-debugging-port=9222` 的隔离浏览器，自动在多个标签页里给目标页面打分定位（卷子页 / 任务页 / 首页各走各的命令），不会点错页。
- **操作层**：读题是把页面 DOM（题干、选项、已填答案）结构化抓回来；填题是在页面内注入 JS——AntD 下拉菜单要读 React fiber 里的 `memoizedProps.onClick` 才点得动，简答题的 Draft.js 编辑器要走 `onChange(createEmpty())` 再 `insertText`，各控件各有一套真解。
- **对抗层**：平台有反调试脚本和后台标签冻结，驱动内置了自动断点恢复、`setWebLifecycleState('active')` 防冻结——全程不开 DevTools、不 reload 卷子页、不抢窗口焦点。
- **安全层**：`fill` 之后逐槽位精确比对，任何一处 `FAIL` 都停下；`submit` 必须先给你看答案摘要、等你明确说"提交"才动手，确认框打开后还会二次校验（平台重渲染会悄悄丢答案）。

一句话：**它替你"动手"，但答案对不对、交不交，决定权始终在你手里。**

## 可以完成哪些工作

**答题（7 种题型，混合卷按题识别）**：匹配、单选、多选、判断、填空、简答、附件上传。

**自主观看批量完成**：PPT / MP4 观看任务，每个标签页各自计满时长再点完成，MP4 倍速可加速累计（实测 51 个资源一次跑完，`ok=51 fail=0`）。

**已截止作业攻坚**：禁用按钮强点、时间回拨注入、API 抓包、页面内同源重放——解决"进不去"和"点了不算"。

**本地题库沉淀**：提交过的题自动存成本地 JSONL，下次遇到同题直接命中生成答案文件，不依赖任何第三方服务。

**课程资源抓取与文本化**：跨课程列出待办与截止时间，下载 PPT/PDF/DOCX 原件并抽成文本；还能在不打开卷子的情况下读题，避免白启动计时。

**诊断与抓包**：页面状态体检、逐题 DOM 探针、API 请求记录，遇到平台改版能自己排查。

不支持：排序、编程、题组、讨论帖（讨论帖对同学可见，不做自动化）。

## 怎么使用

### 方式一：接入你的 agent（推荐）

把整个文件夹放进 agent 的 skills 目录（MiniMax Code 放到 skills 文件夹，其他 agent 按 skill 规范安装），然后对它说：

```
帮我看看智课上还有什么作业，做完列个清单给我确认
```

agent 会自己调 `check → tasks → state → fill`，把答案摘要打给你看，你说"提交"它才交。

### 方式二：手动命令行

先起一个隔离浏览器并手动登录一次（保持运行，最小化没关系）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\whut-edge-profile"
```

典型闭环：

```bash
node scripts/whut.mjs check                 # 健康检查：登录态、题目数、状态
node scripts/unlock.mjs goto "<paperUrl>"   # 打开卷子（已截止的也能开）
node scripts/quiz.mjs prompt                # 出待答清单，交给 AI 或人解
node scripts/whut.mjs fill answers.json     # 填 → 逐槽位校验
node scripts/whut.mjs submit answers.json   # 人工核对后提交
node scripts/quiz.mjs save answers.json     # 沉淀进题库
node scripts/resources.mjs tasks --due 2026-11-26                 # 看哪天有什么要交
node scripts/resources.mjs get 第七章 --course <课程> --text        # 抓课件原件并转文本
```

环境要求：Node.js 22+（需全局 WebSocket）。全部命令与参数见 [SKILL.md](SKILL.md)，踩坑实录见 [references/pitfalls.md](references/pitfalls.md)。

## 边界

- **不生成答案**：题目本身要人或 AI 来解，这个工具只负责填、验、交。
- **不自动提交**：提交前强制人工复核。
- 不处理验证码/登录，需手动登录一次。

## 免责声明

仅供学习交流与个人课程流程自动化，请遵守所在学校/平台的规定；使用造成的账号限制、成绩问题等后果自行承担。

## License

[MIT](LICENSE)
