// The platform graph must be acyclic, so five samples are explicit node chains.
const fs = require("fs");
const path = require("path");
const { parseYaml } = require("../tests/graph");
const { projectBindings } = require("./project-bindings");
const ROOT = path.resolve(__dirname, "..");
function build(root = ROOT) {
  const profile = projectBindings(root);
  if (profile.environment !== "dev") throw new Error("Evaluation nodes belong only in dev.");
  const source = parseYaml(fs.readFileSync(path.join(root, "nodes/functions/func_select_operator_evidence.yml"), "utf8"));
  const args = source.parameters.parameters;
  const base = { expectedProject: ["STRING", profile.projectKey], dbIntegration: ["INTEGRATION_DB", profile.databaseKey] };
  const out = {};
  function node(id, name, collection, fn, parameters, next, error, x, y) {
    const lines = ["---", "id: " + id, "name: " + name, "position:", "  x: " + x, "  y: " + y,
      "next-step: " + (next || "null"), "next-error-step: " + (error || "null"), "parameters:",
      "  type: USER", "  collection: " + collection, "  function: " + fn, "  is-tool: false"];
    const entries = Object.entries(parameters);
    lines.push(entries.length ? "  parameters:" : "  parameters: {}");
    for (const [key, [type, value]] of entries) lines.push("    " + key + ":", "      type: " + type,
      "      value: " + JSON.stringify(String(value)), "      filled-ai: false");
    lines.push("  context-config: null", "  hitl-tool-config: null", "  custom-headers: null");
    out["nodes/functions/" + id + ".yml"] = lines.join("\n") + "\n";
  }
  out["nodes/triggers/message/trigger_selector_eval.yml"] = "---\nid: trigger_selector_eval\nname: Dev - Selector evaluation\nposition:\n  x: 10\n  y: 1000\nnext-step: func_eval_prepare\nnext-error-step: null\nparameters: {}\n";
  out["nodes/conditions/cond_eval_ready.yml"] = "---\nid: cond_eval_ready\nname: Evaluation case ready?\nposition:\n  x: 810\n  y: 1000\nnext-step: func_eval_select_1\nnext-error-step: null\nparameters:\n  condition: \"(Context.getLastFunctionResult() || {}).ready === true\"\n  false-step: func_eval_idle\n";
  node("func_eval_idle", "Evaluation idle", "ID_Dev", "finishSelectorEval", {}, null, null, 1210, 1000);
  node("func_route_dev_test", "Route dev test command", "ID_Dev", "routeDevTest",
    { expectedProject: base.expectedProject }, "cond_dev_test_eval", null, 410, 250);
  out["nodes/conditions/cond_dev_test_eval.yml"] = "---\nid: cond_dev_test_eval\nname: Selector evaluation command?\nposition:\n  x: 810\n  y: 250\nnext-step: func_eval_prepare\nnext-error-step: null\nparameters:\n  condition: \"(Context.getLastFunctionResult() || {}).selectorEval === true\"\n  false-step: func_inspect_dev_setup\n";
  node("func_eval_prepare", "Prepare Selector evaluation", "ID_Dev", "prepareSelectorEval",
    { ...base, modelKey: ["LLM_MODEL", args.llmModel.value], maxCompletionTokens: ["INTEGER", args.maxCompletionTokens.value] },
    "cond_eval_ready", null, 410, 1000);
  for (let i = 1; i <= 5; i++) {
    const y = 1350 + (i - 1) * 400;
    node("func_eval_select_" + i, "Eval Selector " + i, "ID_Tools", "selectOperatorEvidence",
      { llmModel: ["LLM_MODEL", args.llmModel.value], maxCompletionTokens: ["INTEGER", args.maxCompletionTokens.value] },
      "func_eval_capture_" + i, "func_eval_error_" + i, 10, y);
    node("func_eval_capture_" + i, "Capture selection " + i, "ID_Dev", "captureSelectorEval",
      { ...base, transportError: ["BOOLEAN", false] }, "func_eval_parse_" + i, null, 410, y);
    node("func_eval_error_" + i, "Capture transport error " + i, "ID_Dev", "captureSelectorEval",
      { ...base, transportError: ["BOOLEAN", true] }, "func_eval_parse_" + i, null, 410, y + 150);
    node("func_eval_parse_" + i, "Validate eval selection " + i, "ID_Tools", "parseOperatorEvidence", {},
      "func_eval_collect_" + i, "func_eval_collect_" + i, 810, y);
    node("func_eval_collect_" + i, "Collect sample " + i, "ID_Dev", "collectSelectorEval",
      { ...base, lastIteration: ["BOOLEAN", i === 5] }, i === 5 ? null : "func_eval_select_" + (i + 1), null, 1210, y);
  }
  const schemas = {
    routeDevTest: { expectedProject: base.expectedProject },
    finishSelectorEval: {},
    prepareSelectorEval: { ...base, modelKey: ["LLM_MODEL"], maxCompletionTokens: ["INTEGER"] },
    captureSelectorEval: { ...base, transportError: ["BOOLEAN"] },
    collectSelectorEval: { ...base, lastIteration: ["BOOLEAN"] }
  };
  for (const [name, parameters] of Object.entries(schemas)) {
    const lines = ["---", "id: " + name, "name: " + name,
      "description: Dev-only evaluation harness; no Pyrus actions.",
      "response-description: Evaluation control or result; never a partner reply.",
      Object.keys(parameters).length ? "parameters:" : "parameters: []"];
    for (const [key, [type]] of Object.entries(parameters)) lines.push("- name: " + key, "  type: " + type,
      "  required: true", "  description: " + key + " for the isolated dev evaluation.");
    lines.push("language: JAVASCRIPT");
    out["functions/ID_Dev/" + name + "/schema.yml"] = lines.join("\n") + "\n";
  }
  return out;
}
if (require.main === module) {
  const check = process.argv.slice(2).join() === "--check";
  if (process.argv.length > 2 && !check) throw new Error("Use --check or no arguments.");
  const stale = [];
  for (const [rel, content] of Object.entries(build())) {
    const file = path.join(ROOT, rel);
    if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) stale.push(rel); }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  }
  if (stale.length) { console.error("Stale evaluation definitions:\n" + stale.join("\n")); process.exitCode = 1; }
  else console.log(check ? "Evaluation graph is current." : "Evaluation graph generated.");
}
module.exports = { build };
