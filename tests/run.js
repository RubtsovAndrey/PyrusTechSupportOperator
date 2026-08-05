// Runs every check without any dependency: `node tests/run.js`.
// Also verifies what the platform itself will reject before a deploy — function syntax
// and the wiring of the node graph — because a broken edge is only visible in Pyrus.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ROOT } = require("./harness");

const SUITES = [
  "./receivewebhook.test.js", "./finalize.test.js", "./parseagentjson.test.js",
  "./createsubtask.test.js", "./tree.test.js", "./matchunit.test.js"
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

// The descriptions the model reads live in YAML that is edited by hand, and a stray quote
// there is not a typo the platform survives — it rejects the whole function. There is no
// YAML parser to lean on without dependencies, so the one mistake worth catching is
// checked directly: a quoted value that never closes its quote on the line it opened.
function checkYaml() {
  const rows = [];
  ["functions", "nodes"].forEach(sub => {
    walk(path.join(ROOT, sub), []).filter(f => f.endsWith(".yml")).forEach(file => {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const bad = [];
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const m = /^(\s*-?\s*[a-zA-Z-]+):\s+"/.exec(line);
        if (!m) return;
        const value = line.slice(line.indexOf('"', m[1].length));
        let quotes = 0;
        for (let c = 0; c < value.length; c++) {
          if (value[c] === "\\") { c++; continue; }
          if (value[c] === '"') quotes++;
        }
        // An odd count means the string is continued on the next line, which is legal only
        // in the platform's own escaped-continuation style — a trailing backslash.
        if (quotes % 2 !== 0 && !/\\$/.test(line)) bad.push(i + 1);
      });
      rows.push([rel, bad]);
    });
  });
  return rows;
}

// ── The knowledge catalog is code now ──
// With branching articles `go`, `else`, `onFail`, `start`, `branchOn`, `end` and the answer
// keys are executable. searchKnowledge handles a broken one gracefully — it turns it into
// `treeEnd: "escalate"` — and that is right at runtime but wrong for us: a typo in an
// article then looks exactly like «the bot handed this over to a human», and nobody ever
// finds out. Articles are written by hand, so they are linted before the deploy instead.
const END_KINDS = ["close", "subtask", "escalate"];

