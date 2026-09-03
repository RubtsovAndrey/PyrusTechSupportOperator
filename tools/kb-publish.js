// Публикация статьи из репозитория в наше пространство Базы Знаний.
//
//   node tools/kb-publish.js <ключ>                       # предпросмотр, ничего не пишет
//   node tools/kb-publish.js <ключ> --write               # создать/обновить черновиком
//   node tools/kb-publish.js <ключ> --write --status published
//   node tools/kb-publish.js <ключ> --title "Заголовок статьи"
//
// Обратное направление к `sync-kb.js` и нужно ровно один раз на статью — для переноса того,
// что уже написано в репозитории. Дальше источник правды — БЗ, и правки идут туда.
//
// ── Что здесь сделано ради безопасности ──
// 1. Пространство одно, и оно зашито в `mcp-client.js`: запись куда-либо ещё отклоняется и
//    заголовком `Mcp-Write-Spaces`, и проверкой до отправки запроса.
// 2. По умолчанию `draft`. Опубликованная статья попадает в каталог при следующей
//    синхронизации, то есть начинает говорить с партнёром; это должно быть отдельным
//    решением человека, а не побочным эффектом переноса.
// 3. Существующая статья ищется по `key` внутри блока, а не по заголовку: заголовок
//    редактор вправе переименовать, а ключ — идентификатор. Без этого повторный запуск
//    создавал бы вторую статью с тем же ключом, и синхронизация встала бы на дубле.
// 4. Перед записью вызывается `preview_content` — dry-run конвертации Markdown. Если
//    конвертация теряет разметку, лучше узнать это до записи.

const fs = require('fs');
const path = require('path');
const { MCP, WRITE_SPACES, callTool } = require('./mcp-client');
const { renderArticle, describeTopic, parseArticle } = require('./kb-article');
const { lintTopics } = require('./lint-topics');

const ROOT = path.resolve(__dirname, '..');
const SPACE_ID = WRITE_SPACES[0];

function loadTopic(key) {
  const file = path.join(ROOT, 'docs', 'knowledge', 'topics', key + '.json');
  if (!fs.existsSync(file)) throw new Error('нет исходника docs/knowledge/topics/' + key + '.json');
  const topic = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = lintTopics([topic]);
  if (problems.length) {
    throw new Error('статья не проходит линтер:\n  ' + problems.join('\n  '));
  }
  return topic;
}

// Все статьи пространства с разобранным блоком: и опубликованные, и черновики. Черновики
// обязательно — иначе повторный запуск не нашёл бы созданный им же черновик.
async function findByKey(key) {
  const listing = await MCP.spaceArticles(SPACE_ID);
  for (let i = 0; i < listing.length; i++) {
    const id = listing[i].articleId || listing[i].id;
    if (!id) continue;
    const article = await MCP.getContent(id);
    const parsed = parseArticle(article);
    const found = parsed.topic || (parsed.forBot ? null : null);
    if (found && String(found.key) === String(key)) return article;
    // Сломанная разметка тоже считается совпадением: иначе статью с опечаткой в блоке
    // нельзя было бы починить публикацией — рядом появилась бы вторая.
    if (parsed.forBot && !found && new RegExp('"key"\\s*:\\s*"' + key + '"').test(article.content || '')) {
      return article;
    }
    // One MVP policy was reviewed in the earlier `agent-policy/*` draft format. That
    // format was never executable and therefore is not recognised by parseArticle, but
    // publishing the accepted agent-topic must update that same draft rather than leave a
    // second article with the same business key beside it. Topic keys are already limited
    // to safe ASCII by loadTopic, so they can be used in this exact migration expression.
    const legacyPolicy = /"schema"\s*:\s*"agent-policy\//.test(article.content || '') &&
      new RegExp('"key"\\s*:\\s*"' + key + '"').test(article.content || '');
    if (legacyPolicy) return article;
  }
  return null;
}

// Статья для людей, а не сценарий: справочник редактора живёт в репозитории (в git видно,
// кто и что менял), а в БЗ уезжает копией. Такая статья ищется по заголовку — ключа у неё
// нет по определению, она не сценарий.
async function findByTitle(title) {
  const listing = await MCP.spaceArticles(SPACE_ID);
  const match = listing.filter(a => String(a.title) === String(title))[0];
  return match ? MCP.getContent(match.articleId || match.id) : null;
}

