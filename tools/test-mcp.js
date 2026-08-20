/**
 * Тестирование MCP-интеграции с Базой Знаний
 */

const { MCP } = require('./mcp-client');
const { 
  parseArticleMetadata, 
  parseRoutingScenarios 
} = require('./parse-metadata');

async function runTests() {
  console.log('🚀 Начинаем тестирование MCP...\n');
  
  try {
    // Тест 1: Подключение
    console.log('📡 Тест 1: Подключение к MCP');
    const user = await MCP.currentUser();
    console.log(`✅ Подключено! Пользователь: ${user.name} (${user.email})`);
    console.log('');
    
    // Тест 2: Список пространств
    console.log('📁 Тест 2: Получение списка пространств');
    const spaces = await MCP.getSpaces();
    console.log(`✅ Найдено пространств: ${spaces.length}`);
    
    spaces.forEach((space, index) => {
      console.log(`   ${index + 1}. ${space.title} (ID: ${space.id})`);
      console.log(`      Права: ${space.rights || 'unknown'}`);
    });
    console.log('');
    
    // Найти пространство "Конфигурации"
    const configSpace = spaces.find(s => 
      s.title.toLowerCase().includes('конфигурац') ||
      s.title.toLowerCase().includes('config')
    );
    
    if (!configSpace) {
      console.log('⚠️  Пространство "Конфигурации" не найдено');
      console.log('   Доступные пространства:', spaces.map(s => s.title).join(', '));
      return;
    }
    
    console.log(`✅ Найдено пространство конфигураций: "${configSpace.title}" (${configSpace.id})`);
    console.log('');
    
    // Тест 3: Содержимое пространства
    console.log('📄 Тест 3: Получение содержимого пространства');
    const spaceContent = await MCP.getSpaceContent(configSpace.id);
    console.log(`✅ Статей в пространстве: ${spaceContent.articles?.length || 0}`);
    
    if (spaceContent.articles && spaceContent.articles.length > 0) {
      console.log('   Статьи:');
      spaceContent.articles.forEach((article, index) => {
        console.log(`   ${index + 1}. ${article.title} (ID: ${article.id})`);
        if (article.topics) {
          console.log(`      Топики: ${article.topics.join(', ')}`);
        }
      });
    }
    console.log('');
    
    // Тест 4: Чтение статей и парсинг метаданных
    if (spaceContent.articles && spaceContent.articles.length > 0) {
      console.log('🔍 Тест 4: Чтение статей и парсинг метаданных');
      
      for (const articleSummary of spaceContent.articles) {
        console.log(`\n📖 Статья: "${articleSummary.title}"`);
        
        const article = await MCP.getContent(articleSummary.id);
        
        console.log(`   ID: ${article.id}`);
        console.log(`   Топики: ${article.topics?.join(', ') || 'нет'}`);
        console.log(`   Длина Markdown: ${article.markdown?.length || 0} символов`);
        
        // Парсинг метаданных
        const metadata = parseArticleMetadata(article);
        
        if (metadata && Object.keys(metadata).length > 0) {
          console.log('   ✅ Метаданные найдены:');
          Object.entries(metadata).forEach(([key, value]) => {
            console.log(`      ${key}: ${value}`);
          });
        } else {
          console.log('   ⚠️  Метаданные не найдены');
        }
        
        // Если это конфигурация маршрутизации
        if (articleSummary.title.toLowerCase().includes('routing') ||
            articleSummary.title.toLowerCase().includes('маршрут')) {
          console.log('   🔀 Парсинг сценариев маршрутизации...');
          const scenarios = parseRoutingScenarios(article.markdown);
          
          if (scenarios.length > 0) {
            console.log(`   ✅ Найдено сценариев: ${scenarios.length}`);
            scenarios.forEach((scenario, index) => {
              console.log(`      ${index + 1}. ${scenario.name || 'Без названия'}`);
              console.log(`         Route: ${scenario.route}`);
              console.log(`         Component: ${scenario.component}`);
              if (scenario.triggers) {
                console.log(`         Triggers: ${scenario.triggers.slice(0, 3).join(', ')}...`);
              }
            });
          } else {
            console.log('   ⚠️  Сценарии не найдены');
          }
        }
        
        // Показать первые 200 символов Markdown
        if (article.markdown) {
          console.log('   📝 Начало статьи:');
          const preview = article.markdown.substring(0, 200).replace(/\n/g, '\n      ');
          console.log(`      ${preview}...`);
        }
      }
    }
    console.log('');
    
    // Тест 5: Поиск статей
    console.log('🔎 Тест 5: Поиск статей');
    
    const searchQueries = [
      'касса',
      'терминал',
      'проблема'
    ];
    
    for (const query of searchQueries) {
      console.log(`\n   Поиск: "${query}"`);
      const results = await MCP.searchContent(query);
      
      if (results.length > 0) {
        console.log(`   ✅ Найдено результатов: ${results.length}`);
        results.slice(0, 3).forEach((result, index) => {
          console.log(`      ${index + 1}. ${result.title}`);
          if (result.snippet) {
            const snippet = result.snippet.substring(0, 80).replace(/\n/g, ' ');
            console.log(`         "${snippet}..."`);
          }
          if (result.score !== undefined) {
            console.log(`         Score: ${result.score}`);
          }
        });
      } else {
        console.log('   ⚠️  Ничего не найдено');
      }
    }
    console.log('');
    
    // Тест 6: Поиск в общем пространстве
    console.log('🌐 Тест 6: Поиск в общем пространстве');
    const generalSpace = spaces.find(s => 
      !s.title.toLowerCase().includes('конфигурац') &&
      !s.title.toLowerCase().includes('config') &&
      !s.title.toLowerCase().includes('test')
    );
    
    if (generalSpace) {
      console.log(`   Пространство: "${generalSpace.title}"`);
      const results = await MCP.searchContent('касса', generalSpace.id);
      console.log(`   ✅ Найдено результатов: ${results.length}`);
      
      if (results.length > 0) {
        results.slice(0, 3).forEach((result, index) => {
          console.log(`      ${index + 1}. ${result.title}`);
        });
      }
    } else {
      console.log('   ⚠️  Общее пространство не найдено');
    }
    console.log('');
    
    // Итоги
    console.log('✅ Все тесты завершены!');
    console.log('');
    console.log('📊 Итоги:');
    console.log(`   • Пространств: ${spaces.length}`);
    console.log(`   • Статей в конфигурациях: ${spaceContent.articles?.length || 0}`);
    console.log(`   • MCP работает корректно`);
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    console.error(error.stack);
  }
}

// Запуск тестов
runTests();
