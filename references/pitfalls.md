# 理工智课 CDP 踩坑记录

这些问题是实际调试中逐个遇到的，按出现顺序记录，附可复现的修复方式。

## 1. 有两个标签页，状态会互相覆盖

点击「立即开始答题」会在独立 Edge 里**新开一个** `/course_paper/` 标签页，原来的
`/mycourse/.../resource/...` 标签页仍然存在。两个页面都可能有题目 DOM（或一个为空），
如果不锁定 URL，每次 CDP 调用可能连到不同标签页，读到的答案忽有忽无。

修复：连接时只选 URL 包含 `course_paper` 的 page target。

```js
list.find((t) => t.type === 'page' && t.url.includes('course_paper'))
```

## 2. 隐藏标签会被浏览器冻结

Edge/Chrome 会冻结后台标签页。冻结后：

- 同步 `Runtime.evaluate` 仍然能返回；
- `setTimeout` / `requestAnimationFrame` 不再执行；
- 任何 `awaitPromise: true` 且内部有 `sleep` 的求值会**永久挂起**；
- 页面倒计时停住。

修复：连接后立刻设置页面为活跃，并模拟焦点。**不要用 `Page.bringToFront`**，那会把
独立 Edge 窗口拉到前台、抢走用户的系统焦点。

```js
await send(ws, 'Page.enable');
await send(ws, 'Page.setWebLifecycleState', { state: 'active' });
await send(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true });
```

脚本里的 `unfreeze` 命令就是做这件事。

## 3. 反调试会触发 `debugger` 暂停

站点带有周期性 `debugger;` 检测。CDP 连接本身算作已附加调试器，于是页面会被暂停。
表现同样是异步求值挂起。

修复：

```js
await send(ws, 'Debugger.enable');
await send(ws, 'Debugger.setSkipAllPauses', { skip: true });
// 同时监听 Debugger.paused 事件，收到就发 Debugger.resume
```

`setSkipAllPauses` 只对之后发生的暂停生效；如果页面已经暂停，再发一次
`Debugger.resume`（未暂停时它会报错，忽略即可）。

## 4. 绝对不要打开 DevTools

在页面里按 F12 / 右键检查会让反调试脚本把标签页跳到 `about:blank`。所有调试都走
外部 CDP，不要在页面内开控制台。

## 5. 不要用系统级鼠标键盘

用 `pyautogui` / 系统坐标点击会移动用户真实光标、抢焦点，而且窗口位置一变就点错。
一次误点直接把 URL 输进了别的窗口。只允许 CDP + 页面内 JS。

## 6. AntD 下拉选项在 React root 之外，合成事件无效

匹配题的答题区是 AntD `Select`（`mode: multiple`）。下拉菜单通过 portal 挂到
`document.body`，而 React 的事件委托监听器挂在应用 root 容器上。因此：

- `element.dispatchEvent(new MouseEvent('click', {bubbles:true}))` 能打开下拉框
  （触发器在 root 内），但**点不到 portal 里的选项**；
- `element.click()` 同样无效。

修复：直接调用选项 DOM 节点上 React fiber 的 `memoizedProps.onClick`。

```js
const key = Object.keys(item).find((k) =>
  k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
);
const props = item[key].memoizedProps;
props.onClick({ preventDefault() {}, stopPropagation() {}, nativeEvent: {} });
```

选项的 React props 只有 `onClick` / `onMouseEnter` / `onMouseLeave`，没有 value。
字母与选项的对应关系用选项文本前缀判断：`(a)`、`(b)`、`(c)`、`(d)`。

## 7. 标签上的删除按钮点不掉

`.ant-select-selection__choice__remove` 的 `<span>` 上没有可枚举的 React fiber，
`synthetic click`、`.click()`、`mousePressed` 都试过，均无效。

修复：找到 rc-select 的类实例，直接把内部值清空：

```js
const inst = getInst(sel);           // fiber.stateNode.state.value 是数组
inst.setState({ value: [], open: false });
```

然后再走正常选项点击路径选新答案。**先清空再选**还能保证 `onChange` 一定触发。

## 8. 提交弹窗会重刷表单状态，可能吃掉答案

点「提交」打开确认框时，页面会用表单状态重新渲染题目列表。如果某个空的
`onChange` 没有真正传到父表单，这个答案会在弹窗打开后消失（实测 Q1-C 消失，
32 → 31）。

修复流程：

1. 打开确认框后**再次读取全部 32 个空**；
2. 若有空缺失，点「取 消」，用 `fill` 重新选该空；
3. 重新打开确认框，确认仍是 32/32 后再点「提 交」。

脚本的 `submit` 命令内置了这个检查，不完整会以退出码 2 结束并列出缺失项。

## 9. 读状态时注意区分「显示值」和「表单值」

