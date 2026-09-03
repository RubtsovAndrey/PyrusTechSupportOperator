# Конфигурация тестового rollout

В документе БД Agent Platform `config` поле `forms` должно иметь следующий вид:

```json
{
  "forms": {
    "2430464": {
      "role": "chat",
      "environment": "test",
      "knowledgeExecution": "partner_answer"
    },
    "2454249": {
      "role": "ticket",
      "environment": "test",
      "knowledgeExecution": "handover_only"
    }
  }
}
```

Если в документе уже есть другие верхнеуровневые поля, сохраняйте их: заменяется только
`forms`. Любое отсутствующее или неизвестное значение `knowledgeExecution` код трактует
как `handover_only`. Поэтому продуктивная форма не сможет получить внешние ответы
случайно, даже если ей назначить роль `chat`.

В документ БД `knowledge_catalog` загружается содержимое
`docs/knowledge_catalog.json` из того же коммита, который деплоится на платформу.
