# [CASH] Ошибка 148 при печати фискального чека

```json agent-policy
{
  "schema": "agent-policy/2-draft",
  "key": "cash_receipt_error_148",
  "bubble": "cash",
  "description": "Фискальный чек не закрывается с ошибкой 148 о длине реквизита",
  "rollout": {
    "testForm": "partner_answer",
    "production": "off"
  },
  "scope": {
    "businessDomains": ["dodopizza.ru"],
    "surfaces": ["restaurant_cashier", "delivery_cashier"],
    "requiresConfirmedUnitDomain": true
  },
  "match": {
    "all": ["проблема относится к кассе или фискальному чеку", "в тексте ошибки есть код 148 или фраза о неверной длине реквизита"],
    "excludes": ["ошибка без кода 148", "банковский терминал", "нефискальный принтер", "возврат или кассовое расхождение"]
  },
  "requiredFacts": [
    "unitFullName",
    "unitBusinessDomain=dodopizza.ru",
    "cashSurface",
    "exactErrorContains148"
  ],
  "questions": [
    {
      "key": "unitFullName",
      "whenMissing": true,
      "text": "Подскажите, пожалуйста, название и номер юнита, где возникла проблема."
    },
    {
      "key": "cashSurface",
      "whenMissing": true,
      "text": "Ошибка возникает на кассе ресторана или на кассе доставки?"
    },
    {
      "key": "exactErrorContains148",
      "whenMissing": true,
      "text": "Пришлите, пожалуйста, полный текст ошибки или фотографию экрана."
    }
  ],
  "classification": {
    "unit": "unitFullName",
    "componentBySurface": {
      "restaurant_cashier": "Касса → Касса ресторана → Печать чека",
      "delivery_cashier": "Касса → Касса доставки → Печать чека"
    }
  },
  "sources": [
    {
      "spaceId": "963b66c2-e111-43c6-a9ff-e7e5af3e4244",
      "articleId": "b12b10c3-9a4b-457b-bfdd-e2124f42ae3b",
      "title": "Не печатаются фискальные чеки, появляется ошибка",
      "verifiedUpdatedAt": "2025-08-12T06:41:24.535615",
      "requiredFragments": ["Ошибка 148", "ИНН кассира"],
      "audience": "partner"
    }
  ],
  "resolution": {
    "partnerAnswer": "Ошибка 148 возникает из-за некорректного ИНН у выбранного кассира. Чтобы закрыть текущий чек, выберите другого кассира. Затем управляющему нужно открыть карточку сотрудника в Додо ИС и исправить ИНН.",
    "checkQuestion": "Удалось закрыть чек после выбора другого кассира?",
    "onSuccess": "close_chat",
    "onFailure": "handover_to_operator"
  },
  "handover": {
    "external": "Понял, передаю обращение специалисту поддержки.",
    "internalOnlyOnHandover": ["problemSummary", "collectedFacts", "attemptedAdvice", "sourceLinks", "component", "handoverReason"]
  },
  "safety": {
    "stopIf": ["домен юнита не dodopizza.ru", "ошибка 148 не подтверждена", "после исправления ИНН ошибка сохраняется"],
    "forbidden": ["придумывать ИНН", "советовать менять настройки ККТ", "обещать исправление без проверки результата"]
  },
  "readiness": {
    "status": "needs_review",
    "blockers": ["подтвердить формулировку партнёрского ответа", "провести тесты во внешней переписке тестовой формы"]
  }
}
```

## Почему это отдельный сценарий

Код 148 однозначно связывает симптом с ИНН кассира. Общая фраза «чек не печатается» не
подходит: у неё много других причин. Поэтому этот совет разрешён только после получения
полного текста ошибки и подтверждения российского юнита.

## Ожидаемый внутренний черновик

> Юнит: …; касса: ресторан/доставка; ошибка: 148. Предлагаемый ответ партнёру: …
> Источник: «Не печатаются фискальные чеки, появляется ошибка» (`b12b10c3…`).
> Компонент: … После совета спросить, удалось ли закрыть чек.