function checkCatalog() {
  const problems = [];
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/knowledge_catalog.json"), "utf8"));
  } catch (e) {
    return ["docs/knowledge_catalog.json is not readable JSON: " + e.message];
  }
  const topics = Array.isArray(catalog.topics) ? catalog.topics : null;
  if (!topics) return ["docs/knowledge_catalog.json has no topics array"];

  topics.forEach(topic => {
    const t = topic || {};
    const say = m => problems.push("[" + (t.key || "?") + "] " + m);
    if (!t.key) say("an article without a key cannot be routed to");

    const nodes = t.nodes && typeof t.nodes === "object" ? t.nodes : null;
    if (!nodes) {
      // A linear article: its onFail names an exit, never a node.
      const steps = (Array.isArray(t.steps) ? t.steps : []).filter(s => s && (typeof s === "string" || s.instruction));
      if (!steps.length && !t.solverInstruction && String(t.route || "solver") === "solver") {
        say("route is solver, but there is neither a step nor a solverInstruction to serve");
      }
      if (t.onFail && ["subtask", "escalate"].indexOf(String(t.onFail)) < 0) {
        say("onFail=\"" + t.onFail + "\" is neither subtask nor escalate, and a linear article has no nodes to jump to");
      }
      return;
    }

    const ids = Object.keys(nodes);
    // `end` values are legal targets too: that is how a branch leaves the article.
    const ref = (v, where) => {
      if (!v || END_KINDS.indexOf(String(v)) >= 0) return;
      if (ids.indexOf(String(v)) < 0) say(where + " points at \"" + v + "\", which is not a node of this article");
    };
    if (!t.start) say("no start is declared: the entry point then depends on key order in the file");
    else if (ids.indexOf(String(t.start)) < 0) say("start points at \"" + t.start + "\", which is not a node");
    ref(t.onFail, "onFail of the article");

    const reached = {};
    ids.forEach(id => {
      const n = nodes[id] || {};
      const ask = Array.isArray(n.ask) ? n.ask : [];
      const branches = Array.isArray(n.branches) ? n.branches : [];
      ref(n.go, id + ".go");
      ref(n["else"], id + ".else");
      ref(n.onFail, id + ".onFail");
      [n.go, n["else"], n.onFail].forEach(v => { if (v) reached[String(v)] = true; });
      branches.forEach((b, i) => {
        if (!b || !b.go) return say(id + ".branches[" + i + "] has no go, so it is not a branch at all");
        ref(b.go, id + ".branches[" + i + "]");
        reached[String(b.go)] = true;
        if (!(Array.isArray(b.when) ? b.when : [b.when]).filter(Boolean).length) {
          say(id + ".branches[" + i + "] declares no `when`, so nothing can ever choose it");
        }
      });
      ask.forEach((q, i) => {
        if (!q || !q.question) return say(id + ".ask[" + i + "] has no question text");
        if (!q.key) return say(id + ".ask[" + i + "] has no key: its answer cannot be stored");
        // A key with a dot or a $ addresses a different part of the document than it looks
        // like — searchKnowledge refuses such a key, and a refused key is a lost answer.
        if (/[.$]/.test(String(q.key))) say(id + ".ask key \"" + q.key + "\" contains . or $ and will be refused");
        // Without a label the operator reads the raw key: «newValue: +79001234567».
        if (!q.label) say(id + ".ask[" + q.key + "] has no label: the operator will see the bare key");
      });
      if (n.end && END_KINDS.indexOf(String(n.end)) < 0) {
        say(id + ".end=\"" + n.end + "\" is not one of " + END_KINDS.join("/"));
      }
      if (n.branchOn && !ask.some(q => q && q.key === n.branchOn)) {
        say(id + ".branchOn=\"" + n.branchOn + "\" is not one of the node's own ask keys");
      }
      if (branches.length && ask.length > 1 && !n.branchOn) {
        say(id + " asks " + ask.length + " questions and branches, but does not say which one the branches read");
      }
      // The two states searchKnowledge has to rescue at runtime, as `tree-dead-end`.
      if (!n.advice && !ask.length && !branches.length && !n.end && !n.go) {
        say(id + " neither speaks, asks, branches nor ends: the dialog cannot leave it");
      }
    });
    ids.forEach(id => {
      if (id !== String(t.start) && !reached[id]) say(id + " is unreachable from anywhere");
    });
  });
  return problems;
}

// ── The eight copies of writeState ──
// The platform does not let functions import each other, so `setPath` + `hasArrayValue` +
// `writeState` exist in every file that writes state. That is imposed, not chosen — but
// nothing was watching the copies, and they had already drifted into four variants. A patch
// like «check for arrays at every depth» has to land in all eight, and this is what says so.
// Comments and log wording may differ (receiveWebhook reports a missed point write as info,
// not a warning: on the first turn of a chat there is no document yet). The code may not.
function checkPrelude() {
  const RE = /function setPath\([\s\S]*?\n}\n[\s\S]*?function hasArrayValue\([\s\S]*?\n}\n[\s\S]*?function writeState\([\s\S]*?\n}\n/;
  const groups = {};
  walk(path.join(ROOT, "functions"), []).filter(f => f.endsWith("code.js")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const m = RE.exec(fs.readFileSync(file, "utf8"));
    if (!m) return;
    const code = m[0]
      .replace(/\/\/[^\n]*/g, "")           // comments explain history and may differ
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // log wording may differ
      // …and so may its level, for the same reason: in receiveWebhook a point write that
      // matches nothing is expected — the first turn of a chat has no document yet — so it
      // reports `info` where everyone else reports `warn`. That is a property of the
      // message, not of the write, and the write is what must not diverge.
      .replace(/\bLog\.\w+\b/g, "Log.log")
      .replace(/\s+/g, " ").trim();
    (groups[code] = groups[code] || []).push(rel);
  });
  return Object.keys(groups).map(k => groups[k]);
}

