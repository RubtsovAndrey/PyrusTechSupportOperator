# Available Functions

This file lists all functions available in this project.
For detailed info about parameters and response, read the corresponding file.

## System Functions

- `Context.getAccountId` — Gets the account ID from the current request's bot ID
  Schema: .agent/system-functions/Context/getAccountId.json
- `Context.getProjectShortName` — Gets the project short name from the current request's bot ID
  Schema: .agent/system-functions/Context/getProjectShortName.json
- `Context.getChannelType` — Gets the channel type from the current request
  Schema: .agent/system-functions/Context/getChannelType.json
- `Context.getBotId` — Gets the bot ID from the current request
  Schema: .agent/system-functions/Context/getBotId.json
- `Context.isTestChannel` — Checks if the current channel is a test channel
  Schema: .agent/system-functions/Context/isTestChannel.json
- `Context.isAsyncChannel` — Checks if the current channel is asynchronous
  Schema: .agent/system-functions/Context/isAsyncChannel.json
- `Context.getRequestId` — Gets the question ID from the current request
  Schema: .agent/system-functions/Context/getRequestId.json
- `Context.getMessageContent` — Gets the content of the message from the current request
  Schema: .agent/system-functions/Context/getMessageContent.json
- `Context.getChatId` — Gets the chat ID from the current request
  Schema: .agent/system-functions/Context/getChatId.json
- `Context.getSessionId` — Gets the session ID from the current request
  Schema: .agent/system-functions/Context/getSessionId.json
- `Context.getClientInfo` — Gets the client information from the current request
  Schema: .agent/system-functions/Context/getClientInfo.json
- `Context.getRawRequest` — Gets the raw request data from the current request
  Schema: .agent/system-functions/Context/getRawRequest.json
- `Context.getLastFunctionResult` — Gets the result of the previously executed function
  Schema: .agent/system-functions/Context/getLastFunctionResult.json
- `Context.getChatHistory` — Retrieves the chat history for the current account
  Schema: .agent/system-functions/Context/getChatHistory.json
- `Context.getEmailContent` — Gets email content from the current request
  Schema: .agent/system-functions/Context/getEmailContent.json
- `Context.getLastStateError` — Gets the structured error of the previously failed node, routed via its error connector
  Schema: .agent/system-functions/Context/getLastStateError.json
- `Credentials.get` — Retrieves credential information by its key
  Schema: .agent/system-functions/Credentials/get.json
- `Db.get` — Finds a single document by documentKey in the specified database collection
  Schema: .agent/system-functions/Db/get.json
- `Db.findByFilters` — Finds documents with filtering and pagination options
  Schema: .agent/system-functions/Db/findByFilters.json
- `Db.countByFilters` — Counts documents matching the filter
  Schema: .agent/system-functions/Db/countByFilters.json
- `Db.put` — Saves a document by documentKey (upsert operation)
  Schema: .agent/system-functions/Db/put.json
- `Db.deleteByFilters` — Deletes multiple documents by filter
  Schema: .agent/system-functions/Db/deleteByFilters.json
- `Db.delete` — Deletes a document by documentKey
  Schema: .agent/system-functions/Db/delete.json
- `Db.updateByFilters` — Updates documents matching the filter
  Schema: .agent/system-functions/Db/updateByFilters.json
- `Email.send` — Sends an email using the specified SMTP integration
  Schema: .agent/system-functions/Email/send.json
- `Http.get` — Sends an HTTP GET request to the specified URL
  Schema: .agent/system-functions/Http/get.json
- `Http.post` — Sends an HTTP POST request to the specified URL
  Schema: .agent/system-functions/Http/post.json
- `Http.put` — Sends an HTTP PUT request to the specified URL
  Schema: .agent/system-functions/Http/put.json
- `Http.delete` — Sends an HTTP DELETE request to the specified URL
  Schema: .agent/system-functions/Http/delete.json