- 标签文本来自 rc-select 内部 state；
- 提交时用的是父表单 state；
- 二者可能不同步（见第 8 条）。

所以校验必须在**确认框打开时**做，而不是在填写完立刻做。

## 10. 其他实用细节

- 匹配题每题 4 个空，共 8 题 = 32 个空；5 分/题，总分 40。
- 题目标题在 `.question`，左侧项在 `.left_item_panel .item .left_content`，
  答题区在 `.left_answer`。
- 选项下拉的 id 通过触发器的 `aria-controls` 获取：
  `document.getElementById(trigger.getAttribute('aria-controls'))`。
- 提交按钮文本是「提交」（无空格）；确认框按钮是「提 交」「取 消」（有空格）。
- 页面头部「未提交」标记消失、状态变为「提交中」，且出现「提交成功」弹窗，
  即表示提交已受理。
- 提交按钮用 CDP 真实鼠标事件点击（`Input.dispatchMouseEvent`）最可靠；前提是
  页面已通过第 2 条恢复活跃，否则事件会挂起。

## 11. 简答题是 Draft.js，`execCommand` 会写两遍

简答题答题区不是 `textarea`，而是 Draft.js 的
`.public-DraftEditor-content[contenteditable="true"]`。直接设置 `innerHTML` 无效；
`document.execCommand('insertText', ...)` 会被 Draft.js 的 beforeinput/input 处理两次，
文字重复一遍。

可靠写法：

1. `ed.focus()`
2. 用 Range 选中编辑器全部内容
3. 通过 CDP 发一次 Backspace 清空
4. 通过 CDP 发一次 `Input.insertText({ text })`
5. 读 `ed.innerText` 校验

注意题目题干本身也是 Draft.js 编辑器（`contenteditable="false"`），选择器必须带
`[contenteditable="true"]`。

## 12. 单选题是 AntD Radio，点 label

选项结构为 `label.ant-radio-wrapper > span.ant-radio > input.ant-radio-input[value]`。
用真实鼠标点击 label 中心即可选中；选中后用 `input.ant-radio-input:checked` 校验
value 是否等于目标选项的 value。

## 13. 不要刷新答题页

对 `course_paper` 页面执行 `Page.reload` 会被反调试脚本重定向到 `about:blank`。
提交后想确认状态，回到课程首页看“待完成任务”数量，或从资源页重新进入，不要刷新答题页。

## 14. scrollIntoView 是平滑滚动，取坐标前要等

页面的滚动是平滑的。`btn.scrollIntoView({block:'center'})` 后立刻
`getBoundingClientRect()` 仍会拿到视口外的旧坐标（实测 y=2633，视口只有 768），
点击就落空。等 600–700ms 再取坐标。

## 15. 同一课程可能有多份同名/相似任务

任务抽屉里会出现 `CFA准则-匹配题`、`CFA准则-匹配题-2` 等同名系列，以标题和截止日期
区分。提交后“待完成任务”计数会变化，但“显示全部任务”列表可能仍显示旧卡片，
以成功弹窗和计数变化为准。

## 16. 页面用的是内部滚动容器，scrollIntoView 不够

长卷子（如 9 题简答）的提交按钮在内部滚动容器里。`scrollIntoView({block:'center'})`
配合平滑滚动后立刻取坐标，仍可能得到视口外的值（实测 y=2633、y=944，视口只有 768）。

`scrollSmart` 的做法：

1. 从元素向上找最近的 `overflow-y: auto|scroll` 且 `scrollHeight > clientHeight` 的祖先；
2. 临时把该容器的 `scroll-behavior` 设为 `auto`；
3. 按“元素相对容器顶部 - (容器可视高度 - 元素高度)/2”调整 `scrollTop`；
4. 等 120ms 重新测量，最多 5 次，直到元素完全进入视口。

提交前必须确认按钮坐标落在 `0 ≤ y ≤ innerHeight` 内，否则不要点击。

## 17. 任务抽屉的结构

- 首页 `.square`（文本包含“待完成任务”）打开任务抽屉；
- 默认勾选“仅显示可完成任务”，可能隐藏部分任务；
- `显示每周任务` / `显示全部任务` 是 `label.ant-radio-wrapper`；
- 每张任务卡是 `.task_card .ant-col.ta_homework`：
  - 标题：`a.group-resource-link`
  - 课程：`a.group_link.inline`
  - 截止：`.xy_taskCard_bottom span`
  - 类型：`.ta_taskType`

抽屉内的计数与列表可能受筛选影响；提交是否成功以“提交成功”弹窗为准。

## 18. 多标签页选择

同一时刻可能存在：`/course_paper/` 答题页、`/resource/` 资源页、`/app/jx-web/mycourse`
课程列表页、`about:blank`。不同命令要连不同的页：

