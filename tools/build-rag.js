// Собирает документы для базы знаний из каталога: node tools/build-rag.js
//
// ── Зачем генератор, а не написать статьи в базе знаний руками ──
// Подбор темы по смыслу опирается на то, что имя документа совпадает с `key` статьи. Если
// эти документы писать руками, ключ живёт в двух местах, которые никто не синхронизирует:
// тему переименовали — база знаний указывает на мёртвый ключ. Промах при этом безопасен
// (несуществующий ключ отбрасывается, обращение уходит оператору), но МОЛЧАЛИВ, а молчаливые
// поломки в этом проекте обходятся дороже всего.
// Поэтому источник правды один — каталог. Переформулировки лежат в самой статье, в поле
// `phrasings`, то есть правит их тот же человек и в тот же момент, что и алгоритм.
//
// Что делать с результатом: загрузить содержимое docs/rag/ в базу знаний на платформе.
// Имя файла станет именем источника — по нему `searchKnowledge` и узнаёт статью.
//
// ── КАКОЙ каталог читается ──
// По умолчанию — `docs/knowledge_catalog.json`, а это ОБРАЗЕЦ: рабочий каталог живёт
// документом `knowledge_catalog` в БД проекта и правится вручную. Их легко спутать, и цена
// путаницы измерена на живом логе: `phrasings`, добавленные в образец, в проде не появились,
// и подбор по словам продолжал промахиваться ровно так же.
// Поэтому путь можно передать: выгрузите документ из БД в файл и укажите его.
//     node tools/build-rag.js                          — образец из репозитория
//     node tools/build-rag.js C:\путь\prod-catalog.json — то, что реально развёрнуто

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CATALOG = path.join(ROOT, "docs", "knowledge_catalog.json");
const CATALOG = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CATALOG;
const OUT = path.join(ROOT, "docs", "rag");

function main() {
  if (!fs.existsSync(CATALOG)) {
    console.error("Каталог не найден: " + CATALOG);
    process.exit(1);
  }
  console.log("Читаю каталог: " + CATALOG);
  if (CATALOG === DEFAULT_CATALOG) {
    console.log("  ВНИМАНИЕ: это ОБРАЗЕЦ из репозитория, а не рабочий каталог.");
    console.log("  Рабочий лежит документом `knowledge_catalog` в БД проекта. Если статьи в нём");
    console.log("  другие, выгрузите его в файл и передайте путь: node tools/build-rag.js <файл>");
  }
  console.log("");
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const topics = Array.isArray(catalog.topics) ? catalog.topics : [];
  if (!topics.length) {
    console.error("В каталоге нет статей — нечего собирать.");
    process.exit(1);
  }

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const written = [];
  const noPhrasings = [];

  topics.forEach(topic => {
    const key = String(topic.key || "").trim();
    if (!key) return;
    const phrasings = Array.isArray(topic.phrasings) ? topic.phrasings.filter(Boolean).map(String) : [];
    if (!phrasings.length) noPhrasings.push(key);

    // `topicKey` первой строкой — второй, независимый носитель ключа: имя документа может
    // не пережить переименование при загрузке, а эта строка переживёт.
    // Дальше — только слова партнёра. Ни процедуры, ни решения: решение живёт в каталоге, а
    // положенное сюда однажды начнут отвечать текстом из базы знаний, и каталог перестанет
    // быть арбитром.
    const body = [
      "topicKey: " + key,
      "",
      String(topic.description || "").trim(),
      ""
    ].concat(phrasings.map(p => "- " + p.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

    const file = path.join(OUT, key + ".md");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (before !== body) {
      fs.writeFileSync(file, body);
      written.push(key + (before === null ? " (новый)" : " (изменён)"));
    }
  });

  // Файлы тем, которых в каталоге больше нет. Оставить их — значит держать в базе знаний
  // документ, указывающий на несуществующую статью: обращения по нему будут находиться и
  // тут же отбрасываться, то есть уходить оператору без объяснения.
  const expected = {};
  topics.forEach(t => { if (t.key) expected[String(t.key) + ".md"] = true; });
  const stale = fs.readdirSync(OUT).filter(f => f.endsWith(".md") && !expected[f]);
  stale.forEach(f => fs.unlinkSync(path.join(OUT, f)));

  console.log("Статей в каталоге: " + topics.length);
  console.log("Записано в docs/rag/: " + (written.length ? written.length : "без изменений"));
  written.forEach(w => console.log("  " + w));
  if (stale.length) {
    console.log("Удалены документы тем, которых больше нет в каталоге:");
    stale.forEach(f => console.log("  " + f));
    console.log("  ВАЖНО: их нужно удалить и в базе знаний на платформе — здесь их удаление ни на что не влияет.");
  }
  if (noPhrasings.length) {
    console.log("");
    console.log("Без `phrasings` (найдутся только по описанию, то есть заметно хуже):");
    noPhrasings.forEach(k => console.log("  " + k));
  }
  console.log("");
  console.log("Дальше: загрузите содержимое docs/rag/ в базу знаний. Имя файла = имя источника,");
  console.log("по нему searchKnowledge и узнаёт статью.");
}

main();
