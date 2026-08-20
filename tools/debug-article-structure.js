const { MCP } = require('./mcp-client');

const CONFIG_SPACE_ID = '6d8f5fa3-7fd4-44c8-978d-68743b232533';

async function debug() {
  console.log('Поиск статьи...\n');
  
  const results = await MCP.searchContent('TEST: Проблемы с кассой', [CONFIG_SPACE_ID]);
  
  if (results.length === 0) {
    console.log('Статья не найдена');
    return;
  }
  
  console.log('Получение статьи...\n');
  const article = await MCP.getContent(results[0].articleId);
  
  console.log('Структура статьи:');
  console.log('Keys:', Object.keys(article));
  console.log('\nFull article:');
  console.log(JSON.stringify(article, null, 2));
}

debug().catch(console.error);
