#!/usr/bin/env node
// 理工智课 (whut.ai-augmented.com) CDP driver.
// See ../SKILL.md and ../references/pitfalls.md.
//
//   node whut.mjs list
//   node whut.mjs home
//   node whut.mjs tasks [--all]
//   node whut.mjs open-task "<task name>"
//   node whut.mjs enter
//   node whut.mjs state
//   node whut.mjs fill answers.json
//   node whut.mjs submit answers.json
//   node whut.mjs clean [--resources] | close <substring>
//   node whut.mjs unfreeze | status | dismiss
//   node whut.mjs eval "<expr>" | eval-file <path>
//   node whut.mjs click "<css>" ["text"] | goto <url>
//
// answers.json:
//   { "type": "match|short|choice|multi|judge|gap|attach", "answers": { "1": [...], ... } }
// A bare { "1": [...], ... } object is accepted; type is auto-detected per question.

import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const HOST = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, '');

let seq = 0;
function send(ws, method, params = {}, timeout = 25000) {
  const id = ++seq;
  return Promise.race([
    new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout ' + method)), timeout)),
  ]);
}

async function listTargets() {
  return (await fetch(`${HOST}/json/list`)).json();
}

async function closeTarget(id) {
  try {
    return (await fetch(`${HOST}/json/close/${encodeURIComponent(id)}`)).ok;
  } catch {
    return false;
  }
}

async function closePages(pages) {
  let closed = 0;
  for (const p of pages) if (await closeTarget(p.id)) closed++;
  return closed;
}

const isResourceUrl = (url) => (url || '').includes('/resource/');
const isPaperUrl = (url) => (url || '').includes('course_paper');
const courseId = (url) => ((url || '').match(/mycourse\/(\d+)/) || [])[1] || null;

async function cleanTabs({ resourcesOnly = false } = {}) {
  const allPages = (await listTargets()).filter((t) => t.type === 'page');
  const whut = allPages.filter((t) => (t.url || '').includes('whut.ai-augmented.com'));
  let close = [];
  if (resourcesOnly) {
    close.push(...whut.filter((t) => isResourceUrl(t.url)));
  } else {
    const seen = new Set();
    for (const t of whut) {
      if (seen.has(t.url)) close.push(t);
      else seen.add(t.url);
    }
  }
  // 关掉最后一个 page target 会让 Edge 直接退出，后续所有 CDP 命令都会失败；
  // 优先保留课程首页，没有首页时保留最后一个页面。
  if (allPages.length && close.length >= allPages.length) {
    const keep = whut.find((t) => !isResourceUrl(t.url) && !isPaperUrl(t.url)) || whut[whut.length - 1];
    if (keep) close = close.filter((t) => t.id !== keep.id);
    if (close.length >= allPages.length) close = close.slice(0, allPages.length - 1);
  }
  const closeIds = new Set(close.map((t) => t.id));
  const closed = await closePages(close);
  return { closed, kept: whut.filter((t) => !closeIds.has(t.id)).map((t) => t.url) };
}

async function connect(mode = 'auto', name = null) {
  const list = await listTargets();
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error(`no page on :${PORT}; open the course in the isolated Edge`);
  const override = process.env.CDP_MATCH || null;
  const score = (t) => {
    const u = t.url;
    let s = 0;
    if (override && u.includes(override)) s += 10000;
    if (name && (t.title || '').includes(name)) s += 5000;
    if (u === 'about:blank') s -= 1000;
    const isPaper = u.includes('course_paper');
    const isResource = u.includes('/resource/');
    const isHome = u.includes('/app/jx-web/mycourse') && !isResource && !isPaper;
    if (mode === 'paper') { if (isPaper) s += 500; if (isHome) s += 100; if (isResource) s += 10; }
    if (mode === 'resource') { if (isResource) s += 500; if (isHome) s += 100; if (isPaper) s += 10; }
    if (mode === 'home') { if (isHome) s += 500; if (isPaper) s += 100; if (isResource) s += 10; }
    if (mode === 'auto') { if (isPaper) s += 500; if (isResource) s += 100; if (isHome) s += 50; }
    return s;
  };
  const target = pages.sort((a, b) => score(b) - score(a))[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Debugger.paused') {
      try { ws.send(JSON.stringify({ id: ++seq, method: 'Debugger.resume' })); } catch {}
    }
  });
  return { ws, target };
}

async function closeWs(ws) {
  await new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try { ws.addEventListener('close', fin); } catch {}
    try { ws.close(); } catch { fin(); }
    setTimeout(fin, 600);
  });
}

