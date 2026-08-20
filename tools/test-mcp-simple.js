const { MCP } = require('./mcp-client');
const { parseArticleMetadata } = require('./parse-metadata');

const CONFIG_SPACE_ID = '6d8f5fa3-7fd4-44c8-978d-68743b232533'; // ИИ Техподдержка - Конфигурация
const TECH_SPACE_ID = '963b66c2-e111-43c6-a9ff-e7e5af3e4244'; // Техподдержка 🛠️

async function test() {
  console.log('🧪 Упрощённый тест MCP\n');
  
  // Тест 1: Поиск
  console.log('1️⃣ Поиск статей по слову "касса"');
  try {
    const results = await MCP.searchContent('касса');
    console.log(`✅ Найдено: ${results.length} результатов`);
    
    if (results.length > 0) {
      console.log('\nПервые 3 результата:');
      results.slice(0, 3).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.articleTitle || 'Без названия'}`);
        console.log(`      ID: ${r.articleId}`);
        if (r.excerpt) {
          console.log(`      Excerpt: ${r.excerpt.substring(0, 80)}...`);
        }
      });
      
      // Попробуем получить первую статью
      const firstId = results[0].articleId;
      if (firstId) {
        console.log(`\n2️⃣ Получение статьи ${firstId}`);
        const article = await MCP.getContent(firstId);
        
        console.log(`✅ Статья получена:`);
        console.log(`   Заголовок: ${article.title}`);
        console.log(`   Топики: ${article.topics?.join(', ') || 'нет'}`);
        console.log(`   Длина Markdown: ${article.markdown?.length || 0} символов`);
        
        // Парсинг метаданных
        console.log(`\n3️⃣ Парсинг метаданных`);
        const metadata = parseArticleMetadata(article);
        
        if (metadata && Object.keys(metadata).length > 0) {
          console.log(`✅ Метаданные найдены:`);
          Object.entries(metadata).forEach(([key, value]) => {
            console.log(`   ${key}: ${value}`);
          });
        } else {
          console.log(`⚠️  Метаданные не найдены`);
        }
        
        // Показать начало статьи
        if (article.markdown) {
          console.log(`\n📝 Начало статьи (первые 300 символов):`);
          console.log('---');
          console.log(article.markdown.substring(0, 300));
          console.log('---');
        }
      }
    }
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
  
  // Тест 2: Поиск в конкретном пространстве
  console.log(`\n\n4️⃣ Поиск в пространстве "Техподдержка"`);
  try {
    const results = await MCP.searchContent('терминал', TECH_SPACE_ID);
    console.log(`✅ Найдено: ${results.length} результатов`);
    
    if (results.length > 0) {
      results.slice(0, 3).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.articleTitle}`);
      });
    }
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
  
  console.log('\n✅ Тесты завершены!');
}

test().catch(console.error);