- `Http.patch` — Sends an HTTP PATCH request to the specified URL
  Schema: .agent/system-functions/Http/patch.json
- `Http.send` — Send an HTTP request with the specified method and parameters
  Schema: .agent/system-functions/Http/send.json
- `Llm.sendRequest` — Sends a request to an LLM model
  Schema: .agent/system-functions/Llm/sendRequest.json
- `Llm.sendText` — Sends a simple text message to the LLM and returns the response content
  Schema: .agent/system-functions/Llm/sendText.json
- `Llm.getChatHistory` — Retrieves the chat history in LLM-compatible format
  Schema: .agent/system-functions/Llm/getChatHistory.json
- `Llm.summarizeText` — Summarizes long text to a specified size while preserving key information.
  Schema: .agent/system-functions/Llm/summarizeText.json
- `Rag.retrieveChunks` — Retrieves relevant chunks from a RAG integration based on a query
  Schema: .agent/system-functions/Rag/retrieveChunks.json
- `Rag.generateAnswer` — Generates an answer using a RAG integration based on a query
  Schema: .agent/system-functions/Rag/generateAnswer.json
- `Reactions.sendText` — Sends a text message as a response
  Schema: .agent/system-functions/Reactions/sendText.json
- `Reactions.sendHtml` — Sends a message with HTML formatting
  Schema: .agent/system-functions/Reactions/sendHtml.json
- `Reactions.sendAudio` — Sends an audio file as a response
  Schema: .agent/system-functions/Reactions/sendAudio.json
- `Reactions.sendImage` — Sends an image as a response
  Schema: .agent/system-functions/Reactions/sendImage.json
- `Reactions.sendVideo` — Sends a video as a response
  Schema: .agent/system-functions/Reactions/sendVideo.json
- `Reactions.sendFile` — Sends a file as a response
  Schema: .agent/system-functions/Reactions/sendFile.json
- `Reactions.sendLocation` — Sends a geographic location as a response
  Schema: .agent/system-functions/Reactions/sendLocation.json
- `Reactions.sendRawRequest` — Sends a raw request as a response for advanced use cases
  Schema: .agent/system-functions/Reactions/sendRawRequest.json
- `Telegram.sendVoice` — Sends a voice message to a Telegram chat
  Schema: .agent/system-functions/Telegram/sendVoice.json
- `Telegram.sendText` — Sends a text message to a Telegram chat
  Schema: .agent/system-functions/Telegram/sendText.json
- `Telegram.sendAudio` — Sends an audio file to a Telegram chat
  Schema: .agent/system-functions/Telegram/sendAudio.json
- `Telegram.sendImage` — Sends an image by URL to a Telegram chat
  Schema: .agent/system-functions/Telegram/sendImage.json
- `Telegram.sendButtons` — Sends a message with inline keyboard buttons to a Telegram chat
  Schema: .agent/system-functions/Telegram/sendButtons.json
- `SessionDb.get` — Finds a single document by documentKey
  Schema: .agent/system-functions/SessionDb/get.json
- `SessionDb.findByFilters` — Finds documents with filtering and pagination options
  Schema: .agent/system-functions/SessionDb/findByFilters.json
- `SessionDb.countByFilters` — Counts documents matching the filter
  Schema: .agent/system-functions/SessionDb/countByFilters.json
- `SessionDb.put` — Saves a document by documentKey (upsert operation)
  Schema: .agent/system-functions/SessionDb/put.json
- `SessionDb.delete` — Deletes a document by documentKey
  Schema: .agent/system-functions/SessionDb/delete.json
- `SessionDb.deleteByFilters` — Deletes multiple documents by filter
  Schema: .agent/system-functions/SessionDb/deleteByFilters.json
- `SessionDb.updateByFilters` — Updates documents matching the filter
  Schema: .agent/system-functions/SessionDb/updateByFilters.json
- `Asr.recognize` — Recognizes audio content using the specified ASR integration
  Schema: .agent/system-functions/Asr/recognize.json
