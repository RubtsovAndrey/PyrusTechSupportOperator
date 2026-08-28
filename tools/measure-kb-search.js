// Замер: годится ли полнотекстовый поиск Базы Знаний как подбор статьи в рантайме.
//
//   node tools/measure-kb-search.js [сколько-результатов-смотреть]
//
// Вопрос, на который отвечает этот скрипт, стоит того, чтобы его считать, а не обсуждать:
// **нужен ли вообще каталог в БД, если знания живут в БЗ и читаются через MCP?** Если поиск
// БЗ по нашему пространству находит то же, что находит каталог, и не находит того, чего
// каталог не находит, — снапшот в БД лишний, и его надо убрать. Если нет — он не «второй
// источник правды», а механизм подбора, которого у БЗ нет.
//
// Набор для замера уже есть и не придуман под ответ: `tests/routing.cases.json` — это
// спецификация «что каталог обязан находить», с положительными и отрицательными случаями.
// Отрицательные тут важнее: подбор, который находит всё, бесполезен.

const path = require('path');
const { MCP, WRITE_SPACES } = require('./mcp-client');
const { parseArticle } = require('./kb-article');

const SPACE_ID = WRITE_SPACES[0];
const CASES = require(path.join('..', 'tests', 'routing.cases.json')).cases;

// Что лежит в пространстве: статьи бота (с блоком `schema`) и всё остальное. Остальное тоже
// участвует в поиске, поэтому попадание в него — тоже шум, и его надо видеть.
async function indexSpace() {
  const listing = await MCP.spaceArticles(SPACE_ID);
  const index = {};
  for (let i = 0; i < listing.length; i++) {
    const id = listing[i].articleId || listing[i].id;
    if (!id || String(listing[i].status) !== 'published') continue;
    const article = await MCP.getContent(id);
    const parsed = parseArticle(article);
    index[id] = {
      title: article.title,
      key: parsed.topic ? String(parsed.topic.key) : null
    };
  }
  return index;
}

async function main(argv) {
  const depth = Number((argv || process.argv.slice(2))[0]) || 3;
  const index = await indexSpace();
  const bot = Object.keys(index).filter(id => index[id].key);
  console.log('Пространство: ' + SPACE_ID);
  console.log('Опубликованных статей: ' + Object.keys(index).length +
    ', из них статей бота: ' + bot.length + ' (' + bot.map(id => index[id].key).join(', ') + ')');
  console.log('Смотрим первые ' + depth + ' результата(ов) поиска.\n');

  const times = [];
  let hitAt1 = 0, hitInDepth = 0, missed = 0, falsePositives = 0, quiet = 0;

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const started = Date.now();
    let results = [];
    try {
      results = await MCP.searchContent(c.query, [SPACE_ID], depth);
    } catch (e) {
      console.log('ОШИБКА  «' + c.query + '»: ' + e.message);
      continue;
    }
    times.push(Date.now() - started);

    const found = results.map(r => {
      const known = index[r.articleId];
      return known ? (known.key || '·' + known.title) : '?' + r.articleId.slice(0, 8);
    });

    if (c.expect) {
      const at = found.indexOf(c.expect);
      if (at === 0) { hitAt1++; console.log('  ✓  «' + c.query + '» → 1-е место'); }
      else if (at > 0) { hitInDepth++; console.log('  ~  «' + c.query + '» → ' + (at + 1) + '-е место, выше: ' + found.slice(0, at).join(', ')); }
      else { missed++; console.log('  ✗  «' + c.query + '» → не найдена. Выдача: ' + (found.join(', ') || 'пусто')); }
    } else {
      // Отрицательный случай: статья бота найтись не должна вовсе.
      const wrong = found.filter(f => f.indexOf('·') !== 0 && f.indexOf('?') !== 0);
      if (wrong.length) { falsePositives++; console.log('  !  «' + c.query + '» → нашлось лишнее: ' + wrong.join(', ')); }
      else { quiet++; console.log('  ·  «' + c.query + '» → молчит' + (found.length ? ' (нашлись только не-статьи бота)' : '')); }
    }
  }

  const positives = CASES.filter(c => c.expect).length;
  const negatives = CASES.length - positives;
  times.sort((a, b) => a - b);
  console.log('\n── Итог ──');
  console.log('Положительные (' + positives + '): первое место ' + hitAt1 +
    ', в пределах ' + depth + ' — ' + hitInDepth + ', не найдено ' + missed);
  console.log('Отрицательные (' + negatives + '): молчит ' + quiet + ', лишнее ' + falsePositives);
  console.log('Задержка поиска: медиана ' + times[Math.floor(times.length / 2)] +
    ' мс, максимум ' + times[times.length - 1] + ' мс (локально, не с платформы)');
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error('ОШИБКА: ' + e.message); process.exitCode = 1; });
}
