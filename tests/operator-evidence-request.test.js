const fs = require("fs");
const path = require("path");
const { loadFunction, makeEnv, suite, ROOT } = require("./harness");
const { parseYaml, loadGraph, validateFunctionArguments } = require("./graph");
const select = loadFunction("functions/ID_Tools/selectOperatorEvidence/code.js",
  ["llmModel", "maxCompletionTokens"]);
const node = parseYaml(fs.readFileSync(path.join(ROOT, "nodes/functions/func_select_operator_evidence.yml"), "utf8"));
const graphNode = loadGraph().func_select_operator_evidence;
const args = Object.fromEntries(graphNode.names.map((name, i) => [name, graphNode.values[i]]));
const request = { id: "request-17", taskId: "17", incomingCommentId: "22", query: "Как изменить фото?",
  candidates: [{ id: "c0", passages: [{ id: "p0", text: "Загрузите фотографию в карточку сотрудника." }] }] };

async function run(response, input) {
  const env = makeEnv({ contextValues: { dialog: { taskId: "17", policy: "PRIVATE_POLICY" },
    operatorEvidenceRequest: input === undefined ? request : input, oldContext: "PRIVATE_HISTORY" } });
  env.notes.push("PRIVATE_NOTES");
  const calls = [];
  env.Llm = { sendRequest: async value => {
    calls.push(value);
    if (response instanceof Error) throw response;
    return response;
  } };
  try { return { output: await select(env, [args.llmModel, args.maxCompletionTokens]), calls, env }; }
  catch (error) { return { error, calls, env }; }
}

async function main() {
  const t = suite("operator evidence explicit LLM request");
  t.check("function node parameters match the platform import descriptor format",
    validateFunctionArguments(node.parameters.parameters).length === 0);
  t.check("the old scalar parameter format is rejected before deployment",
    validateFunctionArguments({ llmModel: args.llmModel, maxCompletionTokens: 8192 }).length === 2);
  t.check("primitive descriptor values must be serialized as strings and filled-ai as boolean",
    validateFunctionArguments({ budget: { type: "INTEGER", value: 8192, "filled-ai": false },
      model: { type: "LLM_MODEL", value: args.llmModel } }).length === 2);
  const frame = JSON.stringify({ kind: "operator_evidence", requestId: request.id, selected: [] });
  let r = await run({ text: frame, toolCalls: [] });
  const call = r.calls[0];
  t.check("the configured model integration exists",
    fs.existsSync(path.join(ROOT, "integrations/llm", args.llmModel + ".yml")), args);
  t.check("one explicit request uses the configured integration and budget with zero tools",
    r.calls.length === 1 && call.llmModelKey === args.llmModel && call.maxCompletionTokens === 8192 &&
    Array.isArray(call.tools) && call.tools.length === 0 && !JSON.stringify(call).includes("switchToState"), call);
  t.check("the request follows the local platform schema and uses explicit text messages",
    Object.keys(call).every(k => ["llmModelKey", "messages", "tools", "maxCompletionTokens"].includes(k)) &&
    call.messages.every(m => typeof m.text === "string" && !m.content) &&
    call.messages[0].role === "system" && call.messages[1].role === "user", call);
  t.check("only the evidence request enters user context, without task history, policy or notes",
    JSON.parse(call.messages[1].text).operatorEvidenceRequest.id === request.id &&
    !/PRIVATE_/.test(JSON.stringify(call)), call.messages);
  t.check("raw text is returned unchanged for the existing provenance boundary",
    r.output === frame, r.output);
  for (const response of [null, {}, { text: " " }, { text: frame, toolCalls: [{ name: "switchToState" }] }]) {
    r = await run(response);
    t.check("empty or tool-call output cannot bypass the provenance parser: " + JSON.stringify(response),
      r.output === null && !r.error && r.env.posts.length === 0, r);
  }
  r = await run(new Error("upstream rejected request"));
  t.check("provider failure follows the workflow error edge with no external action",
    r.error && /upstream/.test(r.error.message) && r.calls.length === 1 && r.env.posts.length === 0, r);
  for (const input of [{}, Object.assign({}, request, { taskId: "18" }), Object.assign({}, request, { candidates: [] })]) {
    r = await run({ text: frame }, input);
    t.check("missing, wrong-task or empty candidates skip the model: " + JSON.stringify(input),
      r.output === null && r.calls.length === 0, r);
  }
  return t.report();
}
module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
