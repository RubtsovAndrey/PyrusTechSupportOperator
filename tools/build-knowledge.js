// Single source of truth for the bot's business articles.
//
// Authors edit only:
//   docs/knowledge/index.json
//   docs/knowledge/topics/<topicKey>.json
//
// This command deterministically generates:
//   docs/knowledge_catalog.json   — upload as the `knowledge_catalog` DB document
//   docs/rag/<topicKey>.md        — upload to the Agent Platform knowledge base
//   docs/knowledge-manifest.json  — hashes for detecting drift between representations
//
// Commands:
//   node tools/build-knowledge.js
//   node tools/build-knowledge.js --check
//   node tools/build-knowledge.js --import path/to/catalog.json   (one-time migration)

// The generator intentionally has no dependencies beyond Node.js.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "docs", "knowledge");
const SOURCE_INDEX = path.join(SOURCE_ROOT, "index.json");
const SOURCE_TOPICS = path.join(SOURCE_ROOT, "topics");
const CATALOG_OUT = path.join(ROOT, "docs", "knowledge_catalog.json");
const RAG_OUT = path.join(ROOT, "docs", "rag");
const MANIFEST_OUT = path.join(ROOT, "docs", "knowledge-manifest.json");

const KEY_RE = /^[A-Za-z0-9_-]+$/;
const UBIQUITOUS = [
  "пиццер", "кофейн", "додо", "dodo", "дринкит", "drinkit",
  "точк", "юнит", "партнёр", "партнер", "заведени"
];

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(rel(file) + " is not readable JSON: " + e.message);
  }
}

function assertKey(key, where) {
  if (!key || !KEY_RE.test(String(key))) {
    throw new Error(where + ": topic key must match " + KEY_RE);
  }
}

function readSources() {
  if (!fs.existsSync(SOURCE_INDEX)) {
    throw new Error("Missing " + rel(SOURCE_INDEX) + ". Import the current catalog once with: " +
      "node tools/build-knowledge.js --import docs/knowledge_catalog.json");
  }
  const index = readJson(SOURCE_INDEX);
  const keys = index && Array.isArray(index.topics) ? index.topics.map(String) : null;
  if (!keys || !keys.length) throw new Error(rel(SOURCE_INDEX) + " has no non-empty topics array");

  const seen = {};
  keys.forEach((key, i) => {
    assertKey(key, rel(SOURCE_INDEX) + ".topics[" + i + "]");
    if (seen[key]) throw new Error(rel(SOURCE_INDEX) + ": duplicate topic " + key);
    seen[key] = true;
  });

  const topics = keys.map(key => {
    const file = path.join(SOURCE_TOPICS, key + ".json");
    if (!fs.existsSync(file)) throw new Error("Topic " + key + " is listed but " + rel(file) + " is missing");
    const topic = readJson(file);
    if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
      throw new Error(rel(file) + " must contain one topic object");
    }
    if (String(topic.key || "") !== key) {
      throw new Error(rel(file) + " contains key " + JSON.stringify(topic.key) + ", expected " + key);
    }
    if (!String(topic.description || "").trim()) {
      throw new Error(rel(file) + " has no description for routing");
    }
    if (!Array.isArray(topic.phrasings) || !topic.phrasings.some(Boolean)) {
      throw new Error(rel(file) + " has no phrasings; every topic needs real partner wording");
    }
    return topic;
  });

  const extra = fs.readdirSync(SOURCE_TOPICS)
    .filter(file => file.endsWith(".json"))
    .map(file => file.replace(/\.json$/, ""))
    .filter(key => !seen[key]);
  if (extra.length) {
    throw new Error("Topic source files are not listed in " + rel(SOURCE_INDEX) + ": " + extra.join(", "));
  }

  return { keys, topics };
}

