// Read-only execution of the actual operator retrieval function against MCP.
// node tools/operator-knowledge-live.js "original question" "variant 1" "variant 2"
// No Pyrus requests, model calls, KB writes or task-state writes are performed.
const { loadFunction, makeEnv } = require("../tests/harness");
const { callTool } = require("./mcp-client");

async function main() {
  const queries = process.argv.slice(2);
  if (!queries.length || queries.length > 3) throw new Error("Pass the original query and up to two variants");
  const calls = [];
  const failures = [];
  const env = makeEnv({
    db: { "state:retrieval-check": { runtime: { incomingCommentId: "read-only" } } },
    prev: { taskId: "retrieval-check", reason: "read-only retrieval check" },
    credentials: { [require("./project-bindings").projectBindings().kbCredentialKey]: "transport-owned-token" },
    contextValues: {
      dialog: { taskId: "retrieval-check", problemSummary: queries[0] },
      operatorSearchQueries: { taskId: "retrieval-check", originalQuery: queries[0], searchQueries: queries }
    }
  });
  env.Http.post = async request => {
    const { name, arguments: args } = request.body.params;
    if (!["search_content", "get_content", "search_in_content", "get_link_templates"].includes(name)) {
      throw new Error("Only read-only KB tools are allowed");
    }
    const started = Date.now();
    try {
      const payload = await callTool(name, args);
      calls.push({ name, request: args.request, elapsedMs: Date.now() - started });
      return { status: 200, body: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } };
    } catch (error) {
      failures.push({ name, error: error.message });
      throw error;
    }
  };
  const started = Date.now();
  const result = await loadFunction("functions/ID_Tools/findOperatorKnowledge/code.js")(env);
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, calls, failures,
    logs: env.logs, result }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
