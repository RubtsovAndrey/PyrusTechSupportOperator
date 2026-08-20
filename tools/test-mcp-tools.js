const https = require('https');
const fs = require('fs');
const path = require('path');

// Загрузка токена
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const match = envContent.match(/MCP_KB_TOKEN=(.+)/);
const MCP_TOKEN = match[1].trim();

const MCP_URL = 'https://knowledgebase.dodois.io/mcp';

async function listTools() {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    
    const requestBody = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list',
      params: {}
    });
    
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'Authorization': `Bearer ${MCP_TOKEN}`,
        'Accept': 'application/json, text/event-stream'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log('Raw response:');
        console.log(data);
        console.log('\n---\n');
        
        try {
          // Парсим SSE
          let jsonData = data;
          if (data.startsWith('event:')) {
            const dataMatch = data.match(/data: (.+)/);
            if (dataMatch) {
              jsonData = dataMatch[1];
            }
          }
          
          const response = JSON.parse(jsonData);
          console.log('Parsed response:');
          console.log(JSON.stringify(response, null, 2));
          
          resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(requestBody);
    req.end();
  });
}

listTools().catch(console.error);