function ragBody(topic) {
  const phrasings = topic.phrasings.filter(Boolean).map(String);
  return [
    "topicKey: " + topic.key,
    "",
    String(topic.description || "").trim(),
    ""
  ].concat(phrasings.map(p => "- " + p.trim()))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function ubiquitousIn(text) {
  const words = String(text || "").toLowerCase().replace(/ё/g, "е")
    .split(/[^0-9a-zа-я]+/).filter(Boolean);
  const hit = [];
  words.forEach(word => UBIQUITOUS.forEach(stem => {
    if (word.indexOf(stem) === 0 && hit.indexOf(word) < 0) hit.push(word);
  }));
  return hit;
}

function expectedArtifacts() {
  const source = readSources();
  const catalogText = json({ topics: source.topics });
  const rag = {};
  source.topics.forEach(topic => { rag[topic.key] = ragBody(topic); });

  const manifest = {
    schemaVersion: 1,
    topicCount: source.topics.length,
    catalogSha256: sha256(catalogText),
    topics: source.topics.map(topic => {
      const sourceText = json(topic);
      return {
        key: topic.key,
        source: "docs/knowledge/topics/" + topic.key + ".json",
        sourceSha256: sha256(sourceText),
        rag: "docs/rag/" + topic.key + ".md",
        ragSha256: sha256(rag[topic.key])
      };
    })
  };

  const files = {};
  files[CATALOG_OUT] = catalogText;
  Object.keys(rag).forEach(key => { files[path.join(RAG_OUT, key + ".md")] = rag[key]; });
  files[MANIFEST_OUT] = json(manifest);
  return { source, files, manifest };
}

function staleRagFiles(source) {
  if (!fs.existsSync(RAG_OUT)) return [];
  const expected = {};
  source.keys.forEach(key => { expected[key + ".md"] = true; });
  return fs.readdirSync(RAG_OUT)
    .filter(file => file.endsWith(".md") && !expected[file])
    .map(file => path.join(RAG_OUT, file));
}

function inspect() {
  const expected = expectedArtifacts();
  const changed = Object.keys(expected.files).filter(file =>
    !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected.files[file]);
  return { expected, changed, stale: staleRagFiles(expected.source) };
}

function writeBuild() {
  const result = inspect();
  fs.mkdirSync(RAG_OUT, { recursive: true });
  Object.keys(result.expected.files).forEach(file => {
    if (result.changed.indexOf(file) < 0) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result.expected.files[file], "utf8");
  });
  result.stale.forEach(file => fs.unlinkSync(file));
  return result;
}

function importCatalog(fileArg) {
  if (!fileArg) throw new Error("--import needs a path to a catalog JSON file");
  const input = path.resolve(fileArg);
  const catalog = readJson(input);
  const topics = catalog && Array.isArray(catalog.topics) ? catalog.topics : null;
  if (!topics || !topics.length) throw new Error(rel(input) + " has no topics array");

  if (fs.existsSync(SOURCE_INDEX) ||
      (fs.existsSync(SOURCE_TOPICS) && fs.readdirSync(SOURCE_TOPICS).some(f => f.endsWith(".json")))) {
    throw new Error("Refusing to overwrite existing topic sources in docs/knowledge/. " +
      "Import is a one-time migration; edit the topic files after it.");
  }

  const keys = [];
  const seen = {};
  topics.forEach((topic, i) => {
    const key = String(topic && topic.key || "");
    assertKey(key, "catalog.topics[" + i + "]");
    if (seen[key]) throw new Error("Duplicate topic key in imported catalog: " + key);
    seen[key] = true;
    keys.push(key);
  });

  fs.mkdirSync(SOURCE_TOPICS, { recursive: true });
  fs.writeFileSync(SOURCE_INDEX, json({ schemaVersion: 1, topics: keys }), "utf8");
  topics.forEach(topic => {
    fs.writeFileSync(path.join(SOURCE_TOPICS, topic.key + ".json"), json(topic), "utf8");
  });
  return topics.length;
}

function warnings(source) {
  return source.topics.map(topic => ({
    key: topic.key,
    words: ubiquitousIn([topic.description].concat(topic.phrasings || []).join(" "))
  })).filter(row => row.words.length);
}

function printBuild(result) {
  console.log("Topics: " + result.expected.source.topics.length);
  console.log("Generated: " + (result.changed.length
    ? result.changed.map(rel).join(", ") : "already up to date"));
  if (result.stale.length) console.log("Removed stale RAG documents: " + result.stale.map(rel).join(", "));
  const magnets = warnings(result.expected.source);
  if (magnets.length) {
    console.log("Review context words that may attract unrelated requests:");
    magnets.forEach(row => console.log("  " + row.key + ": " + row.words.join(", ")));
  }
  console.log("Upload docs/knowledge_catalog.json to DB document `knowledge_catalog`, then");
  console.log("upload docs/rag/*.md to the RAG project, remove stale sources, and reindex it.");
}

function main(args) {
  const argv = args || process.argv.slice(2);
  if (argv[0] === "--import") {
    const count = importCatalog(argv[1]);
    console.log("Imported " + count + " topic source files.");
    const result = writeBuild();
    printBuild(result);
    return 0;
  }
  if (argv[0] === "--check") {
    const result = inspect();
    if (result.changed.length || result.stale.length) {
      console.error("Knowledge outputs are stale. Run: node tools/build-knowledge.js");
      result.changed.forEach(file => console.error("  differs: " + rel(file)));
      result.stale.forEach(file => console.error("  stale: " + rel(file)));
      return 1;
    }
    console.log("Knowledge sources and generated outputs are in sync (" +
      result.expected.source.topics.length + " topics, catalog " +
      result.expected.manifest.catalogSha256.slice(0, 12) + ").");
    return 0;
  }
  if (argv.length) throw new Error("Unknown arguments: " + argv.join(" "));
  const result = writeBuild();
  printBuild(result);
  return 0;
}

module.exports = { expectedArtifacts, inspect, main };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error("ERROR: " + e.message);
    process.exitCode = 1;
  }
}
