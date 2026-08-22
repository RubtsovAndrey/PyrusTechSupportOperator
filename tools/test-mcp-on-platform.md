# Как протестировать MCP на платформе

## Вариант 1: Function node (рекомендуется)

1. Создайте новый граф
2. Добавьте **Function node**
3. Выберите функцию: `getKnowledgeMcp`
4. Укажите параметры:
   ```json
   {
     "query": "касса не работает"
   }
   ```
5. Запустите граф
6. Посмотрите результат в логах

---

## Вариант 2: Code node с MCP.call

В Code node используйте такой код:

```javascript
// Прямой вызов MCP
const searchResult = await MCP.call(
  "1000299722-dodo_knowledge_base_-wok",  // ID вашей MCP-интеграции
  "search_content",
  {
    request: {
      query: "касса не работает",
      limit: 3
    }
  }
);

console.log("Результаты поиска:", searchResult);

// Если нашлись статьи, получить первую
if (searchResult.results && searchResult.results.length > 0) {
  const firstArticle = await MCP.call(
    "1000299722-dodo_knowledge_base_-wok",
    "get_content",
    {
      request: {
        id: searchResult.results[0].articleId
      }
    }
  );
  
  console.log("Первая статья:", firstArticle.title);
  console.log("Содержимое:", firstArticle.content.substring(0, 200));
}

return searchResult;
```

---

## Вариант 3: Создать тестовый граф

Создайте граф с такой структурой:

```
[Start] → [Function: getKnowledgeMcp] → [Code: Display Results]
```

**Function node:**
- Function: `getKnowledgeMcp`
- query: `"касса"`

**Code node (Display Results):**
```javascript
// Входные данные из предыдущего узла
const result = input.result;

console.log("=== Результаты поиска ===");
console.log("Найдено:", result.found);
console.log("Количество статей:", result.articles?.length || 0);

if (result.articles && result.articles.length > 0) {
  result.articles.forEach((article, index) => {
    console.log(`\n--- Статья ${index + 1} ---`);
    console.log("Заголовок:", article.title);
    console.log("Метаданные:", JSON.stringify(article.metadata, null, 2));
  });
}

return result;
```

---

## Ожидаемый результат

Если всё работает правильно, вы увидите:

```
=== Результаты поиска ===
Найдено: true
Количество статей: 3

--- Статья 1 ---
Заголовок: TEST: Проблемы с кассой - смена превысила 24 часа
Метаданные: {
  "component": "POS",
  "route": "solver",
  "onSuccess": "close",
  "onFail": "operator"
}
```

---

## Troubleshooting

### Ошибка: "Functions is not defined"
**Причина:** `Functions` доступен только в User Functions, не в Code node.  
**Решение:** Используйте Function node или `MCP.call()` напрямую.

### Ошибка: "MCP integration not found"
**Причина:** Интеграция не создана или неправильный ID.  
**Решение:** Проверьте ID интеграции в UI: `1000299722-dodo_knowledge_base_-wok`

### Ошибка: "Credential not configured"
**Причина:** Токен не настроен.  
**Решение:** Credentials → Knowledge Base MCP Token → вставить токен

### Ошибка: "Access forbidden"
**Причина:** Неправильный токен или нет прав.  
**Решение:** Проверьте токен: `6682a459-5388-4727-9d8d-fdc0a486e359`
