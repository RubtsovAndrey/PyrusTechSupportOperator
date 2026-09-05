// Explicit model fixtures test orchestration and validation, never model relevance.
const { suite, makeEnv } = require("./harness");
const { loadGraph, runTurn, validateConditionParameters } = require("./graph");
const { projectBindings } = require("../tools/project-bindings");
const { makeBundle } = require("../tools/build-selector-eval-cases");

async function main() {
  const t = suite("isolated five-sample Selector evaluation");
  const graph = loadGraph();
  t.check("condition validation rejects missing, null and empty false-step before deployment",
    [{}, { "false-step": null }, { "false-step": "" }, { "false-step": "null" }]
      .every(p => validateConditionParameters(p).length === 1) &&
    validateConditionParameters({ "false-step": "func_eval_idle" }).length === 0);
  const binding = projectBindings();
  const quote = "В карточке сотрудника загрузите фотографию размером 300×300 пикселей.";
  const noise = "Измените изображение продукта в карточке меню ресторана.";
  const seed = { request: { id: "OLD_ID", taskId: "REAL_TASK", incomingCommentId: "REAL_COMMENT", query: "Как изменить фото курьера?",
    candidates: [
      { id: "c0", articleId: "noise", spaceId: "test", title: "Продукты", passages: [{ id: "p0", text: noise }] },
      { id: "c1", articleId: "employee", spaceId: "test", title: "Карточка сотрудника", passages: [{ id: "p1", text: quote }] }
    ] } };
  const bundle = makeBundle(seed, seed);
  t.check("bundle omits real task and comment identifiers", !/OLD_ID|REAL_TASK|REAL_COMMENT/.test(JSON.stringify(bundle)));
  t.check("single-article and negative controls preserve source text and candidate IDs",
    bundle.cases["empty-single"].candidates[0].id === "c1" && bundle.cases["empty-single"].candidates[0].passages[0].text === quote &&
    bundle.cases["noise-only"].candidates.every(c => c.id !== "c1") && !bundle.cases["noise-only"].requiredEvidence.length);
  const reachable = new Set();
  function visit(id) { if (!id || reachable.has(id)) return; reachable.add(id); const n = graph[id]; if (!n) return;
    [n.nextStep, n.nextErrorStep, n.falseStep].forEach(visit); }
  visit("trigger_selector_eval");
  t.check("no evaluation path reaches an agent or Pyrus action", [...reachable].every(id => graph[id] && graph[id].kind !== "agent" &&
    (!graph[id].fn || ["prepareSelectorEval", "captureSelectorEval", "collectSelectorEval", "finishSelectorEval", "selectOperatorEvidence", "parseOperatorEvidence"].includes(graph[id].fn))));
  t.check("all five calls use the current chat Selector implementation and settings",
    [1, 2, 3, 4, 5].every(i => graph["func_eval_select_" + i].fn === graph.func_select_operator_evidence.fn &&
      graph["func_eval_select_" + i].values.join() === graph.func_select_operator_evidence.values.join() &&
      graph["func_eval_parse_" + i].fn === graph.func_parse_operator_evidence.fn));

  async function run(options = {}) {
    const env = makeEnv({ db: { selector_eval_cases: bundle, "state:123": { private: "UNTOUCHED" } } });
    env.Context.getMessageContent = () => ({ text: options.caseId === undefined ? "success-full" : options.caseId });
    env.Context.getProjectShortName = () => options.foreign ? "foreign" : binding.projectKey;
    env.Context.isTestChannel = () => !options.live;
    env.Context.getRequestId = () => "test-eval-request";
    env.AgentContext.clearContext = () => { Object.keys(env.values).forEach(k => delete env.values[k]); env.notes.length = 0; };
    const calls = []; const deleted = [];
    const originalDelete = env.Db.delete;
    env.Db.delete = args => { deleted.push(args.documentKey); return originalDelete(args); };
    env.Http.post = async () => { throw new Error("No HTTP/Pyrus is allowed in this evaluation."); };
    env.Llm = { sendRequest: async args => {
      calls.push(args);
      const request = JSON.parse(args.messages[1].text).operatorEvidenceRequest;
      const mode = (options.outputs || [])[calls.length - 1] || "selected";
      if (mode === "error") throw new Error("synthetic provider error");
      const selected = mode === "empty" ? [] : [{ candidateId: mode === "noise" ? "c0" : "c1",
        passageId: mode === "noise" ? "p0" : "p1", quote: mode === "bad" ? quote + " UNSUPPORTED" : mode === "noise" ? noise : quote }];
      return { text: JSON.stringify({ kind: "operator_evidence", requestId: request.id, selected }), toolCalls: [] };
    } };
    const trace = await runTurn(graph, env, "trigger_selector_eval", { agent: () => { throw new Error("No agents."); } });
    return { env, calls, deleted, trace, report: env.prev, run: env.db["selector_eval_run:test-eval-request"] };
  }
  let r = await run();
  t.check("one command performs exactly five successful samples", r.calls.length === 5 && r.report.samples === 5 && r.report.expectedMet === 5 && !r.trace.some(s => s.error), r.report);
  t.check("every request within a batch is byte-identical", r.calls.every(c => JSON.stringify(c) === JSON.stringify(r.calls[0])));
  t.check("expected answers and prior outputs never enter the model input", !/requiredEvidence|expectedMet|UNTOUCHED/.test(JSON.stringify(r.calls)));
  t.check("raw selections and parser-verified quotes remain in the run record", r.run.status === "complete" && r.run.rows.length === 5 &&
    r.run.rows.every(row => row.raw && row.articles[0].evidence[0].quote === quote));
  t.check("only synthetic state and evaluation report keys are written", r.env.puts.every(p => p.documentKey === "state:eval:test-eval-request" || p.documentKey === "selector_eval_run:test-eval-request") && !r.env.posts.length);
  t.check("real task states survive and only this batch's synthetic state is removed",
    r.deleted.join() === "state:eval:test-eval-request" && r.env.db["state:123"].private === "UNTOUCHED" && !r.env.db["state:eval:test-eval-request"]);
  t.check("parser context isolation is followed by clean request restoration", Object.keys(r.env.values).length === 0);
  const callsBefore = r.calls.length;
  const prepare = graph.func_eval_prepare;
  let duplicate = false;
  try { await prepare.code(r.env, prepare.values); } catch (e) { duplicate = /already exists/.test(e.message); }
  t.check("duplicate platform request cannot overwrite a run or repeat paid calls", duplicate && r.calls.length === callsBefore && r.run.rows.length === 5);

  r = await run({ outputs: ["selected", "empty", "bad", "error", "noise"] });
  t.check("empty, invalid, transport-error and irrelevant valid outputs stay distinct",
    r.report.statuses.join() === "selected,no_evidence,invalid,transport_error,selected" && r.report.expectedMet === 1, r.report);
  t.check("transport rejection still permits remaining samples and cleanup", r.calls.length === 5 && r.report.cleanup === "ok" && !r.trace.some(s => s.dead));
  r = await run({ caseId: "noise-only", outputs: Array(5).fill("empty") });
  t.check("negative control expects empty selections", r.report.expectedMet === 5 && r.report.statuses.every(s => s === "no_evidence"), r.report);
  r = await run({ caseId: "empty-single" });
  t.check("single-article control actually sends one unchanged candidate", r.calls.length === 5 && r.calls.every(c => {
    const q = JSON.parse(c.messages[1].text).operatorEvidenceRequest; return q.candidates.length === 1 && q.candidates[0].id === "c1";
  }));
  for (const options of [{ caseId: "/start" }, { caseId: "unknown-case" }, { foreign: true }, { live: true }]) {
    r = await run(options);
    t.check("no paid calls or writes for warm-up, invalid case or forbidden context: " + JSON.stringify(options), !r.calls.length && !r.env.puts.length);
    if (options.caseId === "/start") t.check("warm-up ends through the explicit idle node without an error",
      r.trace[r.trace.length - 1].id === "func_eval_idle" && !r.trace.some(s => s.error || s.dead) && r.report.ready === false);
  }
  return t.report();
}
module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