- `Tts.synthesize` — Converts text to speech using the specified TTS integration and returns an audio URL
  Schema: .agent/system-functions/Tts/synthesize.json
- `ProjectRouter.callProject` — Calls external project by chat api token and optional custom data
  Schema: .agent/system-functions/ProjectRouter/callProject.json
- `ProjectRouter.switchTo` — Switches the conversation context to another project.
  Schema: .agent/system-functions/ProjectRouter/switchTo.json
- `ProjectRouter.backToOriginalProject` — Returns the conversation context back to the original project
  Schema: .agent/system-functions/ProjectRouter/backToOriginalProject.json
- `ProjectRouter.getCustomData` — Gets the custom data that was passed during the last context switch to this bot
  Schema: .agent/system-functions/ProjectRouter/getCustomData.json
- `AgentContext.addNote` — Adds a text fragment to the context. Empty strings are ignored.
  Schema: .agent/system-functions/AgentContext/addNote.json
- `AgentContext.getNotes` — Returns concatenated text (by time of addition)
  Schema: .agent/system-functions/AgentContext/getNotes.json
- `AgentContext.deleteNotes` — Deletes all stored text notes
  Schema: .agent/system-functions/AgentContext/deleteNotes.json
- `AgentContext.putValue` — Stores a key-value pair in the context. Used to store objects different from text.
  Schema: .agent/system-functions/AgentContext/putValue.json
- `AgentContext.getValue` — Retrieves a previously stored value
  Schema: .agent/system-functions/AgentContext/getValue.json
- `AgentContext.deleteValue` — Deletes a previously stored value
  Schema: .agent/system-functions/AgentContext/deleteValue.json
- `AgentContext.clearContext` — Clears the entire context (both text and KV)
  Schema: .agent/system-functions/AgentContext/clearContext.json
- `Dialer.getCaller` — Returns the phone number of the client. Returns null if rawRequest is not available
  Schema: .agent/system-functions/Dialer/getCaller.json
- `Dialer.hangUp` — Terminates the current call. On telephony channels sends a hangup reply, on other channels sends an optional text message
  Schema: .agent/system-functions/Dialer/hangUp.json
- `Dialer.isIncomingCall` — Checks whether the current call is incoming or outgoing. A call is incoming if there is no outgoing call ID
  Schema: .agent/system-functions/Dialer/isIncomingCall.json
- `Dialer.setNoInputTimeout` — Changes the timeout for waiting for a response from the client. Value is clamped to [100, 20000] ms
  Schema: .agent/system-functions/Dialer/setNoInputTimeout.json
- `Dialer.getAbonentTimezone` — Returns the timezone offset of the client as a formatted string (e.g. '+03:00:00'). Returns null if not available
  Schema: .agent/system-functions/Dialer/getAbonentTimezone.json
- `Dialer.getCallNotConnectedReason` — Returns the reason why an outgoing call was not connected. Returns null if not available
  Schema: .agent/system-functions/Dialer/getCallNotConnectedReason.json
- `Dialer.getCampaignSchedule` — Returns the schedule of the dialing campaign. Returns null if not available
  Schema: .agent/system-functions/Dialer/getCampaignSchedule.json
- `Dialer.getDialHistory` — Returns the history of completed and available dial attempts for the current number. Returns null if not available
  Schema: .agent/system-functions/Dialer/getDialHistory.json
- `Dialer.getPayload` — Returns the payload data associated with the dialed number. Returns an empty object if not available
  Schema: .agent/system-functions/Dialer/getPayload.json
- `Dialer.getRetryIntervals` — Returns the durations of pauses between dial retry attempts. Returns null if not available
  Schema: .agent/system-functions/Dialer/getRetryIntervals.json
- `Dialer.getRKCallID` — Returns the identifier of the outgoing call. Returns null if not on a resterisk channel
  Schema: .agent/system-functions/Dialer/getRKCallID.json
