# Карта проекта

Живой документ: что уже сделано, что настраивается вне репозитория и что ещё предстоит.
Лежит в `.agent/`, потому что платформа читает как ресурсы проекта только `manifest.yml`,
`settings.yml`, `nodes/`, `functions/`, `integrations/` и `credentials/` — файл здесь не
попадает в заливку и не может её сломать.

Обновлять при каждом изменении графа, функций или схем данных в БД.

## Состояние

### Готово

- **Изоляция чатов.** Всё состояние диалога живёт в документе `state:<taskId>`, сессионный
  `AgentContext` полностью очищается в начале каждого вебхука. Параллельные чаты не
  пересекаются.
- **Идемпотентность.** Лок `lock:<taskId>` с уникальным токеном: повторный вебхук не
  создаёт второй ответ, а `finalize` снимает только свой лок. Дубль подзадачи невозможен —
  `subtaskId` пишется в документ задачи.
- **Дебаунс.** Если партнёр написал ещё раз, пока шёл прогон, ответ старого прогона не
  отправляется: `finalize` сверяет последний входящий комментарий с обработанным.
- **Безопасность.** Токен Pyrus и `api_url` не попадают в промпт; хост `api_url`
  проверяется по белому списку.
- **Приветствие.** Решается кодом по факту наличия ответов бота в треде, а не моделью:
  добавляется в первом ответе и срезается в последующих.
- **Сбор данных.** Нужны только юнит и суть проблемы. Тексты рутинных уточняющих вопросов
  зашиты в `applyOutcome`, агент выбирает лишь `clarifyKind`.
- **Запросы от сети.** `matchUnit` с `scope: "network"` берёт первую точку сети, номер
  точки у партнёра не запрашивается.
- **Пошаговая БЗ.** Статья — упорядоченный список решений; за виток выдаётся одно.
  `preQuestions` задаются до решения, `onFail` определяет выход после последнего шага.
- **Саммари оператору.** Перед каждой эскалацией во внутреннюю переписку уходит комментарий
  без `channel`: кто обращается, суть, тематика, что уже пробовали, причина передачи.
- **Подзадачи.** Поля исходного чата и подзадачи заполняются, в подзадачу уходит внутренний
  комментарий и `action: "finished"` — этап переводится, исходный чат закрывается.
- **Переоткрытые чаты.** Молча уходят оператору, без сообщений партнёру.

### Настраивается вне репозитория

| Что | Где | Кто заполняет |
|-----|-----|---------------|
| `unitCatalog` | документ БД | вручную, раз в неделю |
| `knowledge_catalog` | документ БД | вручную, схема — в README |
| `config` (id формы подзадачи и полей) | документ БД | вручную, есть значения по умолчанию |
| `project-key`, `origin-key` интеграций, url вебхука | файлы репозитория | при первом деплое |

### Не сделано

- Нет автотестов: граф проверяется только прогонами в Pyrus. Есть проверки синтаксиса
  (`node --check`, парсинг YAML) и обход графа на битые ссылки.
- `unitCatalog` не синхронизируется автоматически.
- `route: "escalate"` в статье БЗ не отличается от отсутствия статьи — оба ведут к оператору.

## Карта графа

```
trigger_webhook_pyrus → receiveWebhook → skip?
  skip=true                         → finalize
  reopened after close?  reopened   → Outcome - silent handover → finalize
  confirmation?  awaiting_confirmation → agent_confirmation → parseConfirmation
    │                                     resolved      → Outcome - solved → finalize
    │                                     more_questions → agent_intake
    │                                     иначе          → next solution step?
    │                                        next=solver  → agent_solver
    │                                        next=subtask → createSubtask
    │                                        иначе        → Outcome - escalate
    └ иначе → agent_intake → parseIntake
        action=escalate → Outcome - escalate → finalize
        action=clarify  → Outcome - clarify  → finalize
        action=route    → agent_routing → parseRouting
          route=solver  → agent_solver → parseSolver → solver asked questions?
                             kind=questions → Outcome - clarify
                             иначе          → Outcome - reply
          route=subtask → createSubtask → subtask created?
                             success → Outcome - subtask created
                             иначе   → subtask needs email? → Outcome - clarify | escalate
          иначе         → Outcome - escalate
```

Все узлы `Outcome - *` — это одна функция `applyOutcome` с разным параметром `outcome`.
Единственный терминальный узел — `finalize`.

## Функции

| Функция | Коллекция | Роль |
|---------|-----------|------|
| `receiveWebhook` | ID_Pyrus | разбор вебхука, лок, стадия, заметки для промпта |
| `finalize` | ID_Pyrus | единственная точка записи в Pyrus и снятия лока |
| `applyOutcome` | ID_Actions | таблица исходов витка: текст, этап, поля, саммари |
| `createSubtask` | ID_Actions | создание подзадачи и перевод её этапа |
| `matchUnit` | ID_Tools | tool: поиск юнита в каталоге, режимы unit и network |
| `searchKnowledge` | ID_Tools | tool: подбор тематики и выдача одного шага решения |
| `parseAgentJson` | ID_Tools | разбор ответа агента, запись фактов и попыток |
| `nextSolutionStep` | ID_Tools | решение после «не помогло»: следующий шаг или onFail |

## Документ задачи `state:<taskId>`

```
stage            gathering | awaiting_confirmation | closed | escalated
data.unitFullName, componentName, problemSummary, email, topicKey
data.attempts    [{ topicKey, step, at, advice }] — что уже предлагали
runtime          apiUrl, token, outboundChannel, lastInboundCommentId, formId,
                 unitFieldId, componentFieldId, isFirstBotReply, partnerName
pendingOutcome   решение витка, потребляется finalize
subtaskId        защита от повторного создания подзадачи
```

Стадия `reopened` не хранится: она выводится из `stage = closed` плюс новое сообщение.

## Соглашения

- **Текст партнёру формируется в коде, а не моделью**, всюду, где он предсказуем:
  уточняющие вопросы, приветствие, стандартные ответы. Модель отвечает свободным текстом
  только там, где содержание действительно зависит от статьи БЗ.
- **Разделение этапов жёсткое.** У `agent_intake` нет доступа к БЗ, у `agent_solver` — к
  каталогу юнитов. Один агент не может выполнить работу другого даже при желании.
- **В Pyrus пишет только `finalize`** (единственное исключение — `createSubtask`, который
  создаёт саму подзадачу).
- **Комментарий без `channel` — внутренняя переписка.** Так уходят все саммари оператору.
- **Факты пишутся в документ задачи через `parseAgentJson`**, список `PERSISTED`.
