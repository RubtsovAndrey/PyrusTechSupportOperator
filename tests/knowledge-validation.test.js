const { suite } = require("./harness");
const { normalizeText, sha256, extractSection, adviceForSource, inspect } = require("../tools/validate-knowledge");

async function main() {
  const t = suite("knowledge validation card");
  const content = [
    "# Касса: устранение ошибок",
    "",
    "## Если смена превысила 24 часа",
    "",
    "1. Откройте драйвер.  ",
    "2. Закройте смену.",
    "",
    "## Другой случай",
    "Не относится к сценарию."
  ].join("\r\n");
  const section = "1. Откройте драйвер.\n2. Закройте смену.";
  t.check("a named source section stops at the next peer heading",
    extractSection(content, "Если смена превысила 24 часа") === section,
    extractSection(content, "Если смена превысила 24 часа"));
  t.check("a first heading stripped by the KB API is still recognised",
    extractSection(content.replace("## Если смена превысила 24 часа", "Если смена превысила 24 часа"),
      "Если смена превысила 24 часа") === section);
  t.check("source hashing ignores harmless line endings and trailing spaces",
    sha256(section) === sha256("  1. Откройте драйвер.\r\n2. Закройте смену.  "));

  const advice = "Откройте драйвер и закройте смену.";
  const topic = {
    validation: {
      status: "approved",
      source: {
        articleId: "source-1", title: "Касса: устранение ошибок", updatedAt: "2026-09-03",
        sectionHeading: "Если смена превысила 24 часа", sectionSha256: sha256(section),
        approvedAdviceSha256: sha256(advice)
      }
    },
    nodes: {
      restaurant: { knowledgeRef: { articleIds: ["source-1"] }, advice: advice },
      delivery: { knowledgeRef: { articleIds: ["source-1"] }, advice: advice }
    }
  };
  t.check("identical advice in several branches is one approved answer",
    adviceForSource(topic, "source-1").length === 1, adviceForSource(topic, "source-1"));
  const report = inspect(topic, {
    id: "source-1", title: "Касса: устранение ошибок", updatedAt: "2026-09-03", content: content
  });
  t.check("an unchanged approved source and answer pass every check",
    report.checks.every(row => row[1]), report.checks);

  const changed = inspect(topic, {
    id: "source-1", title: "Касса: устранение ошибок", updatedAt: "2026-09-04",
    content: content.replace("Закройте смену", "Сформируйте отчёт")
  });
  t.check("a changed source is rejected until a new review",
    changed.checks.some(row => !row[1]), changed.checks);

  const wholeArticleTopic = JSON.parse(JSON.stringify(topic));
  delete wholeArticleTopic.validation.source.sectionHeading;
  delete wholeArticleTopic.validation.source.sectionSha256;
  wholeArticleTopic.validation.source.contentSha256 = sha256(content);
  const wholeArticleReport = inspect(wholeArticleTopic, {
    id: "source-1", title: "Касса: устранение ошибок", updatedAt: "2026-09-03", content: content
  });
  t.check("an article without stable headings can pin its complete text",
    wholeArticleReport.checks.every(row => row[1]), wholeArticleReport.checks);
  const wholeArticleChanged = inspect(wholeArticleTopic, {
    id: "source-1", title: "Касса: устранение ошибок", updatedAt: "2026-09-03",
    content: content + "\nНовая строка"
  });
  t.check("complete-text validation detects content drift",
    wholeArticleChanged.checks.some(row => !row[1]), wholeArticleChanged.checks);
  t.check("normalisation produces compact reviewer-friendly text",
    normalizeText("a\u00a0 b\n\n\n c") === "a b\n\nc", normalizeText("a\u00a0 b\n\n\n c"));
  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => { process.exitCode = r.failed ? 1 : 0; });