- `Dialer.getSipHeaders` — Returns the SIP headers from the current request. Returns an empty object if not available
  Schema: .agent/system-functions/Dialer/getSipHeaders.json
- `Dialer.redial` — Schedules a new series of retry attempts to dial the number. Requires startDateTime or localTimeFrom at least
  Schema: .agent/system-functions/Dialer/redial.json
- `Dialer.transferCall` — Transfers the active phone call to another phone number. The transfer result can be retrieved using getTransferStatus after the transfer completes.
  Schema: .agent/system-functions/Dialer/transferCall.json
- `Dialer.getTransferStatus` — Gets the result of the last call transfer. Returns SUCCESS, FAIL, TIMEOUT, or NOT_AVAILABLE if no transfer has been made yet.
  Schema: .agent/system-functions/Dialer/getTransferStatus.json
- `Log.info` — Logs an informational message
  Schema: .agent/system-functions/Log/info.json
- `Log.debug` — Logs a debug message
  Schema: .agent/system-functions/Log/debug.json
- `Log.trace` — Logs a trace message
  Schema: .agent/system-functions/Log/trace.json
- `Log.warn` — Logs a warning message
  Schema: .agent/system-functions/Log/warn.json
- `Log.error` — Logs an error message
  Schema: .agent/system-functions/Log/error.json

## MCP Functions

- `knowledgebase.get_link_templates` — Шаблоны ссылок на веб-приложение Базы Знаний: на главную, на пространство и на статью, уже с правильным доменом текущего MCP-подключения. Те же шаблоны сервер присылает в instructions при подключении, поэтому вызывайте этот инструмент, когда их нет под рукой (клиент мог не передать instructions, или они вытеснились из контекста). Любую ссылку на Базу Знаний стройте только по этим шаблонам, подставляя spaceId/articleId из ответов остальных инструментов, и никогда по памяти. Инструмент дешёвый: не обращается к БД, не зависит от прав и не требует аргументов.
  Schema: .agent/mcp-functions/knowledgebase/get_link_templates.json
- `knowledgebase.get_announcements` — Лента объявлений (анонсов, новостей) Базы Знаний — используйте этот инструмент, в частности, для запросов пользователя про «новости». Последние опубликованные статьи по всем доступным пользователю пространствам, отсортированные по дате публикации (сначала новые), постранично. Каждый элемент уже содержит заголовок, excerpt, пространство, авторов и флаг вотермарок (если IsWatermarksEnabled: true, excerpt — служебная пометка, а не текст статьи) — используйте эти поля напрямую, не вызывая get_content, если не нужен полный текст статьи. Чтобы дать пользователю ссылку на объявление, возьмите шаблон из get_link_templates и подставьте SpaceId и ArticleId — сами ссылку не придумывайте.
  Schema: .agent/mcp-functions/knowledgebase/get_announcements.json
- `knowledgebase.get_space_content` — Оглавление пространства: статьи с id, заголовками, статусами, темами, языком, авторами и датами создания/обновления. Постранично. Этих полей обычно достаточно, чтобы отфильтровать или найти нужные статьи (например, по автору или языку) без вызова get_content для каждой — вызывайте get_content только для той статьи, чьё содержимое реально нужно, чтобы не тратить лишние запросы. Чтобы сузить оглавление по темам, передайте themes — список id тем (id берите из поля Themes этого же ответа); вернутся только статьи, у которых есть хотя бы одна из указанных тем. Сначала вызовите get_spaces, чтобы получить корректный spaceId. Ссылки на пространство и на его статьи стройте только по шаблонам из get_link_templates.
  Schema: .agent/mcp-functions/knowledgebase/get_space_content.json
