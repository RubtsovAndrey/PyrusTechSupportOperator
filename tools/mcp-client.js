/**
 * MCP Client для работы с Базой Знаний
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Загрузка токена из .env.local
function loadToken() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env.local not found. Please create it with MCP_KB_TOKEN');
  }
  
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/MCP_KB_TOKEN=(.+)/);
  
  if (!match) {
    throw new Error('MCP_KB_TOKEN not found in .env.local');
  }
  
  return match[1].trim();
}

const MCP_TOKEN = loadToken();
const MCP_URL = 'https://knowledgebase.dodois.io/mcp';

/**
 * Выполнить MCP-запрос
 */
async function mcpRequest(method, params = {}, writeMode = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    
    const requestBody = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    });
    
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
      'Authorization': `Bearer ${MCP_TOKEN}`,
      'Accept': 'application/json, text/event-stream'
    };
    
    // Добавить режим записи, если требуется
    if (writeMode) {
      headers['Mcp-Mode'] = 'Write';
    }
    
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: headers
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          // Парсим SSE-формат
          // event: message
          // data: {"result": ...}
          
          let jsonData = data;
          
          // Если это SSE, извлекаем JSON из data:
          if (data.startsWith('event:')) {
            const dataMatch = data.match(/data: (.+)/);
            if (dataMatch) {
              jsonData = dataMatch[1];
            }
          }
          
          const response = JSON.parse(jsonData);
          
          if (response.error) {
            reject(new Error(`MCP Error: ${response.error.message}`));
          } else if (response.result?.isError) {
            // MCP вернул ошибку в result.content[0].text
            const errorText = response.result.content?.[0]?.text || 'Unknown error';
            reject(new Error(`MCP Tool Error: ${errorText}`));
          } else {
            // MCP возвращает result.content[0].text с JSON внутри
            if (response.result?.content?.[0]?.text) {
              try {
                const innerJson = JSON.parse(response.result.content[0].text);
                resolve(innerJson);
              } catch (parseError) {
                // Если не JSON, вернуть как есть
                resolve(response.result.content[0].text);
              }
            } else {
              resolve(response.result);
            }
          }
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}\nData: ${data.substring(0, 200)}`));
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

/**
 * MCP Tools
 */
const MCP = {
  /**
   * Получить информацию о текущем пользователе
   */
  async currentUser() {
    return mcpRequest('tools/call', {
      name: 'current_user',
      arguments: {}
    });
  },
  
  /**
   * Получить список пространств
   */
  async getSpaces() {
    const result = await mcpRequest('tools/call', {
      name: 'get_spaces',
      arguments: {}
    });
    // Вернуть массив пространств
    return result.spaces || [];
  },
  
  /**
   * Получить содержимое пространства
   */
  async getSpaceContent(spaceId) {
    return mcpRequest('tools/call', {
      name: 'get_space_content',
      arguments: {
        request: { spaceId }
      }
    });
  },
  
  /**
   * Получить статью по ID
   */
  async getContent(contentId) {
    return mcpRequest('tools/call', {
      name: 'get_content',
      arguments: {
        request: { id: contentId }
      }
    });
  },
  
  /**
   * Поиск статей
   */
  async searchContent(query, spaceIds = null) {
    const request = { query };
    if (spaceIds) {
      // Если передан один ID, преобразуем в массив
      request.spaces = Array.isArray(spaceIds) ? spaceIds : [spaceIds];
    }
    const result = await mcpRequest('tools/call', {
      name: 'search_content',
      arguments: { request }
    });
    // Вернуть массив результатов
    return result.results || [];
  },
  
  /**
   * Создать статью
   */
  async createContent(spaceId, title, markdown, status = 'draft') {
    return mcpRequest('tools/call', {
      name: 'create_content',
      arguments: {
        request: {
          spaceId,
          title,
          content: markdown,
          status
        }
      }
    }, true);  // writeMode = true
  },
  
  /**
   * Обновить статью
   */
  async updateContent(contentId, updates) {
    return mcpRequest('tools/call', {
      name: 'update_content',
      arguments: {
        request: {
          id: contentId,
          ...updates
        }
      }
    }, true);  // writeMode = true
  },
  
  /**
   * Удалить статью
   */
  async deleteContent(contentId) {
    return mcpRequest('tools/call', {
      name: 'delete_content',
      arguments: {
        request: { id: contentId }
      }
    }, true);  // writeMode = true
  }
};

module.exports = { MCP };
