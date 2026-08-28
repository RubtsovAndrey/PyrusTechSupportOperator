// Прогон настоящего исходника getKnowledgeMcp против живого MCP-сервера Базы Знаний.
//
// Зачем отдельный скрипт, если есть tests/getknowledgemcp.test.js: тест проверяет, что код
// правильно разбирает ОЖИДАЕМЫЙ ответ, а этот скрипт — что сервер отвечает так, как мы
// ожидаем. Раньше это проверялось клиентом из tools/mcp-client.js, то есть вторым, другим
// кодом — и именно поэтому «MCP работает» и «функция работает» оказались разными вещами.
// Здесь исполняется тот же файл, который уезжает на платформу, без единой правки.
//
//   node tools/kb-mcp-live.js "смена превысила 24 часа"
//
// Токен берётся из .env.local (MCP_KB_TOKEN) и подставляется вместо хранилища платформы.
const fs = require("fs");
const path = require("path");
const https = require("https");
const { loadFunction, makeEnv } = require("../tests/harness");

const ROOT = path.resolve(__dirname, "..");
const CRED = "1000299722-kbmcptoken-vod";

function loadToken() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) throw new Error(".env.local не найден: нужен MCP_KB_TOKEN");
  const m = /MCP_KB_TOKEN=(.+)/.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error("в .env.local нет MCP_KB_TOKEN");
  return m[1].trim();
}

// Адаптер Http платформы поверх node:https. Сознательно повторяет два её свойства, на
// которые опирается функция: `body` отдаётся строкой (сервер отвечает text/event-stream, и
// платформе разбирать там нечего), а тело при не-2xx не отдаётся вовсе.
function httpPost(a) {
  return new Promise((resolve, reject) => {
    const url = new URL(a.url);
    const payload = JSON.stringify(a.body);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: "POST",
      headers: Object.assign({ "Content-Length": Buffer.byteLength(payload) }, a.headers)
    }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: res.statusCode >= 200 && res.statusCode < 300 ? data : null
      }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const query = process.argv[2] || "смена превысила 24 часа";
  const spaceIds = process.argv[3] || null;
  const limit = process.argv[4] ? Number(process.argv[4]) : null;

  const getKnowledge = loadFunction(
    "functions/ID_Tools/getKnowledgeMcp/code.js", ["query", "spaceIds", "limit"]);

  const logs = [];
  const env = makeEnv({ credentials: { [CRED]: loadToken() } });
  env.Http = { post: httpPost, get: () => { throw new Error("не используется"); } };
  ["info", "warn", "error"].forEach(level => {
    env.Log[level] = a => logs.push(level.toUpperCase() + " " + a.message);
  });

  console.log("запрос: «" + query + "»" + (spaceIds ? ", пространства: " + spaceIds : ""));
  const result = await getKnowledge(env, [query, spaceIds, limit]);

  console.log("\n— лог функции —");
  logs.forEach(l => console.log("  " + l));

  console.log("\n— запросы к серверу —");
  env.posts.forEach(p => console.log("  " + p.body.params.name + " " +
    JSON.stringify(p.body.params.arguments.request)));

  console.log("\n— результат —");
  console.log("  found: " + result.found + (result.error ? ", error: " + result.error : ""));
  (result.articles || []).forEach((a, i) => {
    console.log("  " + (i + 1) + ". " + a.title);
    console.log("     id: " + a.articleId + ", пространство: " + a.spaceTitle);
    console.log("     содержимое: " + String(a.content).length + " символов");
    console.log("     метаданные: " + JSON.stringify(a.metadata));
  });
  if (!result.found) process.exitCode = 1;
}

main().catch(e => { console.error("СБОЙ: " + (e && e.stack ? e.stack : e)); process.exit(1); });