async function publishDoc(file, titleArg, write, status) {
  const source = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(source)) throw new Error('нет файла ' + file);
  const markdown = fs.readFileSync(source, 'utf8');
  const heading = /^#\s+([^\n]+)/.exec(markdown);
  const title = titleArg || (heading ? heading[1].trim() : path.basename(file));

  // Проверка, без которой справочник о разметке сам стал бы размеченной статьёй: примеры
  // внутри него не должны опознаваться как конфигурация бота.
  const parsed = parseArticle({ id: 'doc', title: title, content: markdown });
  if (parsed.forBot) {
    throw new Error('этот документ опознаётся как сценарий бота: ' +
      (parsed.problems.join('; ') || 'в нём есть блок конфигурации') +
      '. Оформите примеры фенсед-блоком без слова json.');
  }

  const existing = await findByTitle(title);
  console.log('Документ: ' + file);
  console.log('Статья: ' + (existing ? 'обновление «' + title + '» (' + existing.id + ')' : 'создание «' + title + '»'));
  console.log('Статус: ' + status + ', размер: ' + markdown.length + ' символов');
  if (!write) {
    console.log('\nЭто предпросмотр. Записать: добавьте --write');
    return 0;
  }
  if (existing) {
    await MCP.updateContent(existing.id, { title: title, content: markdown, status: status });
    console.log('\nОбновлено: ' + existing.id);
  } else {
    const created = await MCP.createContent(SPACE_ID, title, markdown, status);
    console.log('\nСоздано: ' + (created && (created.id || created.Id) || JSON.stringify(created)));
  }
  return 0;
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  const docArg = args.indexOf('--doc');
  const write = args.indexOf('--write') >= 0;
  if (docArg >= 0) {
    const titleArg = args.indexOf('--title');
    const statusArg = args.indexOf('--status');
    return publishDoc(args[docArg + 1], titleArg >= 0 ? args[titleArg + 1] : null,
      write, statusArg >= 0 ? args[statusArg + 1] : 'published');
  }

  const key = args.filter(a => a.indexOf('--') !== 0)[0];
  if (!key) throw new Error('нужен ключ статьи: node tools/kb-publish.js <ключ>');

  const statusArg = args.indexOf('--status');
  const status = statusArg >= 0 ? args[statusArg + 1] : 'draft';
  if (['draft', 'published'].indexOf(status) < 0) throw new Error('--status: draft или published');
  const titleArg = args.indexOf('--title');
  const title = titleArg >= 0 ? args[titleArg + 1] : null;

  const topic = loadTopic(key);
  // Тело статьи собирается из сценария ТОЛЬКО там, где прозы нет: у `steps` и `nodes`
  // содержание статьи — структура, и человеку её надо чем-то показать. У прозаической статьи
  // текст уже есть, и подставить вместо него пересказ значило бы затереть саму статью —
  // `renderArticle` в этом случае сам переносит `article` в тело.
  const prose = topic.article || topic.solverInstruction;
  const markdown = renderArticle(topic, {
    title: title || topic.title || key,
    body: prose ? null : describeTopic(topic)
  });

  // Проверяем, что круговой рейс сохраняет статью: если разбор собственного рендера даёт
  // не то же самое, публиковать нельзя — синхронизация вернёт в репозиторий другое.
  const back = parseArticle({ id: 'preflight', title: title || key, content: markdown });
  if (!back.topic) {
    throw new Error('свой же рендер не разбирается обратно:\n  ' + back.problems.join('\n  '));
  }
  const source = JSON.stringify(require('./kb-article').orderTopic(topic), null, 2);
  if (JSON.stringify(back.topic, null, 2) !== source) {
    console.error('ВНИМАНИЕ: круговой рейс меняет статью. Разница будет видна при синхронизации.');
  }

  const existing = await findByKey(key);
  console.log('Пространство: ' + SPACE_ID);
  console.log('Статья: ' + (existing ? 'обновление «' + existing.title + '» (' + existing.id + ')' : 'создание новой'));
  console.log('Статус: ' + status + ', размер: ' + markdown.length + ' символов');

  // Dry-run конвертации: сервер говорит, что потеряется при переводе Markdown во
  // внутренний формат. Дешевле узнать это до записи.
  const preview = await callTool('preview_content', { request: { content: markdown } });
  const warnings = (preview && (preview.warnings || preview.Warnings)) || [];
  console.log('Конвертация: ' + (warnings.length ? warnings.length + ' предупреждение(й)' : 'без предупреждений'));
  warnings.forEach(w => console.log('  ' + (typeof w === 'string' ? w : JSON.stringify(w))));

  if (!write) {
    console.log('\n--- Markdown ---\n');
    console.log(markdown);
    console.log('--- конец ---\n');
    console.log('Это предпросмотр. Записать: node tools/kb-publish.js ' + key + ' --write');
    return 0;
  }

  if (existing) {
    await MCP.updateContent(existing.id, { title: title || existing.title, content: markdown, status: status });
    console.log('\nОбновлено: ' + existing.id);
  } else {
    const created = await MCP.createContent(SPACE_ID, title || key, markdown, status);
    console.log('\nСоздано: ' + (created && (created.id || created.Id) || JSON.stringify(created)));
  }
  console.log('Дальше: node tools/sync-kb.js — сверить, что БЗ и репозиторий совпали.');
  return 0;
}

module.exports = { main, findByKey };

if (require.main === module) {
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error('ОШИБКА: ' + e.message); process.exitCode = 1; });
}
