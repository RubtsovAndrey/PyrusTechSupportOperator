// MCP-клиент Базы Знаний для локальных инструментов (`tools/`, `tests/`).
//
// Это НЕ то, чем читает БЗ бот: на платформе транспорт живёт в
// `functions/ID_Tools/getKnowledgeMcp/code.js` поверх `Http`. Здесь — тот же протокол на
// node:https, для синхронизации каталога, переноса статей и разведки.
//
// ── Запись ограничена одним пространством, и дважды ──
// У токена права writer в трёх пространствах, включая «Техподдержка 🛠️» с 889 живыми
// статьями. Ошибка в скрипте там — это испорченная документация, которой пользуются люди,
// поэтому запрет не полагается на аккуратность вызывающего:
//
// 1. Заголовком `Mcp-Write-Spaces` — сервер сам отклоняет запись в любое другое
//    пространство (см. github.com/dodopizza/knowledgebase-mcp-connect, раздел 4).
// 2. Проверкой на нашей стороне, до отправки запроса. Для `update_content` и
//    `delete_content` пространство статьи не передаётся аргументом вовсе, поэтому оно
//    сначала читается через `get_content` — иначе «запретили себе» держалось бы только на
//    том, что сервер не забудет про заголовок.
//
// `Mcp-Mode: Write` добавляется ТОЛЬКО к write-вызовам. Без него сервер не отдаёт
// write-инструменты даже в списке, и это ровно то поведение, которое нам нужно по умолчанию.

const https = require('https');
const fs = require('fs');
const path = require('path');

const MCP_URL = 'https://knowledgebase.dodois.io/mcp';

// Наше пространство — «ИИ Техподдержка - Конфигурация». Единственное, куда разрешено писать.
const WRITE_SPACES = ['6d8f5fa3-7fd4-44c8-978d-68743b232533'];

// Пространства, которые обязаны остаться нетронутыми. Перечислены не ради проверки (её
// делает белый список выше), а чтобы в коде было видно, что стоит за запретом.
const READ_ONLY_SPACES = {
  '9f2a0e8b-3109-4354-afe0-0f6fc9a6ce0d': 'Пространство техподдержки 🔒 (96 статей)',
  '963b66c2-e111-43c6-a9ff-e7e5af3e4244': 'Техподдержка 🛠️ (889 статей)'
};

const WRITE_TOOLS = ['create_content', 'update_content', 'delete_content', 'upload_image'];

function loadToken() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env.local not found. Please create it with MCP_KB_TOKEN');
  }
  const match = fs.readFileSync(envPath, 'utf-8').match(/MCP_KB_TOKEN=(.+)/);
  if (!match) throw new Error('MCP_KB_TOKEN not found in .env.local');
  return match[1].trim();
}

const MCP_TOKEN = loadToken();

function assertWritable(spaceId, what) {
  const id = String(spaceId || '').toLowerCase();
  if (WRITE_SPACES.some(s => s.toLowerCase() === id)) return;
  const known = READ_ONLY_SPACES[String(spaceId)] || spaceId || 'неизвестное пространство';
  throw new Error('запись запрещена: ' + what + ' в ' + known +
    '. Разрешено только ' + WRITE_SPACES.join(', '));
}

