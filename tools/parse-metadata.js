/**
 * Парсинг метаданных из статей БЗ
 */

/**
 * Извлекает метаданные из YAML-блока в Markdown
 * 
 * Формат:
 * ```yaml metadata
 * component: POS
 * route: solver
 * ```
 */
function parseMetadataFromMarkdown(markdown) {
  if (!markdown) {
    return null;
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
    return null;
  }
  
  const yamlContent = match[1];
  
  // Простой YAML-парсер (для базовых key: value)
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
  
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Извлекает метаданные из топиков вида "key:value"
 */
function parseMetadataFromTopics(topics) {
  if (!topics || !Array.isArray(topics)) {
    return {};
  }
  
  const metadata = {};
  
  topics.forEach(topic => {
    // Топики вида "component:POS"
    if (topic.includes(':')) {
      const [key, value] = topic.split(':');
      metadata[key.trim()] = value.trim();
    }
  });
  
  return metadata;
}

/**
 * Комбинированный парсинг: сначала YAML, потом топики
 */
function parseArticleMetadata(article) {
  // Приоритет 1: YAML-блок в markdown или content
  let metadata = parseMetadataFromMarkdown(article.markdown || article.content);
  
  // Приоритет 2: Топики
  if (!metadata && article.topics) {
    metadata = parseMetadataFromTopics(article.topics);
  }
  
  // Приоритет 3: Темы (themes)
  if (!metadata && article.themes) {
    const topics = article.themes.map(t => t.name);
    metadata = parseMetadataFromTopics(topics);
  }
  
  return metadata || {};
}

/**
 * Извлекает сценарии маршрутизации из статьи конфигурации
 * 
 * Формат:
 * ```yaml scenario
 * name: "Проблемы с оборудованием"
 * triggers: [касса, терминал]
 * route: solver
 * ```
 */
function parseRoutingScenarios(markdown) {
  if (!markdown) {
    return [];
  }
  
  const scenarios = [];
  const scenarioRegex = /```yaml scenario\n([\s\S]*?)\n```/g;
  
  let match;
  while ((match = scenarioRegex.exec(markdown)) !== null) {
    const yamlContent = match[1];
    
    // Простой парсинг
    const scenario = {};
    const lines = yamlContent.split('\n');
    let currentKey = null;
    let currentArray = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      
      // Обработка массивов
      if (trimmed.startsWith('- ')) {
        currentArray.push(trimmed.substring(2).trim());
        continue;
      }
      
      // Если был массив, сохраняем его
      if (currentKey && currentArray.length > 0) {
        scenario[currentKey] = currentArray;
        currentArray = [];
        currentKey = null;
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
      
      // Если значение пустое, это начало массива
      if (!value || value === '[' || value === '') {
        currentKey = key;
        currentArray = [];
      } else {
        scenario[key] = value;
      }
    }
    
    // Сохранить последний массив
    if (currentKey && currentArray.length > 0) {
      scenario[currentKey] = currentArray;
    }
    
    if (Object.keys(scenario).length > 0) {
      scenarios.push(scenario);
    }
  }
  
  return scenarios;
}

module.exports = {
  parseMetadataFromMarkdown,
  parseMetadataFromTopics,
  parseArticleMetadata,
  parseRoutingScenarios
};
