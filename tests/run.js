// Runs every check without any dependency: `node tests/run.js`.
// Also verifies what the platform itself will reject before a deploy — function syntax
// and the wiring of the node graph — because a broken edge is only visible in Pyrus.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT } = require("./harness");

const SUITES = [
  "./receivewebhook.test.js", "./finalize.test.js", "./parseagentjson.test.js",
  "./createsubtask.test.js", "./tree.test.js"
];

// Function parameters declared in schema.yml, needed to wrap the source exactly as the
// platform does. Top-level `await` and `return` are legal there, so `node --check` alone
// reports false failures.
const FUNCTION_PARAMS = {
  "functions/ID_Actions/applyOutcome/code.js": ["outcome", "replyText"],
  "functions/ID_Tools/parseAgentJson/code.js": ["stage"],
  "functions/ID_Tools/searchKnowledge/code.js": ["query", "topicKey", "branch", "answers"],
  "functions/ID_Tools/matchUnit/code.js": ["query", "scope"]
};

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

function checkSyntax() {
  const rows = [];
  const dir = path.join(ROOT, "functions");
  walk(dir, []).filter(f => f.endsWith("code.js")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const params = (FUNCTION_PARAMS[rel] || []).join(", ");
    try {
      new vm.Script("(async function(" + params + "){\n" + fs.readFileSync(file, "utf8") + "\n})");
      rows.push([rel, true, null]);
    } catch (e) {
      rows.push([rel, false, e.message]);
    }
  });
  return rows;
}

function checkGraph() {
  const ids = new Set();
  const refs = [];
  const dir = path.join(ROOT, "nodes");
  const files = walk(dir, []).filter(f => f.endsWith(".yml"));
  files.forEach(file => {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const id = /^id:\s*(\S+)/m.exec(src);
    if (id) ids.add(id[1]);
    [/^next-step:\s*(\S+)/m, /^next-error-step:\s*(\S+)/m, /^\s+false-step:\s*(\S+)/m].forEach(re => {
      const m = re.exec(src);
      if (m && m[1] !== "null") refs.push([rel, m[1]]);
    });
  });
  return { nodes: ids.size, refs: refs.length, broken: refs.filter(([, r]) => !ids.has(r)) };
}

(async () => {
  let total = 0, failed = 0;

  console.log("\nfunction syntax (platform async wrapper)");
  const syntax = checkSyntax();
  syntax.forEach(([rel, ok, err]) => {
    total++;
    if (!ok) failed++;
    console.log("  " + (ok ? "PASS  " : "FAIL  ") + rel + (ok ? "" : "\n        " + err));
  });

  console.log("\nnode graph");
  const graph = checkGraph();
  total++;
  if (graph.broken.length) {
    failed++;
    console.log("  FAIL  dangling references:");
    graph.broken.forEach(([f, r]) => console.log("        " + f + " -> " + r));
  } else {
    console.log("  PASS  " + graph.nodes + " nodes, " + graph.refs + " references, all resolve");
  }

  for (const s of SUITES) {
    const res = await require(s)();
    total += res.total;
    failed += res.failed;
  }

  console.log("\n" + (failed ? "FAILED: " + failed + " of " + total : "ALL " + total + " CHECKS PASSED"));
  process.exit(failed ? 1 : 0);
})();
