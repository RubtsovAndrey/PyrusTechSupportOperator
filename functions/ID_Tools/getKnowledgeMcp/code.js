const MCP_KEY = "1000299722-dodo_knowledge_base_-rqp";
const DEFAULT_LIMIT = 3;

/**
 * Парсит метаданные из YAML-блока в Markdown
 */
function parseMetadata(markdown) {
  if (!markdown) {
    return {};
  }
  
  // Ищем блок ```yaml metadata ... ``` или просто ```yaml ... ```
  let yamlBlockRegex = /```yaml metadata\n([\s\S]*?)\n```/;
  let match = markdown.match(yamlBlockRegex);
  
  // Если не найден с "metadata", пробуем без него
  if (!match) {
    yamlBlockRegex = /```yaml\n([\s\S]*?)\n```/;
    match = markdown.match(yamlBlockRegex);
  }
  
  if (!match) {
    return {};
  }
  
  const yamlContent = match[1];
  const metadata = {};
  const lines = yamlContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    
    const key = trimmed.substring(0, colonIndex).trim();
    let value = trimmed.substring(colonIndex + 1).trim();
    
    // Убрать кавычки
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    // Преобразовать булевы значения
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    
    metadata[key] = value;
  }
  
  return metadata;
}

/**
 * Главная функция
 */
async function main({ query, spaceIds, limit }) {
  const resultLimit = limit || DEFAULT_LIMIT;
  
  console.log("=== getKnowledgeMcp START ===");
  console.log("Query:", query);
  console.log("SpaceIds:", spaceIds);
  console.log("Limit:", resultLimit);
  console.log("MCP_KEY:", MCP_KEY);
  
  try {
    // 1. Поиск статей через MCP
    const searchParams = {
      request: {
        query: query,
        limit: resultLimit
      }
    };
    
    // Добавить фильтр по пространствам, если указано
    if (spaceIds && spaceIds.trim()) {
      const spaces = spaceIds.split(',').map(s => s.trim()).filter(Boolean);
      if (spaces.length > 0) {
        searchParams.request.spaces = spaces;
        console.log("Filtering by spaces:", spaces);
      }
    }
    
    console.log("Calling MCP search_content...");
    const searchResult = await MCP.call(MCP_KEY, "search_content", searchParams);
    console.log("Search result:", searchResult ? "OK" : "NULL");
    
    if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
      console.log("No results found");
      return {
        found: false,
        articles: []
      };
    }
    
    console.log("Found articles:", searchResult.results.length);
    
    // 2. Получить полные статьи с метаданными
    const articles = [];
    
    for (const result of searchResult.results.slice(0, resultLimit)) {
      try {
        console.log(`Getting article ${result.articleId}...`);
        const article = await MCP.call(MCP_KEY, "get_content", {
          request: { id: result.articleId }
        });
        
        // Парсить метаданные
        const metadata = parseMetadata(article.content);
        console.log(`Article "${article.title}" metadata:`, Object.keys(metadata).length, "fields");
        
        articles.push({
          articleId: article.id,
          title: article.title,
          content: article.content,
          excerpt: result.excerpt,
          spaceId: result.spaceId,
          spaceTitle: result.spaceTitle,
          metadata: metadata
        });
      } catch (error) {
        // Пропустить статью, если не удалось получить
        console.error(`Failed to get article ${result.articleId}:`, error);
      }
    }
    
    console.log("=== getKnowledgeMcp SUCCESS ===");
    console.log("Total articles:", articles.length);
    
    return {
      found: articles.length > 0,
      articles: articles
    };
    
  } catch (error) {
    console.error("=== getKnowledgeMcp ERROR ===");
    console.error("Error:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    return {
      found: false,
      articles: [],
      error: error.message
    };
  }
}