- 答题命令（state/fill/submit/status/enter）：优先 `/course_paper/`；
- 任务命令（home/tasks/open-task）：优先 URL 恰好是 `/app/jx-web/mycourse` 的页
  （不能只看是否包含 `mycourse`，因为 `/resource/` 的 URL 里也有）；
- 资源页优先级最低，`about:blank` 直接排除。

## 19. 不同任务类型的题量与控件

- 匹配题：每题 4–6 个空，选项是 AntD multiple Select，字母 a–f；
  同一题的所有空共用一组候选选项。
- 简答题：9 题 × 2 分 = 18 分，Draft.js 富文本，编辑器在
  `.public-DraftEditor-content[contenteditable="true"]`。
- 单选题：5 题 × 10 分 = 50 分，AntD Radio。
- 提交次数可能是 1 次或 2 次，提交前先读页头的“允许提交：N 次”。

## 20. Draft.js 清空：全选 + Backspace 不可靠

`range.selectNodeContents(ed)` 后用 CDP 发 Backspace，实测只删掉一个字符（Draft.js
重渲染把选区收起到了末尾）。清空整段要直接操作 Draft.js 状态：

```js
const fiber = getFiber(editorDom);        // 从 .public-DraftEditor-content 往上找
// 直到 memoizedProps 同时含 editorState 和 onChange
props.onChange(props.editorState.constructor.createEmpty());
```

实测 277 字符 → 0。插字仍用一次 `Input.insertText`；`document.execCommand('insertText')`
会被处理两次。题干本身也是 Draft 编辑器（`contenteditable="false"`），选择器必须带
`[contenteditable="true"]`。

## 21. 任务卡链接点不到：被弹窗遮罩挡住

任务抽屉是 `.ant-modal-wrap`，任务卡在弹窗内部的可滚动区域里。卡片滚到下方时，
`document.elementFromPoint()` 会返回遮罩本身，真实点击落空（URL 不变）。

改为调用链接的 React 处理器：

```js
const a = [...document.querySelectorAll('a.group-resource-link')].find(...);
getFiber(a).memoizedProps.onClick(fakeEvt);
```

实测可直接导航到 `/resource/...`。真实点击只作为没有 handler 时的兜底。

## 22. `Debugger.paused` 必须持久监听

只在每次 `send()` 内部监听暂停事件不够：两次调用之间到达的暂停没有人 resume，
下一次 `Runtime.evaluate` 会永久挂起，页面随后被反调试清成 `about:blank`。

修复：

- 连接时在 WebSocket 上挂一个**常驻** `message` 监听器，收到 `Debugger.paused`
  就发 `Debugger.resume`；
- `prepare()` 里启用 `Debugger.setSkipAllPauses` 后，再连续发 3 次 `Debugger.resume`，
  清掉已经存在的暂停。

## 23. 退出前优雅关闭 WebSocket

