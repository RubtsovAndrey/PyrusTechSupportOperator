const { suite, makeEnv } = require("./harness");
const { loadGraph, runTurn } = require("./graph");
const { projectBindings } = require("../tools/project-bindings");
const config = require("../docs/environments/dev-config.json");

async function main() {
  const t = suite("dev setup diagnostics");
  const graph = loadGraph();
  const node = graph.func_inspect_dev_setup;
  const bindings = projectBindings();
  t.check("setup trigger routes commands before standalone diagnostics", graph.trigger_dev_setup.nextStep === "func_route_dev_test" &&
    graph.cond_dev_test_eval.falseStep === node.id && !node.nextStep && !node.nextErrorStep && !node.isTool);
  t.check("diagnostics use registered dev bindings", node.values.join() === [bindings.projectKey, bindings.databaseKey,
    bindings.kbCredentialKey, bindings.models.default, bindings.models.selector].join());
  async function run(options = {}) {
    const env = makeEnv({ db: options.empty ? {} : { config, knowledge_catalog: { topics: [{ key: "synthetic" }] } },
      credentials: options.empty ? {} : { [bindings.kbCredentialKey]: "PRIVATE_TOKEN" } });
    env.Context.getProjectShortName = () => options.foreign ? "another-project" : bindings.projectKey;
    env.Context.isTestChannel = () => !options.live;
    env.Context.getMessageContent = () => ({ text: options.command || "проверка" });
    const http = []; const llm = [];
    env.Http.post = async args => {
      http.push(args);
      if (options.fail) throw new Error("private request headers PRIVATE_TOKEN");
      return { status: 200, body: 'event: message\ndata: {"jsonrpc":"2.0","id":"dev-setup","result":{"tools":[{"name":"search_content"},{"name":"get_content"}]}}\n\n' };
    };
    env.Llm = { sendRequest: async args => {
      llm.push(args);
      if (options.fail) throw new Error("private request PRIVATE_TOKEN");
      return { text: options.text === undefined ? '{"ok":true}' : options.text, toolCalls: options.toolCalls || [] };
    } };
    try {
      if (options.graph) {
        const trace = await runTurn(graph, env, "trigger_dev_setup", { agent: () => { throw new Error("No agents."); } });
        return { result: env.prev, trace, env, http, llm };
      }
      return { result: await node.code(env, node.values), env, http, llm };
    }
    catch (error) { return { error, env, http, llm }; }
  }
  let r = await run();
  for (const command of ["проверка", "/start"]) {
    const routed = await run({ graph: true, command });
    t.check("setup command still reaches diagnostics: " + command, routed.result.kind === "dev_setup_check" &&
      routed.llm.length === 2 && !routed.env.puts.length && !routed.trace.some(s => s.error));
  }
  t.check("ready configuration and integrations are reported without secret values",
    r.result.checks.config === "ok" && r.result.checks.catalog === "present" && r.result.checks.kbToolDiscovery === "ok" &&
    r.result.checks.defaultModel === "ok" && r.result.checks.selectorModel === "ok" &&
    !JSON.stringify([r.result, r.env.logs]).includes("PRIVATE_TOKEN"), r.result);
  t.check("only read-only MCP discovery is requested", r.http.length === 1 && r.http[0].url === "https://knowledgebase.dodois.io/mcp" &&
    r.http[0].body.method === "tools/list" && !r.http[0].headers["Mcp-Mode"]);
  t.check("both model probes use bounded tool-free requests", r.llm.length === 2 && r.llm.every(c => c.tools.length === 0 && c.maxCompletionTokens === 512));
  t.check("configuration, task states and Pyrus are never written", r.env.puts.length === 0 && r.env.updates.length === 0 && r.env.posts.length === 0);
  r = await run({ empty: true });
  t.check("an empty new database and missing token are explicit", r.result.checks.config === "missing" && r.result.checks.catalog === "missing" &&
    r.result.checks.kbCredential === "missing" && r.result.checks.kbToolDiscovery === "skipped" && r.http.length === 0, r.result);
  r = await run({ fail: true });
  t.check("provider failures do not expose request headers in diagnostics", r.result.checks.kbToolDiscovery === "failed" &&
    r.result.checks.selectorModel === "failed" && !JSON.stringify([r.result, r.env.logs]).includes("PRIVATE_TOKEN"), r.result);
  r = await run({ text: '```json\n{"ok":true}\n```' });
  t.check("a successful model response inside one Markdown fence is accepted",
    r.result.checks.defaultModel === "ok" && r.result.checks.selectorModel === "ok", r.result);
  for (const options of [{ text: 'Here is the result: {"ok":true}' }, { text: '{"ok":true}{"ok":false}' },
    { text: '```json\n{"ok":true}\n```\nExtra text' }, { text: '{"ok":false}' }, { toolCalls: [{ name: "unexpected" }] }]) {
    r = await run(options);
    t.check("unexpected model output is distinct from transport failure: " + JSON.stringify(options),
      r.result.checks.defaultModel === "unexpected_response" && r.result.checks.selectorModel === "unexpected_response", r.result);
  }
  for (const options of [{ foreign: true }, { live: true }]) {
    r = await run(options);
    t.check("wrong project or non-test execution stops before accessing integrations: " + JSON.stringify(options),
      !!r.error && !r.env.creds.length && !r.http.length && !r.llm.length && !r.env.puts.length);
  }
  return t.report();
}
module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
