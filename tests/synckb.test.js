// Тесты плана синхронизации БЗ → исходники статей.
//
// Проверяется чистая часть `tools/sync-kb.js`: что именно скрипт собирается сделать с
// файлами. Ошибка здесь тихая по своей природе — исходник, который «почему-то» изменился
// или исчез, уезжает в каталог и в базу знаний, и обнаруживается по жалобе партнёра.
const { suite } = require("./harness");
const { planSync, splitByStatus } = require("../tools/sync-kb");

function topic(key, extra) {
  return Object.assign({
    key: key,
    description: "описание " + key,
    phrasings: ["как " + key],
    route: "solver",
    article: "текст " + key
  }, extra || {});
}

const text = t => JSON.stringify(t, null, 2) + "\n";

async function main() {
  const t = suite("синхронизация БЗ → исходники");

  let plan = planSync([topic("a"), topic("b")], {});
  t.check("пустой репозиторий: обе статьи новые",
    plan.create.length === 2 && !plan.update.length && !plan.remove.length, plan);

  plan = planSync([topic("a")], { a: text(topic("a")) });
  t.check("совпадающая статья не переписывается",
    plan.unchanged.length === 1 && !plan.update.length && !plan.create.length, plan);
  t.check("формат совпадает с build-knowledge: иначе дифф был бы на каждой синхронизации",
    plan.unchanged[0].text === text(topic("a")), plan.unchanged[0].text);

  plan = planSync([topic("a", { article: "новый текст" })], { a: text(topic("a")) });
  t.check("изменённая статья попадает в update, а не в create",
    plan.update.length === 1 && !plan.create.length, plan);

  // ── Форматирование ≠ изменение знания ──
  // Исходники правились руками, короткие массивы стоят в них одной строкой. Если считать
  // это правкой, первая же синхронизация покажет «изменено» по всем статьям — и настоящее
  // изменение знания утонет в этом шуме.
  const handWritten = '{\n  "key": "a",\n  "description": "описание a",\n' +
    '  "phrasings": ["как a"],\n  "route": "solver",\n  "article": "текст a"\n}\n';
  plan = planSync([topic("a")], { a: handWritten });
  t.check("другое форматирование того же знания — не изменение",
    plan.reformat.length === 1 && !plan.update.length, plan);
  t.check("но файл всё равно приводится к машинному виду",
    plan.reformat[0].text === text(topic("a")), plan.reformat[0].text);

  plan = planSync([topic("a")], { a: text(topic("a")), gone: text(topic("gone")) });
  t.check("исчезнувшая из БЗ статья названа отдельно, а не удалена молча",
    plan.remove.length === 1 && plan.remove[0] === "gone", plan);
  t.check("и в индекс она уже не попадает",
    JSON.parse(plan.index).topics.join(",") === "a", plan.index);

  plan = planSync([topic("b"), topic("a")], {});
  t.check("индекс перечисляет статьи в том порядке, в котором они пришли",
    JSON.parse(plan.index).topics.join(",") === "b,a", plan.index);

  // ── Черновики ──
  // В нашем пространстве они есть уже сейчас: незаконченная статья не должна начать
  // говорить с партнёром только потому, что её сохранили.
  const split = splitByStatus([
    { id: "1", title: "готовая", status: "published" },
    { id: "2", title: "в работе", status: "draft" },
    { articleId: "3", title: "тоже готовая", status: "published" },
    { title: "без id", status: "published" }
  ]);
  t.check("в каталог идут только опубликованные статьи",
    split.published.map(a => a.id).join(",") === "1,3", split.published);
  t.check("черновик назван в отчёте, а не пропущен молча",
    split.drafts.length === 1 && split.drafts[0].title === "в работе", split.drafts);
  t.check("статья без id не ломает синхронизацию",
    split.published.length === 2 && split.drafts.length === 1, split);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