- `knowledgebase.get_content` — Статья по id: Markdown-содержимое с полными метаданными — статус, язык, даты создания/публикации/обновления, права доступа, fidelity конвертации, пространство, авторы, темы, переводы на другие языки, флаги вотермарок/комментариев/тёмного режима. Используйте search_content или get_space_content, чтобы сначала найти id статьи — они уже возвращают часть тех же метаданных (авторы, язык, темы), поэтому вызывайте get_content только когда нужен сам текст статьи или поля, которых там нет (переводы, fidelity, права доступа). Это основной способ прочитать статью: Markdown сохраняет структуру — заголовки, списки, таблицы, ссылки. Перед чтением незнакомой статьи посмотрите CanReadFully в результатах поиска: при true читайте её здесь, при false — берите нужное место через search_in_content. Если IsWatermarksEnabled: true, поле Content содержит не текст статьи, а служебное сообщение со ссылкой для пользователя — это ожидаемое поведение, а не ошибка. Чтобы дать пользователю ссылку на статью, возьмите шаблон из get_link_templates и подставьте Space.Id и Id — сами ссылку не придумывайте.
  Schema: .agent/mcp-functions/knowledgebase/get_content.json
- `knowledgebase.preview_content` — Dry-run конвертации Markdown во внутренний формат Базы Знаний: ничего не сохраняет, возвращает предупреждения о деградации. Вызывайте перед create_content/update_content для нетривиального Markdown.
  Schema: .agent/mcp-functions/knowledgebase/preview_content.json
- `knowledgebase.get_spaces` — Список пространств Базы Знаний, доступных пользователю: id, название, описание, тип (corporate/partner), права (reader/writer), количество статей и языки контента. Вызывайте первым, чтобы получить корректные spaceId для остальных инструментов — этих полей обычно достаточно, чтобы выбрать нужное пространство по названию/языку/размеру, не открывая каждое через get_space_content. Право writer здесь не гарантирует, что запись через MCP разрешена прямо сейчас — это дополнительно зависит от того, настроено ли текущее MCP-подключение в режиме записи (см. create_content).
  Schema: .agent/mcp-functions/knowledgebase/get_spaces.json
- `knowledgebase.search_content` — Полнотекстовый поиск по статьям Базы Знаний, доступным пользователю, опционально в конкретных пространствах (id из get_spaces). Каждый результат уже содержит не только excerpt, но и язык, статус, дату обновления, пространство, авторов, темы и флаг вотермарок — для большинства задач фильтрации/поиска отдельный вызов get_content не требуется. Если excerpt найденной статьи не содержит нужного ответа, выберите способ чтения по CanReadFully этого же результата: get_content при true, search_in_content при false. Если IsWatermarksEnabled: true, excerpt — это служебная пометка, а не реальный текст статьи. Чтобы дать пользователю ссылку на найденную статью, возьмите шаблон из get_link_templates и подставьте SpaceId и ArticleId из результата — сами ссылку не придумывайте.
  Schema: .agent/mcp-functions/knowledgebase/search_content.json
- `knowledgebase.current_user` — Получить идентификационные данные (идентификатор, имя, адрес электронной почты) пользователя, которому принадлежит текущий токен MCP. Используйте их, чтобы достоверно определить, являетесь ли вы автором статьи, вместо того чтобы гадать по имени или дате.
  Schema: .agent/mcp-functions/knowledgebase/current_user.json
- `knowledgebase.search_in_content` — Поиск фрагмента ВНУТРИ одной статьи: возвращает только релевантный отрывок, а не всю статью. Нужен для статей, которые не стоит читать целиком: search_content вернул по ним CanReadFully: false. Для статьи с CanReadFully: true предпочитайте get_content — здесь отрывок приходит без Markdown-разметки, то есть без структуры заголовков, списков и таблиц. Передайте id статьи и то, что ищете внутри неё. found: false означает, что релевантного фрагмента в статье нет. truncated: true — отрывок обрезан серверным лимитом, продолжение есть только в самой статье. Пустой ответ (found: false, excerpt и articleTitle: null) не говорит, почему фрагмента нет: так же отвечают недоступная, несуществующая и закрытая вотермарками статья — по такому ответу судить о существовании статьи и о её содержимом нельзя.
  Schema: .agent/mcp-functions/knowledgebase/search_in_content.json

