# Прямой тест MCP через Code node

## Проблема
Платформа откатывает изменения в графе при экспорте.
Тестовые узлы удаляются, потому что их нет на платформе.

## Решение
Тестировать MCP напрямую через Code node на платформе.

---

## 🧪 КОД ДЛЯ ТЕСТА

Создайте **Code node** на платформе и вставьте этот код:

```javascript
// ============================================
// ТЕСТ MCP ИНТЕГРАЦИИ
// ============================================

console.log("=== MCP INTEGRATION TEST START ===");
console.log("Timestamp:", new Date().toISOString());

const MCP_KEY = "1000299722-dodo_knowledge_base_-rqp";
const TEST_QUERY = "касса не работает";

try {
  // 1. Поиск статей
  console.log("\n--- STEP 1: Search articles ---");
  console.log("Query:", TEST_QUERY);
  
  const searchResult = await MCP.call(
    MCP_KEY,
    "search_content",
    {
      request: {
        query: TEST_QUERY,
        limit: 5
      }
    }
  );
  
  console.log("Search completed");
  console.log("Results found:", searchResult?.results?.length || 0);
  
  if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
    console.log("❌ No articles found");
    return {
      success: false,
      error: "No articles found",
      searchResult: searchResult
    };
  }
  
  // 2. Получить первую статью
  console.log("\n--- STEP 2: Get first article ---");
  const firstResult = searchResult.results[0];
  console.log("Article ID:", firstResult.articleId);
  console.log("Title:", firstResult.title);
  
  const article = await MCP.call(
    MCP_KEY,
    "get_content",
    {
      request: {
        id: firstResult.articleId
      }
    }
  );
  
  console.log("Article retrieved");
  console.log("Content length:", article.content?.length || 0);
  
  // 3. Парсить метаданные
  console.log("\n--- STEP 3: Parse metadata ---");
  
  let yamlMatch = article.content?.match(/```yaml metadata\n([\s\S]*?)\n```/);
  if (!yamlMatch) {
    yamlMatch = article.content?.match(/```yaml\n([\s\S]*?)\n```/);
  }
  
  let metadata = {};
  if (yamlMatch) {
    console.log("✅ YAML block found");
    const yamlContent = yamlMatch[1];
    console.log("YAML content:\n" + yamlContent);
    
    // Простой парсинг
    const lines = yamlContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;
      
      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();
      
      // Убрать кавычки
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // Булевы значения
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      
      metadata[key] = value;
    }
    
    console.log("Parsed metadata:", JSON.stringify(metadata, null, 2));
  } else {
    console.log("⚠️  No YAML metadata found");
  }
  
  // 4. Результат
  console.log("\n--- RESULT ---");
  const result = {
    success: true,
    found: searchResult.results.length,
    articles: searchResult.results.map((r, i) => ({
      index: i + 1,
      id: r.articleId,
      title: r.title,
      spaceTitle: r.spaceTitle
    })),
    firstArticle: {
      id: article.id,
      title: article.title,
      contentLength: article.content?.length,
      metadata: metadata
    }
  };
  
  console.log("=== MCP INTEGRATION TEST SUCCESS ===");
  console.log(JSON.stringify(result, null, 2));
  
  return result;
  
} catch (error) {
  console.error("\n=== MCP INTEGRATION TEST FAILED ===");
  console.error("Error:", error);
  console.error("Message:", error.message);
  console.error("Stack:", error.stack);
  
  return {
    success: false,
    error: error.message,
    stack: error.stack
  };
}
```

---

## 📊 Ожидаемый результат

### ✅ Успех:

```json
{
  "success": true,
  "found": 3,
  "articles": [
    {
      "index": 1,
      "id": "08defec4-a23b-446c-8a35-5c74700375be",
      "title": "TEST: Проблемы с кассой - смена превысила 24 часа",
      "spaceTitle": "ИИ Техподдержка - Конфигурация"
    },
    ...
  ],
  "firstArticle": {
    "id": "08defec4-a23b-446c-8a35-5c74700375be",
    "title": "TEST: Проблемы с кассой - смена превысила 24 часа",
    "contentLength": 948,
    "metadata": {
      "component": "POS",
      "subcomponent": "ККМ",
      "route": "solver",
      "onSuccess": "close",
      "onFail": "operator",
      "requiresEmail": false,
      "requiresSubtask": false,
      "priority": "normal",
      "estimatedTime": "5 минут"
    }
  }
}
```

### ❌ Ошибка:

```json
{
  "success": false,
  "error": "MCP integration not found",
  "stack": "..."
}
```

---

## 🔍 Что проверяем

1. ✅ MCP-интеграция `1000299722-dodo_knowledge_base_-rqp` доступна
2. ✅ Инструмент `search_content` работает
3. ✅ Инструмент `get_content` работает
4. ✅ Статьи находятся по запросу "касса не работает"
5. ✅ YAML-метаданные присутствуют в статьях
6. ✅ Метаданные парсятся корректно

---

## 📝 Логи

В консоли должны быть:

```
=== MCP INTEGRATION TEST START ===
Timestamp: 2026-08-22T09:15:00.000Z

--- STEP 1: Search articles ---
Query: касса не работает
Search completed
Results found: 3

--- STEP 2: Get first article ---
Article ID: 08defec4-a23b-446c-8a35-5c74700375be
Title: TEST: Проблемы с кассой - смена превысила 24 часа
Article retrieved
Content length: 948

--- STEP 3: Parse metadata ---
✅ YAML block found
YAML content:
component: POS
subcomponent: ККМ
route: solver
...

Parsed metadata: {
  "component": "POS",
  "subcomponent": "ККМ",
  "route": "solver",
  ...
}

--- RESULT ---
=== MCP INTEGRATION TEST SUCCESS ===
{
  "success": true,
  ...
}
```

---

## ⚡ Быстрый тест

Если хотите просто проверить, что MCP работает:

```javascript
const result = await MCP.call(
  "1000299722-dodo_knowledge_base_-rqp",
  "search_content",
  {
    request: {
      query: "касса",
      limit: 1
    }
  }
);

console.log("MCP works:", !!result);
console.log("Found:", result?.results?.length || 0);
return result;
```
