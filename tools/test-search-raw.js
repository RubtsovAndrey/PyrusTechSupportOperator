const { MCP } = require('./mcp-client');

async function test() {
  console.log('Тест search_content\n');
  
  const result = await MCP.searchContent('касса');
  
  console.log('Type:', typeof result);
  console.log('Is Array:', Array.isArray(result));
  console.log('\nFull result:');
  console.log(JSON.stringify(result, null, 2));
}

test().catch(console.error);
