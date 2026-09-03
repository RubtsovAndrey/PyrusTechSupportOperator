# [CASH] Смена закрыта, но Z-отчёт не напечатан

```json agent-policy
{
  "schema": "agent-policy/2-draft",
  "key": "cash_shift_closed_z_report_missing",
  "bubble": "cash",
  "description": "Смена в Додо ИС закрыта, но бумажный Z-отчёт не распечатался",
  "rollout": {
    "testForm": "partner_answer",
    "production": "off"
  },
  "scope": {
    "businessDomains": ["dodopizza.ru"],
    "surfaces": ["restaurant_cashier", "delivery_cashier"],
    "requiresConfirmedUnitDomain": true,
    "supportedSetup": "Windows, доступен Тест драйвера ККТ"
  },
  "match": {
    "all": ["партнёр явно подтвердил, что смена в Додо ИС закрыта", "не распечатался только Z-отчёт"],
    "excludes": ["закрытие смены не завершилось", "неизвестно, закрыта ли смена", "после Z-отчёта печатались другие фискальные документы"]
  },
  "requiredFacts": [
    "unitFullName",
    "unitBusinessDomain=dodopizza.ru",
    "cashSurface",
    "shiftClosedInDodo=true",
    "onlyZReportMissing=true",
    "noLaterFiscalDocuments=true",
    "kktDriverAvailable"
  ],
  "questions": [
    {
      "key": "unitFullName",
      "whenMissing": true,
      "text": "Подскажите, пожалуйста, название и номер юнита."
    },
    {
      "key": "cashSurface",
      "whenMissing": true,
      "text": "Это касса ресторана или касса доставки?"
    },
    {
      "key": "shiftClosedInDodo",
      "whenMissing": true,
      "text": "Смена в Додо ИС точно отображается закрытой, а не распечатался только Z-отчёт?"
    },
    {
      "key": "noLaterFiscalDocuments",
      "whenMissing": true,
      "text": "После попытки закрытия смены касса печатала другие фискальные документы?"
    },
    {
      "key": "kktDriverAvailable",
      "whenMissing": true,
      "text": "На кассе открывается программа «Тест драйвера ККТ»?"
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
      "articleId": "11e4e561-5611-4be8-9b3e-b04d35180615",
      "title": "Касса: устранение ошибок",
      "verifiedUpdatedAt": "2025-08-12T06:36:12.478557",
      "requiredFragments": ["Z-отчёт не распечатался", "Печать последнего документа"],
      "audience": "partner"
    },
    {
      "spaceId": "963b66c2-e111-43c6-a9ff-e7e5af3e4244",
      "articleId": "7e16506e-fc6b-46e3-af34-0c00841f8c24",
      "title": "Касса ресторана: устранение проблем",
      "verifiedUpdatedAt": "2024-10-28T11:14:06",
      "requiredFragments": ["Z-отчёт", "последнего документа"],
      "audience": "partner",
      "whenSurface": "restaurant_cashier"
    },
    {
      "spaceId": "963b66c2-e111-43c6-a9ff-e7e5af3e4244",
      "articleId": "37f22812-d1b6-4ee1-aa36-35b469e5c7d9",
      "title": "Касса доставки: устранение проблем",
      "verifiedUpdatedAt": "2026-05-06T15:57:33.965581",
      "requiredFragments": ["Z-отчёт", "последнего документа"],
      "audience": "partner",
      "whenSurface": "delivery_cashier"
    }
  ],
  "resolution": {
    "partnerAnswer": "Если смена уже закрыта и после неё не печатались другие фискальные документы, откройте «Тест драйвера ККТ» и выполните печать копии последнего документа.",
    "checkQuestion": "Копия Z-отчёта распечаталась?",
    "onSuccess": "close_chat",
    "onFailure": "handover_to_operator"
  },
  "handover": {
    "external": "Понял, передаю обращение специалисту поддержки.",
    "internalOnlyOnHandover": ["problemSummary", "collectedFacts", "attemptedAdvice", "sourceLinks", "component", "handoverReason"]
  },
  "safety": {
    "stopIf": ["домен юнита не dodopizza.ru", "смена не подтверждена как закрытая", "после закрытия печатались другие документы", "нет программы Тест драйвера ККТ", "непонятно, какой документ является последним"],
    "forbidden": ["называть последний документ Z-отчётом без проверки", "повторно закрывать уже закрытую смену", "менять настройки ККТ"]
  },
  "readiness": {
    "status": "needs_review",
    "blockers": ["проверить безопасную формулировку про последний документ", "провести тесты во внешней переписке тестовой формы"]
  }
}
```

## Почему нужны два подтверждения

Фраза «Z-отчёт не вышел» не доказывает, что смена закрылась. Кроме того, команда печати
копирует последний фискальный документ: если после закрытия уже что-то печатали, это может
оказаться не Z-отчёт. В обоих неоднозначных случаях нужен оператор.
