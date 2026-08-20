const { MCP } = require('./mcp-client');

async function debug() {
  console.log('Тест 1: current_user');
  const user = await MCP.currentUser();
  console.log(JSON.stringify(user, null, 2));
  console.log('');
  
  console.log('Тест 2: get_spaces');
  const spaces = await MCP.getSpaces();
  console.log('Type:', typeof spaces);
  console.log('Is Array:', Array.isArray(spaces));
  console.log(JSON.stringify(spaces, null, 2));
}

debug().catch(console.error);