## User Functions

- `ID_Pyrus.receiveWebhook` — Validates the Pyrus webhook payload (task_id, allowlisted api_url, token), drops the bot's own comments and comments already answered, stores the request-scoped Pyrus data in the task document, rebuilds the dialog history and resolves the stage to enter.
  Directory: functions/ID_Pyrus/receiveWebhook/
- `ID_Pyrus.finalize` — Terminal node for every path. Applies the pending outcome of the task document: aborts if a newer message has arrived, posts the comment to Pyrus and only then persists the new stage. Falls back to an operator handover if no outcome was set.
  Directory: functions/ID_Pyrus/finalize/
- `ID_Actions.createSubtask` — Creates a Pyrus subtask from the facts stored in the task document (unit, component, email) and posts a summary comment to it. Idempotent: the task document catches retries and the form register is asked before creating, so two concurrent runs cannot produce two subtasks for the same problem.
  Directory: functions/ID_Actions/createSubtask/
- `ID_Actions.applyOutcome` — Records the decision of the current turn (reply text, Pyrus action, field updates, next stage) into the task document. Single place where dialog transitions are defined; finalize only performs the I/O.
  Directory: functions/ID_Actions/applyOutcome/
- `ID_Tools.matchUnit` — Находит юнит партнёра в каталоге. Вызывай всегда, когда партнёр назвал город, номер точки или бренд. Инструмент решает сам и возвращает точную строку каталога только тогда, когда ответ однозначен: одно и то же название бывает и у пиццерии, и у кофейни, и тогда он просит уточнить, а не угадывает.
  Directory: functions/ID_Tools/matchUnit/
- `ID_Tools.searchKnowledge` — Ищет в базе знаний тематику, подходящую под описание проблемы. Если ничего не подходит, возвращает found=false без кандидатов и никогда не угадывает. Когда тематика уже известна, передавай topicKey. Защищённый activeQuestionId обрабатывает отдельный Turn Interpreter; Solver не должен угадывать его значение.
  Directory: functions/ID_Tools/searchKnowledge/
- `ID_Tools.parseAgentJson` — Parses the JSON answer of an agent, validates the unit, the topic and the component against the catalogs, persists the collected facts into the task document and clears the previous problem when the partner moves on to a new question. Throws when the answer is not parseable, so the node error edge can hand the task to an operator.
  Directory: functions/ID_Tools/parseAgentJson/
- `ID_Tools.nextSolutionStep` — Decides what to do after the partner reports that a solution did not help: offer the next step of the knowledge article, or leave the topic through its onFail route. Not a tool — called by the graph after the confirmation stage.
  Directory: functions/ID_Tools/nextSolutionStep/
- `ID_Tools.getKnowledgeMcp` — Ищет статьи в Базе Знаний через MCP и возвращает их содержимое с метаданными. Используй для поиска решений проблем партнёров.
  Directory: functions/ID_Tools/getKnowledgeMcp/
- `ID_Tools.findOperatorKnowledge` — Ищет по всей доступной Базе Знаний возможные материалы для оператора, когда утверждённый сценарий бота не найден. Ничего не отправляет партнёру.
  Directory: functions/ID_Tools/findOperatorKnowledge/
- `ID_Tools.parseTurnInterpretation` — Проверяет общий конечный контракт Turn Interpreter для ответа статье, реакции на совет или сообщения после закрытия. Не является tool агента и не выполняет бизнес-действий.
  Directory: functions/ID_Tools/parseTurnInterpretation/
- `ID_Tools.parseResponseComposition` — Проверяет привязку ответа Response Composer к авторизованному responsePlan. Не позволяет менять kind или действие; при повреждённом ответе использует безопасный текст плана.
  Directory: functions/ID_Tools/parseResponseComposition/

