// 试卷诊断器：在已打开的 /course_paper/ 页面执行。
//   node scripts/x.mjs --tab course_paper scripts/probe-paper.js
// 输出：4 个 id、publish、我的答题记录来源、createRecord 是否被截止拦截。
(async () => {
  const base = "https://whut.ai-augmented.com";
  const tok = (document.cookie.match(/WT-prd-access-token=([^;]+)/) || [])[1];
  const H = { authorization: "Bearer " + tok, "content-type": "application/json; charset=utf-8", "x-language": "zh-CN" };
  const getj = async (p) => { const r = await fetch(base + p, { headers: H, credentials: "include" }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const postj = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: H, credentials: "include", body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };

  const m = location.pathname.match(/course_paper\/mycourse\/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return { error: "not a course_paper url", href: location.href };
  const [, group_id, node_id, task_id, paper_id] = m;

  const paper = await getj(`/api/jx-iresource/survey/course/queryStuPaper/v2?paper_id=${paper_id}&group_id=${group_id}&node_id=${node_id}`);
  const pub = paper.json?.data?.publish_record || {};
  const flow = await getj(`/api/jx-iresource/survey/course/task/flow/v2?node_id=${node_id}&group_id=${group_id}`);
  const fd = flow.json?.data || {};
  const recs = Array.isArray(fd.task_flow_record) ? fd.task_flow_record : [];
  const recordFromFlow = recs.find((r) => r.answer_record_id)?.answer_record_id || null;

  const chk = await getj(`/api/jx-iresource/survey/course/check/answer/v2?group_id=${group_id}&task_id=${task_id}`);

  let create = null;
  if (!recordFromFlow) {
    const c = await postj("/api/jx-iresource/survey/createRecord/v2", { paper_id, group_id, publish_id: pub.id });
    create = { code: c.json?.code, message: c.json?.message, record_id: c.json?.data?.id || null };
  }

  return {
    ids: { group_id, node_id, task_id, paper_id, publish_id: pub.id },
    window: { start: pub.start_time, end: pub.end_time, repetition: pub.repetition, allowAfterSubmit: pub.is_allow_after_submitted, limitTime: pub.limit_time },
    taskEndTime: fd.task?.end_time,
    recordFromFlow,
    check: chk.json?.data,
    createRecord: create,
    verdict: recordFromFlow ? "已有答题记录，可直接逐题 save + submit"
      : (create && create.record_id ? "记录已创建，可继续作答" : "被服务端拦截：无法创建答题记录 → 无法提交"),
  };
})()