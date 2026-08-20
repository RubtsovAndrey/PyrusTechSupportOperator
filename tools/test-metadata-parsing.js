/**
 * Тестирование парсинга метаданных из созданных статей
 */

const { MCP } = require('./mcp-client');
const { parseArticleMetadata } = require('./parse-metadata');

const CONFIG_SPACE_ID = '6d8f5fa3-7fd4-44c8-978d-68743b232533';

const testArticles = [
  {
    title: 'TEST: Проблемы с кассой - смена превысила 24 часа',
    expectedMetadata: {
      component: 'POS',
      subcomponent: 'ККМ',
      route: 'solver',
      onSuccess: 'close',
      onFail: 'operator',
      requiresEmail: false,
      requiresSubtask: false,
      priority: 'normal'
    }
  },
  {
    title: 'TEST: Изменение данных сотрудника',
    expectedMetadata: {
      component: 'Staff',
      route: 'subtask',
      onSuccess: 'subtask',
      requiresEmail: true,
      requiresSubtask: true,
      priority: 'normal'
    }
  },
  {
    title: 'TEST: Критическая ситуация',
    expectedMetadata: {
      component: 'Emergency',
      route: 'escalate',
      priority: 'critical',
      requiresEmail: false,
      requiresSubtask: false
    }
  }
];

async function testMetadataParsing() {
  console.log('🧪 Тестирование парсинга метаданных\n');
  
  let passedTests = 0;
  let failedTests = 0;
  
  for (const test of testArticles) {
    console.log(`\n📄 Статья: "${test.title}"`);
    console.log('─'.repeat(80));
    
    try {
      // 1. Найти статью
      const searchResults = await MCP.searchContent(test.title, [CONFIG_SPACE_ID]);
      
      if (searchResults.length === 0) {
        console.log('❌ Статья не найдена в поиске');
        failedTests++;
        continue;
      }
      
      const articleId = searchResults[0].articleId;
      console.log(`✅ Найдена (ID: ${articleId})`);
      
      // 2. Получить полную статью
      const article = await MCP.getContent(articleId);
      console.log(`✅ Получена (длина: ${article.content?.length || 0} символов)`);
      
      // 3. Парсить метаданные
      const metadata = parseArticleMetadata(article);
      
      if (!metadata || Object.keys(metadata).length === 0) {
        console.log('❌ Метаданные не найдены');
        failedTests++;
        continue;
      }
      
      console.log('\n📊 Извлечённые метаданные:');
      Object.entries(metadata).forEach(([key, value]) => {
        console.log(`   ${key}: ${value}`);
      });
      
      // 4. Проверить соответствие ожидаемым
      console.log('\n✓ Проверка соответствия:');
      let allMatch = true;
      
      for (const [key, expectedValue] of Object.entries(test.expectedMetadata)) {
        const actualValue = metadata[key];
        const match = actualValue == expectedValue;  // == для сравнения true/"true"
        
        if (match) {
          console.log(`   ✅ ${key}: ${actualValue} (ожидалось: ${expectedValue})`);
        } else {
          console.log(`   ❌ ${key}: ${actualValue} (ожидалось: ${expectedValue})`);
          allMatch = false;
        }
      }
      
      if (allMatch) {
        console.log('\n✅ ВСЕ МЕТАДАННЫЕ КОРРЕКТНЫ!');
        passedTests++;
      } else {
        console.log('\n⚠️  Некоторые метаданные не совпадают');
        failedTests++;
      }
      
      // 5. Показать начало статьи
      if (article.content) {
        console.log('\n📝 Начало статьи (первые 200 символов):');
        console.log('─'.repeat(80));
        console.log(article.content.substring(0, 200));
        console.log('─'.repeat(80));
      }
      
    } catch (error) {
      console.error(`❌ Ошибка: ${error.message}`);
      failedTests++;
    }
  }
  
  // Итоги
  console.log('\n\n' + '═'.repeat(80));
  console.log('📊 ИТОГИ ТЕСТИРОВАНИЯ');
  console.log('═'.repeat(80));
  console.log(`✅ Успешно: ${passedTests}/${testArticles.length}`);
  console.log(`❌ Ошибок: ${failedTests}/${testArticles.length}`);
  
  if (failedTests === 0) {
    console.log('\n🎉 ВСЕ ТЕСТЫ ПРОШЛИ УСПЕШНО!');
    console.log('\n✅ Парсинг метаданных работает корректно');
    console.log('✅ Формат YAML в code block поддерживается');
    console.log('✅ Готово к интеграции в проект!');
  } else {
    console.log('\n⚠️  Есть проблемы с парсингом метаданных');
  }
  
  return failedTests === 0;
}

// Запуск
testMetadataParsing()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('\n❌ Критическая ошибка:', error);
    process.exit(1);
  });