// ── Каталоги, которые стирает экспорт платформы ──
// Экспорт владеет всем корнем репозитория и удаляет `docs/`, `tests/`, `tools/` целиком.
// Список защищённых каталогов живёт в двух местах — в `tools/deploy.ps1`, который их
// восстанавливает, и в `docs/deploy.md`, где записано правило. Разъедутся — и каталог,
// добавленный в правило, но не в скрипт, потеряется на первом же деплое молча. Ровно тот же
// класс расхождения, что у восьми копий writeState, и проверяется так же.
function checkProtected() {
  const problems = [];
  const read = rel => {
    try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
    catch (e) { problems.push(rel + " не читается: " + e.message); return null; }
  };
  const script = read("tools/deploy.ps1");
  const doc = read("docs/deploy.md");
  if (!script || !doc) return problems;

  const m = /\$PROTECTED\s*=\s*@\(([^)]*)\)/.exec(script);
  if (!m) return ["в tools/deploy.ps1 не найден список $PROTECTED"];
  const dirs = m[1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (!dirs.length) return ["список $PROTECTED в tools/deploy.ps1 пуст"];

  dirs.forEach(d => {
    if (!fs.existsSync(path.join(ROOT, d))) problems.push("каталог " + d + "/ защищён скриптом, но его нет на диске");
    // Незаписанное в правило не переживёт человека, который правило читает, а скрипт нет.
    if (doc.indexOf("`" + d + "/`") < 0) problems.push("каталог " + d + "/ защищён скриптом, но не назван в docs/deploy.md");
  });
  // И наоборот: этот файл сам обязан быть под защитой, иначе проверка исчезнет вместе с ним.
  if (dirs.indexOf("tests") < 0) problems.push("tests/ не в списке $PROTECTED — сама эта проверка не переживёт деплой");
  return problems;
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

  console.log("\nyaml quoting");
  const yaml = checkYaml();
  yaml.forEach(([rel, bad]) => {
    total++;
    if (bad.length) {
      failed++;
      console.log("  FAIL  " + rel + ": unterminated quoted value on line " + bad.join(", "));
    }
  });
  console.log("  PASS  " + yaml.length + " files, every quoted value closes");

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

  console.log("\nknowledge catalog");
  const catalog = checkCatalog();
  total++;
  if (catalog.length) {
    failed++;
    console.log("  FAIL  " + catalog.length + " problem(s) in docs/knowledge_catalog.json:");
    catalog.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  every article resolves its nodes, keys and exits");
  }

  console.log("\nprotected directories");
  const protectedDirs = checkProtected();
  total++;
  if (protectedDirs.length) {
    failed++;
    console.log("  FAIL  " + protectedDirs.length + " проблем(а) с каталогами, которые стирает экспорт:");
    protectedDirs.forEach(p => console.log("        " + p));
  } else {
    console.log("  PASS  the rule and the script that enforces it name the same directories");
  }

  console.log("\nwriteState copies");
  const prelude = checkPrelude();
  total++;
  if (prelude.length > 1) {
    failed++;
    console.log("  FAIL  the copies of writeState have drifted into " + prelude.length + " versions:");
    prelude.forEach((files, i) => console.log("        " + (i + 1) + ") " + files.join(", ")));
  } else {
    console.log("  PASS  " + (prelude[0] || []).length + " copies of writeState, all identical in code");
  }

  for (const s of SUITES) {
    const res = await require(s)();
    total += res.total;
    failed += res.failed;
  }

  console.log("\n" + (failed ? "FAILED: " + failed + " of " + total : "ALL " + total + " CHECKS PASSED"));
  process.exit(failed ? 1 : 0);
})();