`ws.close()` 后立刻 `process.exit()` 在 Windows 上会触发 libuv 断言：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
```

等 `close` 事件（或 600ms 超时）再退出，退出码保持 0。脚本里的 `closeWs()` 就是做这件事。

## 24. 自主观看有两种计时，判定方式不同

打开 `/resource/` 的任务页后，右上角是 `.ta_icon_btn` 里的「点我完成任务」，下面是「全屏预览」。

- **PPT/文档**：第一次点击开始计时，页面提示"已学习 N 秒，连续观看时间未达要求，至少观看 2 分钟"。
  停留满 2 分钟后再点一次，按钮变成「已完成」，页面出现「任务已完成」。
- **MP4**：页面显示「已观看:NN%」，播放进度就是判定依据。`video.playbackRate = 16` 实测有效，
  690 秒的视频四十来秒就能到 100%；但 `video.currentTime = duration - 3` 这类 seek **不会**
  改变已观看比例，平台只认播放心跳。

部分资源打开时会弹「文件预览确认 / 是否确认打开文件」，先点 `button.ant-btn`「确定」再计时，
否则预览 iframe（ow365 等）加载完成后页面重渲染，会把已走的计时清掉。

## 25. 多标签页必须各自计时（最容易踩的坑）

并行开多个观看任务是可行的，但**不能**"统一 sleep 130 秒，然后依次点每个页的完成按钮"：
每个页的计时起点是它自己第一次被点击的时刻，先后差几秒到几十秒，统一等待必然有一半失败，
而且失败页会显示"已学习 2 秒"，看起来像没点到。

正确做法：每打开一个页就记 `startedAt = Date.now()`，处理时只等
`126s - (now - startedAt)`，到点只点**它自己**的按钮。`watch.mjs run` 就是这个结构。

## 26. 多标签下不要用"按 URL 打分"的 click 命令

`whut.mjs click <selector>` 会按 URL 打分挑标签页，然后再用元素坐标点击。开了多个 `/resource/`
页时，打分结果可能不是你以为的那一页，"点我完成任务"就点到了别的任务上，表现为任务反复失败、
另一些任务莫名完成。

跨标签批量操作时：连接时用 `targetId` 精确指定，点击用元素级
`getFiber(el).memoizedProps.onClick(fakeEvt)` 或 `el.click()`，不要用坐标点击。

## 27. 关掉最后一个标签页 = 浏览器退出

隔离实例是 `--user-data-dir` 起的普通窗口，最后一个 page target 关闭后 Edge 进程直接结束，
后续所有 CDP 命令报 `no CDP on :9222`，已经填好的草稿虽然在服务端，但计时中的观看任务会作废。

`watch.mjs` 维护一个"保活首页标签"：关任何页前先 `ensureKeeper()`，创建失败或只剩一个页面时
宁可不关。手工用 `whut.mjs clean --resources` 时也要确认首页还在。

## 28. 已截止的观看任务无法补做

截止时间过了以后，点「点我完成任务」会提示"任务已截止，无法设为完成"，且卡片仍留在待完成列表里。
这不是脚本问题，立刻停止重试即可；`watch.mjs` 会把这个提示写进结果的 `hint` 字段。

## 29. 资源原件：预览接口不等于下载接口

`/resource/` 页把 PPT 交给 ow365 预览，页面里能看到 `/cloud/file_access/<quote_id>`，但那是**预览**接口：
PPT/PDF 会返回 307 字节的 HTML「该资源不支持预览」，带 `?download=1` 直接 400。

真正的下载接口是 `GET /api/jx-oresource/cloud/file_down/<quote_id>/v2?filename=<名字>`，返回
`data.download_url`（OSS 签名直链）和 `data.size`。`/v3` 是加密串（base64 + 前端 wasm 解码），`/v1` 已废弃报
`3003182`。别再一个个试路径了，直接用 `resources.mjs get`。

## 30. 资源查看页会挂起 Runtime.evaluate

`/resource/<group>/<parent>/<node>` 这类页会加载 ow365 的 iframe，之后 `Runtime.evaluate` 经常永久不返回
（不是超时，是排不上队）。所以在这类页上不要 eval，也不要指望 `whut.mjs state`。

取数一律：CDP `Network.getCookies` 拿 cookie → Node `fetch` + `Authorization: Bearer <token>`。
`resources.mjs` 全篇都是这个结构，`quiz.mjs` 那种 `ensurePageApi` 路线只适合卷子页。

## 31. 打开卷子就计时，读题不要开卷

访问 `course_paper` URL 会立刻 `POST /survey/createRecord/v2`，`limit_time` 从那一刻开始倒计时。
只想看题目的话用 `resources.mjs paper`：`queryResource/v3` 的 `data.resource.questions` 就是整张卷子，
不创建记录、不计时。

## 32. 抽样卷重做 = 换一套题

`queryStuPaper/v2` 里：`is_sampling=2` 是抽样卷，`random_rule` 给出各题型抽几题，
`questions[]` 的长度是题库总量，`answer_record.sampling_questions` 才是本场抽中的题号。

实测一份卷：题库 100 题、抽 10 单选 + 10 多选 + 10 判断。这种卷子"再交一次"会重新抽题，
把上一套答案原样提交等于自杀。判断标准：`is_sampling=2` 且题库量远大于抽样量 → 不要重交。

## 33. 提交后页面会停在「提交中」

`submit` 返回 `SUBMITTED {"success":true}`、也弹了「提交成功」，页面头部仍可能长期显示
「状态：提交中 / 未提交」。不要慌，也不要刷新卷子页。

以接口为准：`queryStuPaper/v2` 的 `answer_record.status=2` + `answer_time` 有值 = 已收卷；
`score/actual_score` 是得分；`answer_record.answers` 是逐题记录，`correct=2` 判对、`1` 判错。
`answers` 字段是**数组**不是 JSON 字符串，别二次 `JSON.parse`。

## 34. Windows 下 URL.pathname 是百分号编码

Node 里 `new URL(...).pathname` 对中文文件名会返回 `%E7%BB%AA...`，直接丢给 `tar`/`fs` 会失败。
统一用 `fileURLToPath()`；拼临时目录时也别用 `pathname.replace(/^\//,"")`。

## 35. 附件题的自造文件

type 7 是附件题，控件只要文件。用 LibreOffice 把 HTML 转 docx：
`soffice --headless --convert-to "docx:MS Word 2007 XML" --outdir <dir> answer.html`。
注意必须写 `docx:MS Word 2007 XML` 这个过滤器名，只写 `docx` 会报 `no export filter`。
`fill` 的 attach 分支用 `DOM.setFileInputFiles`，传绝对路径，等文件名出现在页面上才算成功。
