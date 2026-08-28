// Синхронизация: наше пространство Базы Знаний → исходники статей в репозитории.
//
//   node tools/sync-kb.js                    # показать, что изменится (ничего не пишет)
//   node tools/sync-kb.js --write            # записать docs/knowledge/**
//   node tools/sync-kb.js --write --allow-delete   # ...и удалить темы, которых больше нет в БЗ
//
// ── Почему в репозиторий, а не сразу в БД ──
// Редактор правит статью в БЗ — это источник правды. Но между БЗ и рантайном стоит
// репозиторий, и это не лишнее звено, а три вещи, которых иначе не будет:
// 1. **Дифф.** Правка знания становится обычным диффом в git: видно, кто и что изменил в
//    инструкции, и можно вернуться. В БЗ история есть, но она не рядом с кодом бота.
// 2. **Проверки до заливки.** `tests/routing.cases.json` и линтер прогоняются по новым
//    статьям ДО того, как они попадут в БД. Сломанная статья в рантайме выглядит как
//    «бот передал обращение человеку» — то есть не выглядит никак.
// 3. **Существующий конвейер.** `build-knowledge.js` уже собирает из исходников каталог,
//    RAG-документы и манифест с хешами. Этот скрипт добавляет ему вход, а не заменяет его.
//
// Направление одностороннее: БЗ → репозиторий. Обратное (репозиторий → БЗ) — отдельная
// команда `tools/kb-publish.js`, потому что запись требует и другого режима подключения, и
// другой ответственности.

const fs = require('fs');
const path = require('path');
const { MCP, WRITE_SPACES } = require('./mcp-client');
const { topicsFromArticles } = require('./kb-article');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'docs', 'knowledge');
const SOURCE_INDEX = path.join(SOURCE_ROOT, 'index.json');
const SOURCE_TOPICS = path.join(SOURCE_ROOT, 'topics');

// Пространство, из которого тянем. То же, куда разрешена запись, и то же, которым сужен
// поиск в `getKnowledgeMcp` — три места, и все три должны называть одно.
const SPACE_ID = WRITE_SPACES[0];

// Тот же формат, что у build-knowledge.js: иначе каждая синхронизация давала бы дифф на
// одних пробелах.
function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// Совпадает ли знание, а не его запись. Исходники правились руками, и короткие массивы в
// них стоят одной строкой; `JSON.stringify` их разворачивает. Считать это изменением статьи
// нельзя: тогда первая же синхронизация покажет «изменено» по всем статьям, и настоящая
// правка знания в этом шуме потеряется.
function sameKnowledge(textA, textB) {
  try {
    return JSON.stringify(JSON.parse(textA)) === JSON.stringify(JSON.parse(textB));
  } catch (e) {
    return false;
  }
}

// Чистая часть: что делать с исходниками, если в БЗ оказались вот эти статьи.
// existing — { ключ: текст файла }. Возвращает план, который можно напечатать и не применять.
function planSync(topics, existing) {
  const have = existing || {};
  const plan = { create: [], update: [], reformat: [], unchanged: [], remove: [], index: null };
  const seen = {};

  topics.forEach(topic => {
    const key = String(topic.key);
    const text = json(topic);
    seen[key] = true;
    const item = { key: key, text: text };
    if (have[key] === undefined) plan.create.push(item);
    else if (have[key] === text) plan.unchanged.push(item);
    else if (sameKnowledge(have[key], text)) plan.reformat.push(item);
    else plan.update.push(item);
  });

  Object.keys(have).forEach(key => { if (!seen[key]) plan.remove.push(key); });
  plan.remove.sort();

  // Индекс перечисляет ровно то, что останется после применения плана, в том же порядке,
  // в котором статьи пришли (они уже отсортированы по ключу).
  plan.index = json({ schemaVersion: 1, topics: topics.map(t => String(t.key)) });
  return plan;
}

function readExisting() {
  if (!fs.existsSync(SOURCE_TOPICS)) return {};
  const existing = {};
  fs.readdirSync(SOURCE_TOPICS).filter(f => f.endsWith('.json')).forEach(file => {
    existing[file.replace(/\.json$/, '')] = fs.readFileSync(path.join(SOURCE_TOPICS, file), 'utf8');
  });
  return existing;
}

// Черновик — это незаконченное знание: редактор ещё пишет статью, а бот уже говорил бы ею с
// партнёром. В каталог идут только опубликованные статьи, остальные перечисляются в отчёте,
// чтобы «почему моей статьи нет у бота» имело ответ, а не выглядело сбоем синхронизации.
function splitByStatus(listing) {
  const published = [];
  const drafts = [];
  (listing || []).forEach(item => {
    const id = item.articleId || item.id;
    if (!id) return;
    (String(item.status || "") === "published" ? published : drafts).push({
      id: id, title: item.title || id, status: item.status || null
    });
  });
  return { published: published, drafts: drafts };
}