// method — 'tools/call' или 'tools/list'.
function request(method, params, writeMode) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + MCP_TOKEN,
      // Сервер отвечает 406, если клиент не принимает оба типа: он всегда отдаёт SSE.
      'Accept': 'application/json, text/event-stream'
    };
    if (writeMode) {
      headers['Mcp-Mode'] = 'Write';
      headers['Mcp-Write-Spaces'] = WRITE_SPACES.join(',');
    }

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: headers
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('MCP ответил ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
        try {
          resolve(unwrap(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Три слоя: SSE → конверт JSON-RPC → JSON строкой в result.content[0].text.
function unwrap(raw) {
  let text = raw;
  if (String(raw).indexOf('event:') === 0) {
    const chunks = [];
    String(raw).split(/\r?\n/).forEach(line => {
      if (line.indexOf('data:') === 0) chunks.push(line.slice(5).trim());
    });
    text = chunks.join('');
  }
  const envelope = JSON.parse(text);
  if (envelope.error) throw new Error('MCP error ' + envelope.error.code + ': ' + envelope.error.message);
  const result = envelope.result || {};
  if (result.isError) {
    const message = result.content && result.content[0] ? result.content[0].text : 'без текста';
    throw new Error('MCP tool error: ' + message);
  }
  if (result.content && result.content[0] && typeof result.content[0].text === 'string') {
    try { return JSON.parse(result.content[0].text); } catch (e) { return result.content[0].text; }
  }
  return result;
}

function callTool(name, args) {
  const writeMode = WRITE_TOOLS.indexOf(name) >= 0;
  return request('tools/call', { name: name, arguments: args || {} }, writeMode);
}

const MCP = {
  // Список инструментов. `write: true` — с заголовком режима записи; без него сервер
  // write-инструменты не показывает вовсе, и по разнице видно, что режим реально работает.
  async listTools(write) {
    const result = await request('tools/list', {}, !!write);
    return (result && result.tools) || [];
  },

  async currentUser() {
    return callTool('current_user', {});
  },

  async getSpaces() {
    const result = await callTool('get_spaces', {});
    return result.spaces || [];
  },

  async getSpaceContent(spaceId, page, limit) {
    const request_ = { spaceId: spaceId };
    if (page) request_.page = page;
    if (limit) request_.limit = limit;
    return callTool('get_space_content', { request: request_ });
  },

  // Всё оглавление пространства, страницами. Постраничность важна не для нашего
  // пространства (в нём единицы статей), а для того, чтобы синхронизация не начала молча
  // терять статьи, когда их станет больше размера страницы.
  async spaceArticles(spaceId, pageSize) {
    const limit = pageSize || 100;
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const chunk = await MCP.getSpaceContent(spaceId, page, limit);
      // Оглавление лежит в `content` — проверено на живом ответе. Имя неочевидное (у
      // статьи `content` это её Markdown), поэтому оно записано здесь, а не угадывается.
      const items = (chunk && chunk.content) || [];
      items.forEach(item => all.push(item));
      const total = chunk && chunk.pagination ? chunk.pagination.totalPages : null;
      if (!items.length || (total && page >= total)) break;
    }
    return all;
  },

  async getContent(contentId) {
    return callTool('get_content', { request: { id: contentId } });
  },

  async searchContent(query, spaceIds, limit) {
    const request_ = { query: query };
    if (spaceIds) request_.spaces = Array.isArray(spaceIds) ? spaceIds : [spaceIds];
    if (limit) request_.limit = limit;
    const result = await callTool('search_content', { request: request_ });
    return result.results || [];
  },

  async createContent(spaceId, title, markdown, status) {
    assertWritable(spaceId, 'создание статьи «' + title + '»');
    return callTool('create_content', {
      request: { spaceId: spaceId, title: title, content: markdown, status: status || 'draft' }
    });
  },

  // Пространство статьи аргументом не передаётся, поэтому читается перед записью: без этого
  // «запретили себе» держалось бы только на заголовке, то есть на чужой стороне.
  async updateContent(contentId, updates) {
    const existing = await MCP.getContent(contentId);
    assertWritable(existing && existing.space ? existing.space.id : null,
      'правка статьи «' + (existing ? existing.title : contentId) + '»');
    return callTool('update_content', { request: Object.assign({ id: contentId }, updates || {}) });
  },

  async deleteContent(contentId) {
    const existing = await MCP.getContent(contentId);
    assertWritable(existing && existing.space ? existing.space.id : null,
      'удаление статьи «' + (existing ? existing.title : contentId) + '»');
    return callTool('delete_content', { request: { id: contentId } });
  }
};

module.exports = { MCP, WRITE_SPACES, READ_ONLY_SPACES, assertWritable, callTool };
