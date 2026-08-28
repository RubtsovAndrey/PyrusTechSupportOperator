// Executes the real routing specification against the real generated catalog using the
// lexical fallback. Semantic RAG itself exists only on Agent Platform, so its scores still
// have to be collected there; locally we guarantee both sides of the contract: every
// in-scope case is first, and an explicitly out-of-domain case produces no candidate.
//
//   node tests/routing-catalog.test.js --report

const CATALOG = require("../docs/knowledge_catalog.json");
const CASES = require("./routing.cases.json").cases;
const { loadFunction, makeEnv, suite } = require("./harness");

const searchKnowledge = loadFunction(
  "functions/ID_Tools/searchKnowledge/code.js",
  ["query", "topicKey", "branch", "answers"]
);

async function find(query) {
  const env = makeEnv({
    db: {
      knowledge_catalog: JSON.parse(JSON.stringify(CATALOG)),
      config: { rag: { mode: "off" } }
    },
    contextValues: { dialog: { taskId: "1", incomingText: query, problemSummary: query } }
  });
  return searchKnowledge(env, [query, null, null, "{}"]);
}

async function main(options) {
  const report = options && options.report;
  const t = suite("generated catalog routing fallback");
  const negatives = [];

  for (const c of CASES) {
    const result = await find(c.query);
    const candidates = (result.topics || []).map(x => x.key + "=" + Number(x.score).toFixed(2));
    if (c.expect === null) {
      negatives.push({ query: c.query, candidates });
      t.check("fallback rejects «" + c.query + "»",
        result.found === false && candidates.length === 0, { candidates, note: c.note });
      continue;
    }
    const first = result.topics && result.topics[0] && result.topics[0].key;
    t.check("fallback routes «" + c.query + "» to " + c.expect,
      first === c.expect, { expected: c.expect, candidates });
  }

  if (report) {
    console.log("\nNegative / out-of-domain cases (the fallback must abstain):");
    negatives.forEach(row => console.log("  " + row.query + " -> " +
      (row.candidates.length ? row.candidates.join(" ") : "none")));
  }
  return t.report();
}

module.exports = main;

if (require.main === module) {
  main({ report: process.argv.indexOf("--report") >= 0 })
    .then(r => { process.exitCode = r.failed ? 1 : 0; })
    .catch(e => { console.error(e); process.exitCode = 1; });
}
