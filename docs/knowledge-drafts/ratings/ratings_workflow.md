# [RATINGS] Обработка вопросов по рейтингам

> Исторический согласовательный черновик. Он больше не является исполняемым источником.
> Актуальная policy хранится в `docs/knowledge/topics/ratings_questions.json`, из неё
> автоматически собираются каталог, RAG-документ и статья БЗ формата `agent-topic/1`.

```json agent-policy
{
  "schema": "agent-policy/2-draft",
  "key": "ratings_questions",
  "route": "ratings",
  "description": "Все вопросы о РКО и Рейтинге стандартов: правила, критерии, баллы, нарушения, апелляции и их статус",
  "scope": {
    "roles": ["chat"],
    "businessDomains": ["dodopizza.ru"],
    "partnerLanguages": ["ru"],
    "allowRfAssumptionBeforeUnit": true,
    "requireConfirmedUnitForPartnerAnswer": false,
    "requireConfirmedUnitForCloseOrSubtask": true
  },
  "match": {
    "include": [
      "рейтинг клиентского опыта",
      "РКО",
      "рейтинг стандартов",
      "РС в контексте рейтинга",
      "баллы или нарушение конкретного рейтинга",
      "апелляция конкретного рейтинга"
    ],
    "exclude": [
      "MD Audit",
      "личный рейтинг сотрудника",
      "личный рейтинг курьера",
      "рейтинг продаж",
      "отзыв или оценка клиента без связи с РКО"
    ]
  },
  "variantSelection": {
    "required": true,
    "maxClarifications": 1,
    "question": "Уточните, пожалуйста, вопрос относится к Рейтингу клиентского опыта (РКО) или к Рейтингу стандартов?",
    "onUnknown": "handover_to_operator",
    "doNotGuess": true
  },
  "variants": {
    "rko": {
      "title": "Рейтинг клиентского опыта",
      "signals": ["РКО", "рейтинг клиентского опыта", "рейтинг продукта"],
      "componentName": "Стандарты|Маркетинг → Контроллинг → Рейтинг клиентского опыта",
      "approvedSources": [
        {
          "spaceId": "2622c14a-ffac-4cb1-b3fa-ee41563c1b70",
          "articleId": "272d65f9-ca3b-4d54-a1ce-5a9fff4a04eb",
          "title": "Рейтинг клиентского опыта: принципы и правила",
          "reviewedUpdatedAt": "2026-05-22T09:01:53.619596"
        },
        {
          "spaceId": "2622c14a-ffac-4cb1-b3fa-ee41563c1b70",
          "articleId": "8e0617e4-bead-4be1-8796-12b18b214dc5",
          "title": "Правила подачи апелляций по рейтингу клиентского опыта",
          "reviewedUpdatedAt": "2025-09-23T09:58:49.752124"
        }
      ]
    },
    "rating_standards": {
      "title": "Рейтинг стандартов",
      "signals": ["рейтинг стандартов", "РС в контексте проверки или рейтинга"],
      "componentName": "Стандарты|Маркетинг → Контроллинг → Рейтинг стандартов",
      "approvedSources": [
        {
          "spaceId": "2622c14a-ffac-4cb1-b3fa-ee41563c1b70",
          "articleId": "4c1ae39a-6d5e-4235-809e-98d73ad95111",
          "title": "Рейтинг стандартов: принципы и правила",
          "reviewedUpdatedAt": "2026-07-31T09:57:21.038204"
        },
        {
          "spaceId": "2622c14a-ffac-4cb1-b3fa-ee41563c1b70",
          "articleId": "467785e9-2a21-4bb5-877b-857dbffafea7",
          "title": "Рейтинг стандартов: правила подачи апелляций",
          "reviewedUpdatedAt": "2025-07-18T13:22:53.126964"
        }
      ]
    }
  },
  "knowledge": {
    "searchTool": "search_content",
    "readByCanReadFully": {"true": "get_content", "false": "search_in_content"},
    "linkTool": "get_link_templates",
    "answerOnlyFromReadSources": true,
    "rejectUnapprovedArticleIds": true,
    "rejectWrongRegion": true,
    "answerSourceLimit": 1,
    "answerGuidance": "Отвечать только на непосредственный вопрос; не объяснять уже названные партнёром термины; для подачи апелляции оставить способ, срок и необходимость подтверждений; не более трёх коротких пунктов и 600 знаков; ссылку добавляет система.",
    "emptyOrUnavailable": "collect_for_subtask",
    "partnerWarning": "Материал подобран автоматически и может не учитывать особенности вашей ситуации.",
    "confirmationQuestion": "Эта информация помогла решить ваш вопрос?"
  },
  "subtask": {
    "formId": 2454249,
    "requiredFacts": ["unitFullName", "problemSummary", "expectedResult", "email"],
    "optionalFacts": ["ratingPeriod", "inspectionDate", "criterionOrViolation", "appealSubmitted", "appealDate", "appealStatus"],
    "maxClarificationsPerRequiredBlock": 2,
    "messageFieldRequired": true,
    "parentLinkRequired": true,
    "maxSubtasksPerParent": 1,
    "onFailure": "handover_to_operator"
  },
  "outcomes": {
    "knowledgeHelpedWithFields": "close_chat",
    "knowledgeHelpedWithoutFields": "silent_handover",
    "knowledgeDidNotHelp": "collect_for_subtask",
    "subtaskCreated": "close_chat",
    "requiredFactsMissing": "handover_to_operator"
  },
  "readiness": {
    "status": "approved_for_implementation",
    "approvedAt": "2026-09-03",
    "blockers": [
      "проверить поля и связь тестовой формы 2454249"
    ]
  }
}
```

## Правило содержания ответа

Статья задаёт только маршрут, ограничения и действия Pyrus. Фактический ответ партнёру
всегда строится из прочитанного актуального источника. Если найденный текст не отвечает на
конкретный вопрос, агент не дополняет его собственными знаниями и переходит к подзадаче.
