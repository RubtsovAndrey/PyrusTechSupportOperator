// Одноразовая безопасная подготовка пространства БЗ к MVP.
//
//   node tools/kb-prepare-mvp.js
//   node tools/kb-prepare-mvp.js --write --backup .kb-backups/before-change.json
//
// Шесть тестовых статей переводятся в draft. Удаления нет: действие обратимо. Перед
// записью скрипт требует полный снимок и сравнивает с ним каждую живую статью. Любая
// неизвестная статья, изменение после снимка или несовпадение заголовка останавливает всё
// до первого update_content.

const { MCP, WRITE_SPACES } = require("./mcp-client");
const { readAndVerify, articleId, digest } = require("./kb-backup");

const SPACE_ID = WRITE_SPACES[0];

const KEEP = [
  ["08df0925-034b-4c0b-8390-adbbe1ddaddc", "[CASH] Кассовая смена превысила 24 часа"],
  ["08df0280-4425-43e7-86f0-134787c5d592", "Касса, ККМ и терминал: устранение ошибок"],
  ["08df0925-07b2-4bcd-8ae3-f1771c72fb2d", "[CASH] Смена закрыта, Z-отчёт не распечатался"],
  ["08df0924-ff63-46b5-817b-d52e677c495f", "[CASH] Ошибка 148 при закрытии чека"]
];

const HIDE = [
  ["08df0283-0e31-43f7-85a0-dbc3902398d3", "На тв-борде возникает ошибка подключения"],
  ["08df0283-0f03-4541-83e2-1fc9c0e2c52f", "Предоставить удаленный доступ поддержке к киоску на Windows"],
  ["08df0283-0ec9-44f2-8f1b-8435f2e0e92d", "Как настроить сканер NewLand NLS-FR4280-BT"],
  ["08df0283-0e8e-418d-8ada-b347f7b020a2", "Курьер не может вывести чаевые"],
  ["08df0283-0e5d-43c5-8eea-cc581dc7de92", "Накладные печатаются, но звуки не воспроизводятся"],
  ["08df0281-d1a2-4925-8271-24582a5930bc", "Как разметить статью для бота техподдержки"]
];

async function fetchAll() {
  const listing = await MCP.spaceArticles(SPACE_ID);
  const articles = [];
  for (let i = 0; i < listing.length; i++) {
    const id = articleId(listing[i]);
    if (!id) throw new Error("элемент оглавления без id");
    articles.push(await MCP.getContent(id));
  }
  return { listing: listing, articles: articles };
}

function validateKnown(live) {
  const problems = [];
  const expected = new Map(KEEP.concat(HIDE));
  const seen = new Set();
  live.articles.forEach(article => {
    const id = String(articleId(article));
    seen.add(id);
    if (!expected.has(id)) return problems.push("неизвестная статья: " + id + " «" + article.title + "»");
    if (String(article.title) !== expected.get(id)) {
      problems.push("переименована статья " + id + ": ожидалось «" + expected.get(id) + "», сейчас «" + article.title + "»");
    }
    const spaceId = article.space && article.space.id;
    if (String(spaceId) !== SPACE_ID) problems.push("статья " + id + " из другого пространства");
  });
  expected.forEach((title, id) => { if (!seen.has(id)) problems.push("нет статьи " + id + " «" + title + "»"); });
  return problems;
}

function validateBackup(live, snapshot) {
  const problems = [];
  const saved = new Map(snapshot.articles.map(x => [String(articleId(x.article)), x]));
  if (snapshot.articleCount !== live.articles.length) {
    problems.push("число статей изменилось после снимка");
  }
  live.articles.forEach(article => {
    const id = String(articleId(article));
    const copy = saved.get(id);
    if (!copy) problems.push("статьи " + id + " нет в снимке");
    else if (copy.sha256 !== digest(article)) problems.push("статья " + id + " изменилась после снимка");
  });
  return problems;
}

function statusById(listing) {
  const result = new Map();
  listing.forEach(x => result.set(String(articleId(x)), String(x.status || "")));
  return result;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const write = args.indexOf("--write") >= 0;
  const backupAt = args.indexOf("--backup");
  const knownArgs = new Set(["--write", "--backup", backupAt >= 0 ? args[backupAt + 1] : null].filter(Boolean));
  const unknown = args.filter(a => !knownArgs.has(a));
  if (unknown.length) throw new Error("неизвестные аргументы: " + unknown.join(" "));
  if (write && backupAt < 0) throw new Error("перед записью обязателен --backup <файл>");

  const live = await fetchAll();
  const knownProblems = validateKnown(live);
  if (knownProblems.length) throw new Error(knownProblems.join("; "));
  const statuses = statusById(live.listing);

  console.log("Пространство: " + SPACE_ID);
  console.log("Оставить опубликованными:");
  KEEP.forEach(([id, title]) => console.log("  " + statuses.get(id) + " → published  «" + title + "»"));
  console.log("Скрыть в черновики:");
  HIDE.forEach(([id, title]) => console.log("  " + statuses.get(id) + " → draft      «" + title + "»"));

  if (!write) {
    console.log("\nПредпросмотр: изменений нет.");
    return;
  }

  const snapshot = readAndVerify(args[backupAt + 1]);
  const backupProblems = validateBackup(live, snapshot);
  if (backupProblems.length) throw new Error(backupProblems.join("; "));

  const byId = new Map(live.articles.map(a => [String(articleId(a)), a]));
  for (let i = 0; i < HIDE.length; i++) {
    const id = HIDE[i][0];
    if (statuses.get(id) === "draft") continue;
    const article = byId.get(id);
    await MCP.updateContent(id, {
      title: article.title,
      content: article.content,
      status: "draft"
    });
    console.log("Скрыта: «" + article.title + "»");
  }

  const after = await MCP.spaceArticles(SPACE_ID);
  const afterStatuses = statusById(after);
  const postProblems = [];
  HIDE.forEach(([id, title]) => {
    if (afterStatuses.get(id) !== "draft") postProblems.push("не скрыта «" + title + "»");
  });
  KEEP.forEach(([id, title]) => {
    if (afterStatuses.get(id) !== "published") postProblems.push("не опубликована «" + title + "»");
  });
  if (postProblems.length) throw new Error("постпроверка: " + postProblems.join("; "));
  console.log("\nГотово: опубликовано 4 кассовых статьи, 6 тестовых статей скрыты в draft.");
}

module.exports = { KEEP, HIDE, validateKnown, validateBackup };

if (require.main === module) {
  main().catch(e => { console.error("ОШИБКА: " + e.message); process.exitCode = 1; });
}
