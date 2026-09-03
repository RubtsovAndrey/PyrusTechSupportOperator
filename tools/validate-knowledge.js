// Live validation card for one managed knowledge scenario.
//
//   node tools/validate-knowledge.js cash_shift_over_24_hours
//   node tools/validate-knowledge.js cash_shift_over_24_hours --show
//
// The command is read-only. It fetches the pinned source article through MCP and checks
// that neither the approved source section nor the executable partner advice has drifted
// since review. `--show` prints both texts side by side for a human content review.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MCP } = require("./mcp-client");

const ROOT = path.resolve(__dirname, "..");

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(normalizeText(value), "utf8").digest("hex");
}

function headingName(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(String(line || ""));
  return match ? { level: match[1].length, name: normalizeText(match[2]) } : null;
}

function extractSection(markdown, wantedHeading) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const wanted = normalizeText(wantedHeading).toLowerCase().replace(/ё/g, "е");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const heading = headingName(lines[i]);
    if (!heading) continue;
    const name = heading.name.toLowerCase().replace(/ё/g, "е");
    if (name === wanted) { start = i + 1; level = heading.level; break; }
  }
  // The KB API may return the first editor heading as a bare first line while preserving
  // later Markdown headings. Accept only an exact standalone line, then stop at the next
  // heading of any level. A phrase inside a paragraph is deliberately not a heading.
  if (start < 0) {
    for (let i = 0; i < lines.length; i++) {
      const name = normalizeText(lines[i]).toLowerCase().replace(/ё/g, "е");
      if (name === wanted) { start = i + 1; level = 6; break; }
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const heading = headingName(lines[i]);
    if (heading && heading.level <= level) { end = i; break; }
  }
  return normalizeText(lines.slice(start, end).join("\n"));
}

function adviceForSource(topic, articleId) {
  const found = [];
  Object.keys((topic && topic.nodes) || {}).forEach(nodeId => {
    const node = topic.nodes[nodeId] || {};
    const ids = node.knowledgeRef && Array.isArray(node.knowledgeRef.articleIds)
      ? node.knowledgeRef.articleIds.map(String) : [];
    if (!node.advice || ids.indexOf(String(articleId)) < 0) return;
    const text = normalizeText(node.advice);
    if (found.indexOf(text) < 0) found.push(text);
  });
  return found;
}

function inspect(topic, article) {
  const validation = (topic && topic.validation) || {};
  const source = validation.source || {};
  const section = extractSection(article && article.content, source.sectionHeading);
  const advice = adviceForSource(topic, source.articleId);
  const checks = [
    ["статус сценария approved", validation.status === "approved"],
    ["ID общей статьи совпадает", String(article && (article.id || article.articleId) || "") === String(source.articleId || "")],
    ["заголовок общей статьи совпадает", String(article && article.title || "") === String(source.title || "")],
    ["дата изменения общей статьи совпадает", String(article && article.updatedAt || "") === String(source.updatedAt || "")],
    ["раздел общей статьи найден", !!section],
    ["хеш раздела общей статьи совпадает", !!section && sha256(section) === String(source.sectionSha256 || "")],
    ["исполняемый совет един для всех веток", advice.length === 1],
    ["хеш утверждённого совета совпадает", advice.length === 1 && sha256(advice[0]) === String(source.approvedAdviceSha256 || "")]
  ];
  return { checks: checks, section: section, advice: advice, sourceHash: section ? sha256(section) : null,
    adviceHash: advice.length === 1 ? sha256(advice[0]) : null };
}

function loadTopic(key) {
  const file = path.join(ROOT, "docs", "knowledge", "topics", key + ".json");
  if (!fs.existsSync(file)) throw new Error("нет сценария docs/knowledge/topics/" + key + ".json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const key = args.filter(a => a.indexOf("--") !== 0)[0];
  if (!key) throw new Error("укажите ключ сценария");
  const topic = loadTopic(key);
  const source = topic.validation && topic.validation.source;
  if (!source || !source.articleId || !source.sectionHeading) {
    throw new Error("у сценария " + key + " нет validation.source с articleId и sectionHeading");
  }
  const article = await MCP.getContent(source.articleId);
  const report = inspect(topic, article);

  console.log("Сценарий: " + key);
  console.log("Источник: " + source.title + " (" + source.articleId + ")");
  report.checks.forEach(row => console.log((row[1] ? "  ✓ " : "  ✗ ") + row[0]));
  console.log("Хеш раздела сейчас: " + (report.sourceHash || "раздел не найден"));
  console.log("Хеш совета сейчас:  " + (report.adviceHash || "нет единственного совета"));

  if (args.indexOf("--show") >= 0) {
    console.log("\n--- Общая БЗ: утверждённый раздел ---\n\n" + (report.section || "<не найден>"));
    console.log("\n--- Наш исполняемый ответ ---\n\n" + (report.advice[0] || "<не найден>"));
  }

  return report.checks.every(row => row[1]) ? 0 : 1;
}

module.exports = { normalizeText, sha256, extractSection, adviceForSource, inspect, main };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(e => {
    console.error("ERROR: " + e.message);
    process.exitCode = 1;
  });
}