async function prepare(ws) {
  await send(ws, 'Runtime.enable');
  await send(ws, 'Debugger.enable');
  await send(ws, 'Debugger.setSkipAllPauses', { skip: true });
  for (let i = 0; i < 3; i++) {
    try { await send(ws, 'Debugger.resume', {}, 2000); } catch {}
  }
  try { await send(ws, 'Page.enable'); } catch {}
  try { await send(ws, 'Page.setWebLifecycleState', { state: 'active' }); } catch {}
  try { await send(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
}

async function ensureHome(ws) {
  const href = await evalJS(ws, 'location.href');
  const base = href.split('?')[0].replace(/\/$/, '');
  if (base !== 'https://whut.ai-augmented.com/app/jx-web/mycourse') {
    await send(ws, 'Page.navigate', { url: 'https://whut.ai-augmented.com/app/jx-web/mycourse' });
    await sleep(4200);
  }
}

async function openDrawer(ws) {
  const already = await evalJS(ws, `(() => {
    const cards = [...document.querySelectorAll('.task_card .ant-col.ta_homework')].filter((e) => e.getClientRects().length);
    return cards.length > 0;
  })()`);
  if (already) return true;
  const raw = await evalJS(ws, `(async () => {
    ${HELPERS}
    const e = [...document.querySelectorAll('.square')].find((x) => txt(x.innerText).includes('待完成任务'));
    if (!e) return null;
    await scrollSmart(e);
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (!raw) return false;
  const r = JSON.parse(raw);
  await clickAt(ws, r.x, r.y);
  await sleep(900);
  return true;
}

async function showAllTasks(ws) {
  const cb = await evalJS(ws, `(async () => {
    ${HELPERS}
    const e = [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((x) => txt(x.innerText).includes('仅显示可完成任务'));
    if (!e || !e.className.includes('checked')) return null;
    await scrollSmart(e);
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (cb) {
    const c = JSON.parse(cb);
    await clickAt(ws, c.x, c.y);
    await sleep(700);
  }
  const all = await evalJS(ws, `(async () => {
    ${HELPERS}
    const e = [...document.querySelectorAll('label.ant-radio-wrapper')].find((x) => txt(x.innerText) === '显示全部任务');
    if (!e) return null;
    await scrollSmart(e);
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (all) {
    const a = JSON.parse(all);
    await clickAt(ws, a.x, a.y);
    await sleep(800);
  }
}

async function evalJS(ws, expression, timeout = 60000) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result?.value;
}

async function clickAt(ws, x, y) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const HELPERS = String.raw`
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  const getFiber = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  };
  const fakeEvt = { preventDefault() {}, stopPropagation() {}, nativeEvent: {}, target: null, currentTarget: null, type: 'click', button: 0 };
  const tagsOf = (sel) => [...sel.querySelectorAll('.ant-select-selection__choice')].map((c) => txt(c.innerText));
  const allSels = () => [...document.querySelectorAll('.question')].map((q) => [...q.querySelectorAll('.left_answer')]);
  const questionType = (q) => {
    if (q.querySelector('.question_multiple_subject')) return 'multi';
    if (q.querySelector('.question_estimate_subject')) return 'judge';
    if (q.querySelector('.question_gap_subject')) return 'gap';
    if (q.querySelector('.question_attach_subject')) return 'attach';
    if (q.querySelector('.question_subjective_subject')) return 'short';
    if (q.querySelector('.left_answer')) return 'match';
    if (q.querySelector('input.ant-radio-input')) return 'choice';
    if (q.querySelector('.public-DraftEditor-content[contenteditable="true"]')) return 'short';
    const cbs = [...q.querySelectorAll('input.ant-checkbox-input')].filter((e) => !e.closest('.ext_question_operate'));
    if (cbs.length) return 'multi';
    if (q.querySelector('input[type=file]')) return 'attach';
    if (q.querySelector('textarea, ._input_box textarea')) return 'gap';
    return 'unknown';
  };
  const optionLabels = (q) => [...q.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper')]
    .filter((l) => !l.closest('.ext_question_operate'))
    .map((l) => txt(l.innerText));
  const checkedLabels = (q) => [...q.querySelectorAll('input.ant-radio-input:checked, input.ant-checkbox-input:checked')]
    .map((i) => i.closest('label') || i.closest('.ant-radio-wrapper, .ant-checkbox-wrapper'))
    .filter(Boolean)
    .map((l) => txt(l.innerText));
  const blankFields = (q) => [...q.querySelectorAll('.question_gap_subject textarea, .question_gap_subject input.ant-input, ._input_box textarea')];
  const fileNames = (q) => [...q.querySelectorAll('.attach_subject_file_item__name, .ant-upload-list-item-name')].map((e) => txt(e.innerText));
  const getInst = (sel) => {
    const ant = sel.querySelector('.ant-select') || sel.querySelector('.ant-select-selection');
    let f = getFiber(ant);
    let d = 0;
    while (f && d < 14) {
      if (f.stateNode && f.stateNode.state && Array.isArray(f.stateNode.state.value) && f.stateNode.state.optionsInfo) return f.stateNode;
      f = f.return; d++;
    }
    return null;
  };
  const inView = (el, pad = 8) => {
    const r = el.getBoundingClientRect();
    return r.top >= pad && r.bottom <= innerHeight - pad && r.left >= 0 && r.right <= innerWidth;
  };
  const scrollSmart = async (el) => {
    for (let attempt = 0; attempt < 5 && !inView(el); attempt++) {
      let sc = el.parentElement;
      while (sc) {
        const cs = getComputedStyle(sc);
        if (sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(cs.overflowY)) break;
        sc = sc.parentElement;
      }
      queueMicrotask(() => {});
      if (sc) {
        const prev = sc.style.scrollBehavior;
        sc.style.scrollBehavior = 'auto';
        const er = el.getBoundingClientRect();
        const sr = sc.getBoundingClientRect();
        sc.scrollTop = sc.scrollTop + (er.top - sr.top) - (sc.clientHeight - er.height) / 2;
        sc.style.scrollBehavior = prev;
      } else {
        const prev = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = 'auto';
        const er = el.getBoundingClientRect();
        window.scrollBy(0, er.top - (innerHeight - er.height) / 2);
        document.documentElement.style.scrollBehavior = prev;
      }
      await sleep(120);
    }
    return el.getBoundingClientRect();
  };
  const openDrop = async (sel) => {
    const trigger = sel.querySelector('.ant-select-selection');
    if (!trigger) return null;
    await scrollSmart(trigger);
    let id = trigger.getAttribute('aria-controls');
    let drop = id ? document.getElementById(id) : null;
    if (drop && !drop.className.includes('hidden')) return drop;
    for (let n = 0; n < 2; n++) {
      fire(trigger, 'mousedown'); fire(trigger, 'mouseup'); fire(trigger, 'click');
      await sleep(340);
      id = trigger.getAttribute('aria-controls');
      drop = id ? document.getElementById(id) : null;
      if (drop && !drop.className.includes('hidden')) return drop;
    }
    return drop;
  };
  const clickOption = (drop, letter) => {
    if (!drop) return 'no-dropdown';
    const item = [...drop.querySelectorAll('.ant-select-dropdown-menu-item')]
      .find((i) => txt(i.innerText).startsWith('(' + letter + ')'));
    if (!item) return 'no-item';
    const f = getFiber(item);
    const p = f && f.memoizedProps;
    if (!p || typeof p.onClick !== 'function') return 'no-handler';
    p.onClick(fakeEvt);
    return 'ok';
  };
  const clearDraft = (i) => {
    const ed = document.querySelectorAll('.question')[i]?.querySelector('.public-DraftEditor-content[contenteditable="true"]');
    if (!ed) return 'no-editor';
    let f = getFiber(ed);
    let d = 0;
    while (f && d < 20) {
      const p = f.memoizedProps;
      if (p && p.editorState && typeof p.onChange === 'function') {
        const ES = p.editorState.constructor;
        if (ES && typeof ES.createEmpty === 'function') {
          p.onChange(ES.createEmpty());
          return 'ok';
        }
        return 'no-createEmpty';
      }
      f = f.return;
      d++;
    }
    return 'no-fiber';
  };
`;

const STATE_FN = String.raw`
  (async () => {
    const qs = [...document.querySelectorAll('.question')];
    const out = [];
    const types = [];
    for (let qi = 0; qi < qs.length; qi++) {
      const q = qs[qi];
      const t = questionType(q);
      types.push(t);
      const stem = txt(q.querySelector('.exam_question_stem')?.innerText || '').replace(/\s*\[[^\]]*\]\s*$/, '').slice(0, 200);
      if (t === 'match') {
        const items = [...q.querySelectorAll('.left_item_panel .item')];
        const sels = [...q.querySelectorAll('.left_answer')];
        const rows = sels.map((sel, i) => ({
          row: String.fromCharCode(65 + i),
          left: txt(items[i]?.querySelector('.left_content')?.innerText || '').slice(0, 100),
          tags: tagsOf(sel),
        }));
        let options = [];
        if (sels.length) {
          const drop = await openDrop(sels[0]);
          options = drop ? [...drop.querySelectorAll('.ant-select-dropdown-menu-item')].map((i) => txt(i.innerText)) : [];
        }
        out.push({ q: qi + 1, type: t, stem, rows, options });
      } else if (t === 'short') {
        const ed = q.querySelector('.public-DraftEditor-content[contenteditable="true"]');
        out.push({ q: qi + 1, type: t, stem, answer: ed ? (ed.innerText || '').trim() : null });
      } else if (t === 'choice' || t === 'judge') {
        const options = optionLabels(q);
        const checked = checkedLabels(q);
        out.push({ q: qi + 1, type: t, stem, options, checked: checked[0] || null });
      } else if (t === 'multi') {
        out.push({ q: qi + 1, type: t, stem, options: optionLabels(q), checked: checkedLabels(q) });
      } else if (t === 'gap') {
        const fields = blankFields(q);
        out.push({ q: qi + 1, type: t, stem, blanks: fields.map((f, i) => ({ index: i + 1, value: f.value || '', placeholder: f.placeholder || '' })) });
      } else if (t === 'attach') {
        out.push({ q: qi + 1, type: t, stem, files: fileNames(q) });
      } else {
        out.push({ q: qi + 1, type: t, stem });
      }
    }
    const uniq = [...new Set(types)];
    const kind = uniq.length === 1 ? uniq[0] : 'mixed';
    return JSON.stringify({ kind, questions: out });
  })()
`;

async function readAnswersArg(arg) {
  if (!arg) throw new Error('missing answers JSON or file path');
  const raw = arg.trim().startsWith('{') ? arg : readFileSync(arg, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.answers) return parsed;
  return { answers: parsed };
}

async function questionTypes(ws) {
  const raw = await evalJS(ws, `(() => { ${HELPERS} return JSON.stringify([...document.querySelectorAll('.question')].map((q) => questionType(q))); })()`);
  return JSON.parse(raw);
}

async function detectType(ws) {
  const types = await questionTypes(ws);
  const uniq = [...new Set(types)];
  if (!uniq.length) return 'unknown';
  return uniq.length === 1 ? uniq[0] : 'mixed';
}

function letterIndex(v) {
  const s = String(v).trim().toUpperCase();
  return /^[A-Z]$/.test(s) ? s.charCodeAt(0) - 65 : -1;
}

function resolveOptionIndex(options, answer, type = 'choice') {
  const s = String(Array.isArray(answer) ? answer[0] : answer).trim();
  if (type === 'judge') {
    const t = s.toLowerCase();
    const yes = ['对', '正确', 'true', 't', '1', '√', 'yes', 'y'];
    const no = ['错', '错误', 'false', 'f', '0', '×', 'no', 'n'];
    if (yes.includes(t)) {
      const i = options.findIndex((o) => o.includes('正确') || o.includes('对'));
      return i >= 0 ? i : 0;
    }
    if (no.includes(t)) {
      const i = options.findIndex((o) => o.includes('错误') || o.includes('错'));
      return i >= 0 ? i : 1;
    }
  }
  const li = letterIndex(s);
  if (li >= 0 && li < options.length) return li;
  let i = options.findIndex((o) => o.includes(s));
  if (i < 0) i = options.findIndex((o) => o.replace(/\s/g, '').includes(s.replace(/\s/g, '')));
  return i;
}

async function questionInfo(ws, qi) {
  const raw = await evalJS(ws, `(() => { ${HELPERS}
    const q = document.querySelectorAll('.question')[${qi}];
    if (!q) return JSON.stringify({ error: 'no-question' });
    return JSON.stringify({
      type: questionType(q),
      options: optionLabels(q),
      checked: checkedLabels(q),
      blanks: blankFields(q).map((f) => f.value || ''),
      files: fileNames(q),
      labels: [...q.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper')]
        .filter((l) => !l.closest('.ext_question_operate'))
        .map((l, i) => {
          const r = l.getBoundingClientRect();
          const input = l.querySelector('input');
          return { i, text: txt(l.innerText), checked: !!(input && input.checked), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
    });
  })()`);
  return JSON.parse(raw);
}

async function clickQuestionLabel(ws, qi, index) {
  const raw = await evalJS(ws, `(async () => { ${HELPERS}
    const q = document.querySelectorAll('.question')[${qi}];
    const labels = [...q.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper')].filter((l) => !l.closest('.ext_question_operate'));
    const l = labels[${index}];
    if (!l) return JSON.stringify({ error: 'no-label' });
    await scrollSmart(l);
    const r = l.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  const r = JSON.parse(raw);
  if (r.error) return r;
  await clickAt(ws, r.x, r.y);
  await sleep(350);
  return { ok: true };
}

async function checkAnswers(ws, type, answers) {
  const raw = await evalJS(ws, `(() => { ${HELPERS}
    return JSON.stringify([...document.querySelectorAll('.question')].map((q) => ({
      type: questionType(q),
      options: optionLabels(q),
      checked: checkedLabels(q),
      tags: [...q.querySelectorAll('.left_answer')].map((s) => tagsOf(s)),
      text: (() => { const e = q.querySelector('.public-DraftEditor-content[contenteditable="true"]'); return e ? (e.innerText || '') : null; })(),
      blanks: blankFields(q).map((f) => f.value || ''),
      files: fileNames(q),
    })));
  })()`);
  const got = JSON.parse(raw);
  const bad = [];
  for (const [qk, val] of Object.entries(answers)) {
    const qi = Number(qk) - 1;
    const g = got[qi];
    if (!g) { bad.push(`Q${qk} missing question`); continue; }
    if (g.type === 'match') {
      const letters = Array.isArray(val) ? val : [val];
      if (!g.tags || letters.length !== g.tags.length) {
        bad.push(`Q${qk} slot-count got=${g.tags ? g.tags.length : 0} want=${letters.length}`);
        continue;
      }
      letters.forEach((letter, i) => {
        const tags = g.tags[i];
        if (!tags || tags.length !== 1 || tags[0] !== '(' + String(letter).toLowerCase() + ')') {
          bad.push(`Q${qk}-${String.fromCharCode(65 + i)} got=[${tags}] want=(${stringify(letter)})`);
        }
      });
    } else if (g.type === 'short') {
      const text = Array.isArray(val) ? val[0] : val;
      if (norm(g.text) !== norm(text)) bad.push(`Q${qk} text mismatch`);
    } else if (g.type === 'choice' || g.type === 'judge') {
      const wantIdx = resolveOptionIndex(g.options, val, g.type);
      const gotIdx = g.checked.length ? g.options.findIndex((o) => o === g.checked[0]) : -1;
      if (wantIdx < 0 || gotIdx !== wantIdx) bad.push(`Q${qk} got=${JSON.stringify(g.checked)} want=${JSON.stringify(val)}`);
    } else if (g.type === 'multi') {
      const wants = (Array.isArray(val) ? val : [val]).map((v) => resolveOptionIndex(g.options, v, 'choice'));
      const gotIdx = g.checked.map((c) => g.options.findIndex((o) => o === c)).filter((i) => i >= 0);
      const wantSet = [...new Set(wants)].sort().join(',');
      const gotSet = [...new Set(gotIdx)].sort().join(',');
      if (wants.some((i) => i < 0) || wantSet !== gotSet) bad.push(`Q${qk} got=${JSON.stringify(g.checked)} want=${JSON.stringify(val)}`);
    } else if (g.type === 'gap') {
      const wants = Array.isArray(val) ? val : [val];
      if (g.blanks.length !== wants.length) bad.push(`Q${qk} blank-count got=${g.blanks.length} want=${wants.length}`);
      else wants.forEach((v, i) => { if (norm(g.blanks[i]) !== norm(v)) bad.push(`Q${qk} blank${i + 1} mismatch`); });
    } else if (g.type === 'attach') {
      const wants = (Array.isArray(val) ? val : [val]).map((v) => String(v).split(/[\\/]/).pop());
      const missing = wants.filter((w) => !g.files.some((f) => f.includes(w)));
      if (missing.length) bad.push(`Q${qk} missing files ${JSON.stringify(missing)} got=${JSON.stringify(g.files)}`);
    } else {
      bad.push(`Q${qk} unsupported type ${g.type}`);
    }
  }
  return bad;
}

async function scrollToSubmit(ws) {
  return JSON.parse(await evalJS(ws, `(async () => {
    ${HELPERS}
    const b = [...document.querySelectorAll('button.ant-btn')].find((x) => txt(x.innerText) === '提交' && x.getClientRects().length);
    if (!b) return JSON.stringify({ error: 'no-submit-button' });
    await scrollSmart(b);
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, vh: innerHeight });
  })()`));
}

async function modalInfo(ws, needle) {
  return JSON.parse(await evalJS(ws, `(() => {
    ${HELPERS}
    const w = [...document.querySelectorAll('.ant-modal-wrap')]
      .find((m) => getComputedStyle(m).display !== 'none' && txt(m.innerText).includes(${JSON.stringify(needle)}));
    if (!w) return JSON.stringify({ open: false });
    const b = [...w.querySelectorAll('button')].find((x) => txt(x.innerText) === '提 交');
    let rect = null;
    if (b) { const r = b.getBoundingClientRect(); rect = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    return JSON.stringify({ open: true, text: txt(w.innerText).slice(0, 160), rect });
  })()`));
}

async function clickModalButton(ws, needle, text) {
  const raw = await evalJS(ws, `(async () => {
    ${HELPERS}
    const w = [...document.querySelectorAll('.ant-modal-wrap')]
      .find((m) => getComputedStyle(m).display !== 'none' && txt(m.innerText).includes(${JSON.stringify(needle)}));
    if (!w) return null;
    const b = [...w.querySelectorAll('button')].find((x) => txt(x.innerText) === ${JSON.stringify(text)});
    if (!b) return null;
    await scrollSmart(b);
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (!raw) return false;
  const r = JSON.parse(raw);
  await clickAt(ws, r.x, r.y);
  await sleep(700);
  return true;
}

async function waitForSuccess(ws, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const raw = await evalJS(ws, `(() => {
      const txt = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const body = txt(document.body.innerText);
      const modal = [...document.querySelectorAll('.ant-modal-wrap')]
        .filter((m) => getComputedStyle(m).display !== 'none')
        .map((m) => txt(m.innerText).slice(0, 160));
      return JSON.stringify({
        success: modal.some((m) => m.includes('提交成功')),
        modal,
        status: (body.match(/状态：[^\\s，。]{0,12}/) || [''])[0],
        unsubmitted: body.includes('未提交'),
      });
    })()`);
    last = JSON.parse(raw);
    if (last.success || (!last.unsubmitted && last.status.includes('提交'))) return last;
    await sleep(500);
  }
  return last;
}

function stringify(v) { return JSON.stringify(v).replace(/^"|"$/g, ''); }

async function main() {
  const cmd = process.argv[2] || 'list';
  if (cmd === 'list') {
    for (const t of await listTargets()) console.log(`${t.type}\t${t.title}\t${t.url}`);
    return;
  }

  if (cmd === 'clean') {
    const result = await cleanTabs({ resourcesOnly: process.argv.includes('--resources') });
    console.log('CLEANED ' + JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'close') {
    const match = process.argv[3];
    if (!match) throw new Error('usage: close <url-or-title-substring>');
    const pages = (await listTargets()).filter((t) => t.type === 'page' &&
      ((t.url || '').includes(match) || (t.title || '').includes(match)));
    if (!pages.length) { console.log('NO_MATCH'); return; }
    console.log('CLOSED ' + (await closePages(pages)) + ' ' + JSON.stringify(pages.map((p) => p.url), null, 2));
    return;
  }

  const homeCmds = ['home', 'tasks', 'open-task'];
  const mode = homeCmds.includes(cmd) ? 'home' : cmd === 'enter' ? 'resource' : 'auto';
  const name = cmd === 'enter' ? (process.argv[3] || null) : null;
  const { ws, target } = await connect(mode, name);
  try {
    await prepare(ws);

    if (cmd === 'unfreeze') {
      const t = await evalJS(ws, `(async () => { const t = Date.now(); await new Promise((r) => setTimeout(r, 300)); return Date.now() - t; })()`, 12000);
      console.log('UNFROZEN ' + t + 'ms');
      return;
    }

    if (cmd === 'eval' || cmd === 'eval-file') {
      const expr = cmd === 'eval' ? process.argv[3] : readFileSync(process.argv[3], 'utf8');
      if (!expr) throw new Error('usage: eval <expr> | eval-file <path>');
      console.log(JSON.stringify(await evalJS(ws, expr), null, 2));
      return;
    }

    if (cmd === 'goto') {
      await send(ws, 'Page.navigate', { url: process.argv[3] });
      await sleep(4000);
      console.log('NAVIGATED ' + process.argv[3]);
      return;
    }

    if (cmd === 'home') {
      await ensureHome(ws);
      console.log('HOME ' + (await evalJS(ws, 'location.href')));
      return;
    }

    if (cmd === 'click') {
      const selector = process.argv[3];
      const text = process.argv[4] || '';
      if (!selector) throw new Error('usage: click <css> [text]');
      const raw = await evalJS(ws, `(async () => {
        ${HELPERS}
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length > 0);
        const el = els.find((e) => txt(e.innerText).includes(${JSON.stringify(text)}));
        if (!el) return JSON.stringify({ found: false, count: els.length });
        await scrollSmart(el);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, text: txt(el.innerText).slice(0, 80) });
      })()`);
      const info = JSON.parse(raw);
      if (!info.found) throw new Error(`not found: ${selector} / ${text} (visible ${info.count})`);
      await clickAt(ws, info.x, info.y);
      await sleep(2200);
      console.log('CLICKED ' + JSON.stringify(info));
      return;
    }

    if (cmd === 'tasks') {
      await ensureHome(ws);
      const opened = await openDrawer(ws);
      if (!opened) throw new Error('.square 待完成任务 not found on the course list');
      if (process.argv.includes('--all')) {
        await showAllTasks(ws);
      }
      const raw = await evalJS(ws, `(() => {
        ${HELPERS}
        const cards = [...document.querySelectorAll('.task_card .ant-col.ta_homework')].map((c) => ({
          title: txt(c.querySelector('a.group-resource-link')?.innerText || ''),
          course: txt(c.querySelector('a.group_link.inline')?.innerText || ''),
          due: txt(c.querySelector('.xy_taskCard_bottom span')?.innerText || ''),
          type: txt(c.querySelector('.ta_taskType')?.innerText || ''),
        }));
        const m = txt(document.body.innerText).match(/待完成任务【(\\d+)项/);
        return JSON.stringify({ pending: m ? Number(m[1]) : null, cards });
      })()`);
      console.log(raw);
      return;
    }

    if (cmd === 'open-task') {
      const name = process.argv[3];
      if (!name) throw new Error('usage: open-task "<task name>"');
      await ensureHome(ws);
      const hasLink = await evalJS(ws, `!!([...document.querySelectorAll('a.group-resource-link')].find((e) => e.innerText.includes(${JSON.stringify(name)})))`);
      if (!hasLink) {
        const opened = await openDrawer(ws);
        if (!opened) throw new Error('.square 待完成任务 not found');
        await showAllTasks(ws);
      }
      const beforeResources = (await listTargets())
        .filter((t) => t.type === 'page' && isResourceUrl(t.url) && t.id !== target.id)
        .map((t) => t.id);
      const raw = await evalJS(ws, `(async () => {
        ${HELPERS}
        const a = [...document.querySelectorAll('a.group-resource-link')].find((e) => txt(e.innerText).includes(${JSON.stringify(name)}));
        if (!a) return null;
        const f = getFiber(a);
        const p = f && f.memoizedProps;
        if (p && typeof p.onClick === 'function') {
          p.onClick(fakeEvt);
          return JSON.stringify({ method: 'react', text: txt(a.innerText) });
        }
        await scrollSmart(a);
        const r = a.getBoundingClientRect();
        return JSON.stringify({ method: 'click', x: r.x + r.width / 2, y: r.y + r.height / 2, text: txt(a.innerText) });
      })()`);
      if (!raw) throw new Error('task link not found: ' + name);
      const r = JSON.parse(raw);
      if (r.method === 'click') await clickAt(ws, r.x, r.y);
      await sleep(2800);
      let staleClosed = 0;
      const afterOpen = (await listTargets()).filter((t) => t.type === 'page');
      const newResource = afterOpen.find((t) => isResourceUrl(t.url) && t.id !== target.id && !beforeResources.includes(t.id));
      if (newResource) {
        const newCourse = courseId(newResource.url);
        staleClosed = await closePages(afterOpen.filter((t) =>
          beforeResources.includes(t.id) && courseId(t.url) === newCourse));
      }
      console.log('OPENED ' + JSON.stringify(r) + ' ' + (await evalJS(ws, 'location.href')) +
        (staleClosed ? ` [closed ${staleClosed} stale resource tab(s)]` : ''));
      return;
    }

    if (cmd === 'enter') {
      const raw = await evalJS(ws, `(async () => {
        ${HELPERS}
        const b = document.querySelector('.entry_task_btn');
        if (!b) return null;
        await scrollSmart(b);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`);
      if (!raw) throw new Error('.entry_task_btn not found');
      const r = JSON.parse(raw);
      await clickAt(ws, r.x, r.y);
      await sleep(3500);
      const pages = (await listTargets()).filter((t) => t.type === 'page');
      const paper = pages.find((t) => isPaperUrl(t.url) && (!name || (t.title || '').includes(name))) ||
        pages.find((t) => isPaperUrl(t.url));
      let staleClosed = 0;
      if (paper) {
        const paperCourse = courseId(paper.url);
        staleClosed = await closePages(pages.filter((t) =>
          isResourceUrl(t.url) && courseId(t.url) === paperCourse && t.id !== target.id && t.id !== paper.id));
      }
      console.log('ENTERED ' + (paper ? paper.url : '(no paper tab; run state)') +
        (staleClosed ? ` [closed ${staleClosed} stale resource tab(s)]` : ''));
      return;
    }

    if (cmd === 'check') {
      const raw = await evalJS(ws, `(() => {
        const txt = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const body = txt(document.body.innerText);
        const url = location.href;
        const isBlank = url === 'about:blank';
        const isPaper = url.includes('course_paper');
        const isResource = url.includes('/resource/');
        const isHome = url.includes('/app/jx-web/mycourse') && !isResource && !isPaper;
        const kind = isBlank ? 'blank' : isPaper ? 'paper' : isResource ? 'resource' : isHome ? 'home' : 'other';
        const match = document.querySelectorAll('.left_answer').length;
        const short = document.querySelectorAll('.question .public-DraftEditor-content[contenteditable="true"]').length;
        const choice = document.querySelectorAll('.question input.ant-radio-input').length;
        const attempts = (body.match(/允许提交：(\\d+)次/) || [])[1] || null;
        return JSON.stringify({
          ok: !isBlank,
          url,
          title: document.title,
          kind,
          loggedIn: !isBlank && (isPaper || isResource || /我的课程|学习课程/.test(body)),
          questions: document.querySelectorAll('.question').length,
          type: match ? 'match' : short ? 'short' : choice ? 'choice' : null,
          status: (body.match(/状态：[^\\s，。]{0,12}/) || [''])[0],
          attempts: attempts ? Number(attempts) : null,
        });
      })()`);
      const pages = (await listTargets()).filter((t) => t.type === 'page');
      console.log(JSON.stringify({
        ...JSON.parse(raw),
        targets: pages.map((t) => ({ title: t.title, url: t.url })),
      }, null, 2));
      return;
    }

    if (cmd === 'status') {
      console.log(await evalJS(ws, `(() => {
        const txt = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const body = txt(document.body.innerText);
        return JSON.stringify({
          url: location.href,
          head: body.slice(0, 260),
          status: (body.match(/状态：[^\\s，。]{0,12}/) || [''])[0],
          unsubmitted: body.includes('未提交'),
          questions: document.querySelectorAll('.question').length,
        });
      })()`));
      return;
    }

    if (cmd === 'dismiss') {
      const ok = await clickModalButton(ws, '提交成功', '确 定');
      if (ok) { console.log('DISMISSED'); return; }
      const ok2 = await clickModalButton(ws, '', '取 消');
      console.log(ok2 ? 'DISMISSED' : 'NO_MODAL');
      return;
    }

    if (cmd === 'state') {
      console.log(await evalJS(ws, `(() => { ${HELPERS} return (${STATE_FN}); })()`));
      return;
    }

    if (cmd === 'probe') {
      console.log(await evalJS(ws, `(() => { ${HELPERS}
        return JSON.stringify([...document.querySelectorAll('.question')].map((q, i) => {
          const t = questionType(q);
          let f = getFiber(q);
          let prop = null;
          for (let d = 0; f && d < 20; d++, f = f.return) {
            if (f.memoizedProps && f.memoizedProps.question) { prop = f.memoizedProps.question; break; }
          }
          return {
            q: i + 1,
            type: t,
            classes: [...q.classList],
            stem: txt(q.querySelector('.exam_question_stem')?.innerText || '').slice(0, 120),
            controls: {
              checkbox: [...q.querySelectorAll('input.ant-checkbox-input')].filter((e) => !e.closest('.ext_question_operate')).length,
              radio: [...q.querySelectorAll('input.ant-radio-input')].length,
              textarea: [...q.querySelectorAll('textarea')].length,
              text: [...q.querySelectorAll('input.ant-input, input[type=text]')].length,
              file: [...q.querySelectorAll('input[type=file]')].length,
              draft: [...q.querySelectorAll('.public-DraftEditor-content')].length,
            },
            options: optionLabels(q).slice(0, 12),
            blanks: blankFields(q).map((x) => x.value || ''),
            files: fileNames(q),
            prop: prop ? {
              type: prop.type,
              max_choice_num: prop.max_choice_num ?? null,
              answer_items: Array.isArray(prop.answer_items) ? prop.answer_items.length : null,
              word_limit: prop.word_limit ?? null,
            } : null,
          };
        }));
      })()`));
      return;
    }

    if (cmd === 'clear') {
      const type = await detectType(ws);
      if (type === 'short') {
        const n = await evalJS(ws, 'document.querySelectorAll(".question").length');
        let cleared = 0;
        for (let i = 0; i < n; i++) {
          const r = await evalJS(ws, `(() => { ${HELPERS} return clearDraft(${i}); })()`);
          if (r === 'ok') cleared++;
          await sleep(120);
        }
        console.log('CLEARED short ' + cleared + '/' + n);
        return;
      }
      if (type === 'match') {
        const n = await evalJS(ws, `(() => {
          ${HELPERS}
          let c = 0;
          for (const sel of document.querySelectorAll('.left_answer')) {
            const inst = getInst(sel);
            if (inst) { inst.setState({ value: [], open: false }); c++; }
          }
          return c;
        })()`);
        console.log('CLEARED match ' + n);
        return;
      }
      console.log('CLEAR_UNSUPPORTED ' + type);
      return;
    }

    if (cmd === 'fill') {
      const spec = await readAnswersArg(process.argv[3]);
      const answers = spec.answers;
      const types = await questionTypes(ws);
      for (const [qk, val] of Object.entries(answers)) {
        const qi = Number(qk) - 1;
        const type = spec.type && spec.type !== 'auto' && spec.type !== 'mixed' ? spec.type : types[qi];
        if (type === 'match') {
          const letters = Array.isArray(val) ? val : [val];
          const raw = await evalJS(ws, `(async () => {
            ${HELPERS}
            const L = ${JSON.stringify(letters.map((x) => String(x).toLowerCase()))};
            const qi = ${qi};
            const sels = allSels()[qi];
            if (!sels) return JSON.stringify({ error: 'no-question' });
            if (L.length !== sels.length) return JSON.stringify({ error: 'row-count', want: L.length, got: sels.length });
            const out = [];
            for (let i = 0; i < sels.length; i++) {
              const sel = sels[i];
              const want = L[i];
              let ok = false;
              const trace = [];
              for (let attempt = 0; attempt < 3 && !ok; attempt++) {
                const inst = getInst(sel);
                if (inst) inst.setState({ value: [], open: false });
                await sleep(160);
                const drop = await openDrop(sel);
                trace.push(clickOption(drop, want));
                await sleep(260);
                const tags = tagsOf(sel);
                ok = tags.length === 1 && tags[0] === '(' + want + ')';
                if (!ok) trace.push(JSON.stringify(tags));
              }
              out.push({ row: String.fromCharCode(65 + i), want, got: tagsOf(sel), ok, trace });
            }
            return JSON.stringify(out);
          })()`);
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) { console.log(`Q${qk}: ${JSON.stringify(parsed)}`); process.exitCode = 2; continue; }
          for (const r of parsed) {
            console.log(`Q${qk}-${r.row} want(${r.want}) got[${r.got}] ${r.ok ? 'OK' : 'FAIL ' + r.trace.join(' ')}`);
            if (!r.ok) process.exitCode = 2;
          }
        } else if (type === 'short') {
          const answer = Array.isArray(val) ? val[0] : String(val);
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            const clearRaw = await evalJS(ws, `(() => { ${HELPERS} return clearDraft(${qi}); })()`);
            if (clearRaw === 'no-editor') { console.log(`Q${qk}: no editor`); break; }
            await sleep(180);
            const focusRaw = await evalJS(ws, `(() => {
              const ed = document.querySelectorAll('.question')[${qi}]?.querySelector('.public-DraftEditor-content[contenteditable="true"]');
              if (!ed) return 'no-editor';
              ed.focus();
              return 'ok';
            })()`);
            if (focusRaw === 'no-editor') { console.log(`Q${qk}: no editor`); break; }
            await sleep(120);
            await send(ws, 'Input.insertText', { text: answer });
            await sleep(480);
            const got = await evalJS(ws, `(() => {
              const ed = document.querySelectorAll('.question')[${qi}]?.querySelector('.public-DraftEditor-content[contenteditable="true"]');
              return ed ? (ed.innerText || '') : '';
            })()`);
            ok = norm(got) === norm(answer);
            console.log(`Q${qk}: ${ok ? 'OK' : 'MISMATCH'} len=${(got || '').length}/${answer.length}`);
            if (!ok) await sleep(350);
          }
          if (!ok) process.exitCode = 2;
        } else if (type === 'choice' || type === 'judge' || type === 'multi') {
          const info = await questionInfo(ws, qi);
          if (info.error) { console.log(`Q${qk}: ${info.error}`); process.exitCode = 2; continue; }
          const values = Array.isArray(val) ? val : [val];
          const wants = values.map((v) => resolveOptionIndex(info.options, v, type === 'judge' ? 'judge' : 'choice'));
          if (wants.some((i) => i < 0)) {
            console.log(`Q${qk}: cannot map ${JSON.stringify(val)} to options ${JSON.stringify(info.options)}`);
            process.exitCode = 2;
            continue;
          }
          const wantSet = new Set(type === 'multi' ? wants : [wants[0]]);
          let ok = false;
          for (let attempt = 0; attempt < 4 && !ok; attempt++) {
            const cur = await questionInfo(ws, qi);
            const curChecked = new Set(cur.labels.map((l, i) => (l.checked ? i : -1)).filter((i) => i >= 0));
            const toClick = [...new Set([...wantSet, ...curChecked])].filter((i) => wantSet.has(i) !== curChecked.has(i));
            for (const i of toClick) await clickQuestionLabel(ws, qi, i);
            const after = await questionInfo(ws, qi);
            const afterChecked = new Set(after.labels.map((l, i) => (l.checked ? i : -1)).filter((i) => i >= 0));
            ok = afterChecked.size === wantSet.size && [...wantSet].every((i) => afterChecked.has(i));
            if (ok) console.log(`Q${qk}: OK ${type} ${JSON.stringify(values)}`);
            else if (attempt === 3) console.log(`Q${qk}: FAIL ${type} got=${JSON.stringify(after.checked)} want=${JSON.stringify(values)}`);
          }
          if (!ok) process.exitCode = 2;
        } else if (type === 'gap') {
          const values = (Array.isArray(val) ? val : [val]).map((v) => String(v));
          const count = await evalJS(ws, `(() => { ${HELPERS} return blankFields(document.querySelectorAll('.question')[${qi}]).length; })()`);
          if (count !== values.length) {
            console.log(`Q${qk}: blank count got=${count} want=${values.length}`);
            process.exitCode = 2;
            continue;
          }
          await evalJS(ws, `(() => { ${HELPERS}
            const fields = blankFields(document.querySelectorAll('.question')[${qi}]);
            const vals = ${JSON.stringify(values)};
            fields.forEach((f, i) => {
              const proto = f.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              setter.call(f, vals[i]);
              f.dispatchEvent(new Event('input', { bubbles: true }));
              f.dispatchEvent(new Event('change', { bubbles: true }));
            });
          })()`);
          const readBlanks = async () => JSON.parse(await evalJS(ws, `(() => { ${HELPERS} return JSON.stringify(blankFields(document.querySelectorAll('.question')[${qi}]).map((f) => f.value || '')); })()`));
          let got = await readBlanks();
          let ok = got.every((v, i) => norm(v) === norm(values[i]));
          if (!ok) {
            for (let i = 0; i < values.length; i++) {
              const focused = await evalJS(ws, `(() => { ${HELPERS}
                const f = blankFields(document.querySelectorAll('.question')[${qi}])[${i}];
                if (!f) return false;
                f.focus();
                f.select();
                return true;
              })()`);
              if (!focused) break;
              await sleep(80);
              await send(ws, 'Input.insertText', { text: values[i] });
              await sleep(180);
            }
            got = await readBlanks();
            ok = got.every((v, i) => norm(v) === norm(values[i]));
          }
          console.log(`Q${qk}: ${ok ? 'OK' : 'MISMATCH'} gap ${JSON.stringify(got)}`);
          if (!ok) process.exitCode = 2;
        } else if (type === 'attach') {
          const files = (Array.isArray(val) ? val : [val]).map((v) => String(v));
          await send(ws, 'DOM.enable');
          const obj = await send(ws, 'Runtime.evaluate', {
            expression: `document.querySelectorAll('.question')[${qi}].querySelector('input[type=file]')`,
            objectGroup: 'attach',
          });
          if (!obj.result || !obj.result.objectId) {
            console.log(`Q${qk}: no file input`);
            process.exitCode = 2;
            continue;
          }
          try {
            await send(ws, 'DOM.setFileInputFiles', { files, objectId: obj.result.objectId }, 60000);
          } catch (e) {
            console.log(`Q${qk}: upload failed ${e.message}`);
            process.exitCode = 2;
            continue;
          }
          const base = files.map((f) => f.split(/[\\/]/).pop());
          let names = [];
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            names = JSON.parse(await evalJS(ws, `(() => { ${HELPERS} return JSON.stringify(fileNames(document.querySelectorAll('.question')[${qi}])); })()`));
            if (base.every((b) => names.some((n) => n.includes(b)))) break;
            await sleep(1500);
          }
          const missing = base.filter((b) => !names.some((n) => n.includes(b)));
          const ok = missing.length === 0;
          console.log(`Q${qk}: ${ok ? 'OK' : 'FAIL'} attach ${JSON.stringify(names)}`);
          if (!ok) process.exitCode = 2;
        } else {
          console.log(`Q${qk}: unsupported type ${type}`);
          process.exitCode = 2;
        }
      }
      return;
    }

    if (cmd === 'submit') {
      const spec = await readAnswersArg(process.argv[3]);
      const type = spec.type || (await detectType(ws));
      const answers = spec.answers;
      if (!['match', 'short', 'choice', 'judge', 'multi', 'gap', 'attach', 'mixed'].includes(type)) throw new Error('no questions detected; run enter first');
      const pageCount = await evalJS(ws, 'document.querySelectorAll(".question").length');
      const answerCount = Object.keys(answers).length;
      if (pageCount !== answerCount) throw new Error(`answers cover ${answerCount} questions but page has ${pageCount}`);
      let bad = await checkAnswers(ws, type, answers);
      console.log('before dialog: ' + (bad.length ? 'INCOMPLETE ' + JSON.stringify(bad) : 'ALL_OK'));
      if (bad.length) { process.exitCode = 2; return; }

      let btn = await scrollToSubmit(ws);
      if (btn.error) throw new Error(btn.error);
      if (btn.y < 0 || btn.y > btn.vh) throw new Error('submit button outside viewport after scroll: ' + JSON.stringify(btn));
      await clickAt(ws, btn.x, btn.y);
      await sleep(1500);

      let d = await modalInfo(ws, '确定提交');
      if (!d.open || !d.rect) {
        btn = await scrollToSubmit(ws);
        if (!btn.error && btn.y >= 0 && btn.y <= btn.vh) {
          await clickAt(ws, btn.x, btn.y);
          await sleep(1500);
          d = await modalInfo(ws, '确定提交');
        }
      }
      console.log('dialog: ' + JSON.stringify(d));
      if (!d.open || !d.rect) throw new Error('confirm dialog did not open');

      bad = await checkAnswers(ws, type, answers);
      console.log('with dialog open: ' + (bad.length ? 'INCOMPLETE ' + JSON.stringify(bad) : 'ALL_OK'));
      if (bad.length) {
        await clickModalButton(ws, '确定提交', '取 消');
        process.exitCode = 2;
        return;
      }

      await clickAt(ws, d.rect.x, d.rect.y);
      const result = await waitForSuccess(ws, 20000);
      console.log('SUBMITTED ' + JSON.stringify(result));
      if (!result || !result.success) process.exitCode = 2;
      await clickModalButton(ws, '提交成功', '确 定');
      return;
    }

    throw new Error('unknown command: ' + cmd);
  } finally {
    await closeWs(ws);
  }
}

main()
  .then(async () => {
    await sleep(120);
    process.exit(process.exitCode || 0);
  })
  .catch((e) => {
    console.error('ERROR ' + e.message);
    process.exit(1);
  });
