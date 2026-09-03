# [CASH] Смена превысила 24 часа

```json agent-policy
{
  "schema": "agent-policy/2-draft",
  "key": "cash_shift_over_24_hours",
  "bubble": "cash",
  "description": "Кассовая смена превысила 24 часа и её требуется закрыть через драйвер ККТ",
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
    "all": ["кассовая смена не закрыта", "явно сказано, что смена превысила 24 часа"],
    "excludes": ["смена уже закрыта", "не распечатался только Z-отчёт", "смена курьера", "смена сотрудника"]
  },
  "requiredFacts": [
    "unitFullName",
    "unitBusinessDomain=dodopizza.ru",
    "cashSurface",
    "cashShiftExceeded24h",
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
      "text": "Проблема на кассе ресторана или на кассе доставки?"
    },
    {
      "key": "cashShiftExceeded24h",
      "whenMissing": true,
      "text": "Какой точный текст ошибки появляется при закрытии кассовой смены?"
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
      "requiredFragments": ["Смена превысила 24 часа", "Отчёт о закрытии смены"],
      "audience": "partner"
    }
  ],
  "resolution": {
    "partnerAnswer": "Откройте «Тест драйвера ККТ», включите соединение с кассой и перейдите в раздел «Отчёты». Выберите «Отчёт о закрытии смены» и нажмите «Сформировать отчёт». Сохраните Z-отчёт и закройте драйвер. Если после этого ККМ не появилась в кассовом приложении, выберите «Вид» → «Обновить».",
    "checkQuestion": "Z-отчёт сформировался и касса снова позволяет работать с чеками?",
    "onSuccess": "close_chat",
    "onFailure": "handover_to_operator"
  },
  "handover": {
    "external": "Понял, передаю обращение специалисту поддержки.",
    "internalOnlyOnHandover": ["problemSummary", "collectedFacts", "attemptedAdvice", "sourceLinks", "component", "handoverReason"]
  },
  "safety": {
    "stopIf": ["домен юнита не dodopizza.ru", "нет программы Тест драйвера ККТ", "драйвер не соединяется с ККТ", "смена уже закрыта", "нужен удалённый доступ"],
    "forbidden": ["менять параметры подключения", "выбирать другую модель ККТ", "удалять файлы или драйверы", "повторно фискализировать документы"]
  },
  "readiness": {
    "status": "needs_review",
    "blockers": ["проверить инструкцию на тестовой кассе", "провести тесты во внешней переписке тестовой формы"]
  }
}
```

## Критическая граница

«Смена превысила 24 часа» и «смена уже закрыта, но Z-отчёт не вышел» — разные сценарии.
Печать копии последнего документа не должна предлагаться для незакрытой смены.