// Оглавление пространства + содержимое каждой статьи. Оглавление вместо поиска потому, что
// нужны ВСЕ статьи пространства, а не подходящие под запрос: статья, выпавшая из выдачи
// поиска, иначе выглядела бы как удалённая. И черновиков поиск не показывает вовсе.
async function fetchArticles() {
  const listing = await MCP.spaceArticles(SPACE_ID);
  const split = splitByStatus(listing);
  const articles = [];
  for (let i = 0; i < split.published.length; i++) {
    articles.push(await MCP.getContent(split.published[i].id));
  }
  return { articles: articles, drafts: split.drafts, total: listing.length };
}

function printPlan(plan, parsed, fetched) {
  console.log('Пространство: ' + SPACE_ID);
  console.log('Статей в пространстве: ' + fetched.total +
    ', опубликовано: ' + fetched.articles.length +
    ', размечено для бота: ' + (plan.create.length + plan.update.length +
      plan.reformat.length + plan.unchanged.length));
  if (fetched.drafts.length) {
    console.log('\nЧерновики (в каталог не идут): ' +
      fetched.drafts.map(d => '«' + d.title + '»').join(', '));
  }

  if (parsed.problems.length) {
    console.log('\nПроблемы разметки (' + parsed.problems.length + '):');
    parsed.problems.forEach(p => console.log('  ' + p));
  }
  const say = (label, list) => {
    if (list.length) console.log('\n' + label + ': ' + list.map(x => x.key || x).join(', '));
  };
  say('Новые статьи', plan.create);
  say('Изменённые', plan.update);
  say('Переформатированы (знание то же)', plan.reformat);
  say('Без изменений', plan.unchanged);
  say('Больше нет в БЗ', plan.remove);
}

function apply(plan, allowDelete) {
  fs.mkdirSync(SOURCE_TOPICS, { recursive: true });
  plan.create.concat(plan.update, plan.reformat).forEach(item => {
    fs.writeFileSync(path.join(SOURCE_TOPICS, item.key + '.json'), item.text, 'utf8');
  });
  const deleted = [];
  if (plan.remove.length && allowDelete) {
    plan.remove.forEach(key => {
      fs.unlinkSync(path.join(SOURCE_TOPICS, key + '.json'));
      deleted.push(key);
    });
  }
  // Индекс пишется последним: пока он не обновлён, build-knowledge.js ругается на лишние
  // файлы — и это правильнее, чем каталог, в котором статья есть, а исходника нет.
  if (!plan.remove.length || allowDelete) fs.writeFileSync(SOURCE_INDEX, plan.index, 'utf8');
  return deleted;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const write = args.indexOf('--write') >= 0;
  const allowDelete = args.indexOf('--allow-delete') >= 0;
  const unknown = args.filter(a => ['--write', '--allow-delete'].indexOf(a) < 0);
  if (unknown.length) throw new Error('неизвестные аргументы: ' + unknown.join(' '));

  const fetched = await fetchArticles();
  const parsed = topicsFromArticles(fetched.articles);
  const plan = planSync(parsed.topics, readExisting());
  printPlan(plan, parsed, fetched);

  // Одна сломанная статья не должна попадать в исходники ВМЕСТЕ с исправными: каталог
  // собирается целиком, и половина обновления — это состояние, которого не было ни в БЗ,
  // ни в репозитории.
  if (parsed.problems.length) {
    console.error('\nНичего не записано: сначала исправьте разметку статей в БЗ.');
    return 1;
  }
  if (!parsed.topics.length) {
    console.error('\nНичего не записано: в пространстве нет ни одной статьи с блоком json agent.');
    return 1;
  }
  if (!write) {
    console.log('\nЭто предпросмотр. Записать: node tools/sync-kb.js --write' +
      (plan.remove.length ? ' --allow-delete' : ''));
    return 0;
  }
  if (plan.remove.length && !allowDelete) {
    console.error('\nНичего не записано: статьи ' + plan.remove.join(', ') +
      ' исчезли из БЗ. Если это намеренно — повторите с --allow-delete.');
    return 1;
  }

  const deleted = apply(plan, allowDelete);
  console.log('\nЗаписано: ' +
    (plan.create.length + plan.update.length + plan.reformat.length) + ' исходник(ов)' +
    (deleted.length ? ', удалено: ' + deleted.join(', ') : ''));
  console.log('Дальше: node tools/build-knowledge.js && node tests/run.js');
  return 0;
}

module.exports = { planSync, splitByStatus, main, SPACE_ID };

if (require.main === module) {
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error('ОШИБКА: ' + e.message); process.exitCode = 1; });
}
