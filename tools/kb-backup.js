// Полный локальный снимок нашего пространства Базы знаний.
//
//   node tools/kb-backup.js --output .kb-backups/before-change.json
//   node tools/kb-backup.js --verify .kb-backups/before-change.json
//
// Снимки намеренно не попадают в git: в них хранится полное содержимое статей. Скрипт
// пишет только в `.kb-backups/` внутри проекта и не содержит операции восстановления или
// удаления. Восстановление должно быть отдельным осознанным действием по сохранённому JSON.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MCP, WRITE_SPACES } = require("./mcp-client");

const ROOT = path.resolve(__dirname, "..");
const BACKUP_ROOT = path.join(ROOT, ".kb-backups");
const SPACE_ID = WRITE_SPACES[0];

function articleId(value) {
  return value && (value.id || value.articleId || value.Id || value.ArticleId);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resolveBackupPath(file) {
  if (!file) throw new Error("укажите --output или --verify");
  const absolute = path.resolve(ROOT, file);
  if (absolute !== BACKUP_ROOT && absolute.indexOf(BACKUP_ROOT + path.sep) !== 0) {
    throw new Error("снимок разрешено хранить только в " + BACKUP_ROOT);
  }
  return absolute;
}

function verifySnapshot(snapshot) {
  const problems = [];
  if (!snapshot || snapshot.schemaVersion !== 1) problems.push("неизвестная версия снимка");
  if (!snapshot || snapshot.spaceId !== SPACE_ID) problems.push("снимок другого пространства");
  const listing = snapshot && snapshot.listing;
  const articles = snapshot && snapshot.articles;
  if (!Array.isArray(listing)) problems.push("нет оглавления");
  if (!Array.isArray(articles)) problems.push("нет статей");
  if (problems.length) return problems;

  const ids = new Set();
  articles.forEach((item, i) => {
    const id = articleId(item.article);
    if (!id) problems.push("статья " + i + " без id");
    else if (ids.has(String(id))) problems.push("повтор статьи " + id);
    else ids.add(String(id));
    if (!item.article || typeof item.article.content !== "string") {
      problems.push("статья " + (id || i) + " без полного текста");
    }
    if (item.sha256 !== digest(item.article)) problems.push("не совпадает хеш статьи " + (id || i));
  });

  const listingIds = listing.map(articleId).filter(Boolean).map(String);
  listingIds.forEach(id => { if (!ids.has(id)) problems.push("оглавление ссылается на отсутствующую статью " + id); });
  ids.forEach(id => { if (listingIds.indexOf(id) < 0) problems.push("статья " + id + " отсутствует в оглавлении"); });
  if (snapshot.articleCount !== articles.length) problems.push("не совпадает articleCount");

  const expectedSnapshotHash = digest({
    spaceId: snapshot.spaceId,
    listing: listing,
    articles: articles
  });
  if (snapshot.sha256 !== expectedSnapshotHash) problems.push("не совпадает общий хеш снимка");
  return problems;
}

async function createSnapshot(output) {
  const listing = await MCP.spaceArticles(SPACE_ID);
  const articles = [];
  for (let i = 0; i < listing.length; i++) {
    const id = articleId(listing[i]);
    if (!id) throw new Error("элемент оглавления без id: " + JSON.stringify(listing[i]));
    const article = await MCP.getContent(id);
    articles.push({ article: article, sha256: digest(article) });
  }
  const core = { spaceId: SPACE_ID, listing: listing, articles: articles };
  const snapshot = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    spaceId: SPACE_ID,
    articleCount: articles.length,
    listing: listing,
    articles: articles,
    sha256: digest(core)
  };
  const problems = verifySnapshot(snapshot);
  if (problems.length) throw new Error("снимок не прошёл самопроверку: " + problems.join("; "));
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return snapshot;
}

function readAndVerify(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = verifySnapshot(snapshot);
  if (problems.length) throw new Error(problems.join("; "));
  return snapshot;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const outputAt = args.indexOf("--output");
  const verifyAt = args.indexOf("--verify");
  if ((outputAt >= 0) === (verifyAt >= 0)) {
    throw new Error("выберите ровно одно действие: --output <файл> или --verify <файл>");
  }
  const allowed = new Set(["--output", "--verify", args[outputAt + 1], args[verifyAt + 1]].filter(Boolean));
  const unknown = args.filter(a => !allowed.has(a));
  if (unknown.length) throw new Error("неизвестные аргументы: " + unknown.join(" "));

  const file = resolveBackupPath(outputAt >= 0 ? args[outputAt + 1] : args[verifyAt + 1]);
  if (outputAt >= 0) {
    if (fs.existsSync(file)) throw new Error("снимок уже существует, перезапись запрещена: " + file);
    const snapshot = await createSnapshot(file);
    console.log("Снимок создан: " + file);
    console.log("Статей: " + snapshot.articleCount + ", SHA-256: " + snapshot.sha256);
  } else {
    const snapshot = readAndVerify(file);
    console.log("Снимок исправен: " + file);
    console.log("Статей: " + snapshot.articleCount + ", SHA-256: " + snapshot.sha256);
  }
}

module.exports = { verifySnapshot, readAndVerify, articleId, digest, SPACE_ID, BACKUP_ROOT };

if (require.main === module) {
  main().catch(e => { console.error("ОШИБКА: " + e.message); process.exitCode = 1; });
}
