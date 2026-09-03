// Tests for ID_Pyrus.receiveWebhook — the guard that decides whether the bot may speak
// at all, and which stage the graph enters. Every case here is a defect that reached a
// real partner or would have.
const { loadFunction, makeEnv, suite } = require("./harness");

const receiveWebhook = loadFunction("functions/ID_Pyrus/receiveWebhook/code.js");

const BOT = { id: 1314929, name: "Бот" };
const PARTNER = { id: 555, name: "Партнёр", email: "p@x.ru" };
const OPERATOR = { id: 777, name: "Оператор" };
const CHAN = { type: "email", direction: "inbound", from: "p@x.ru" };
const KEY = "state:11613";

function payload(comments, overrides) {
  return Object.assign({
    task_id: 11613,
    event: "comment",
    access_token: "t",
    api_url: "https://api.pyrus.com/v4/",
    task: { id: 11613, form_id: 77, fields: [], comments: comments }
  }, overrides || {});
}

async function run(comments, db, overrides) {
  const env = makeEnv({ payload: payload(comments, overrides), db: db });
  const result = await receiveWebhook(env);
  return {
    result, state: env.db[KEY], notes: env.notes, values: env.values,
    updates: env.updates, puts: env.puts
  };
}

const setPaths = update => Object.keys((update && update.operator && update.operator.$set) || {}).sort();

async function main() {
  const t = suite("receiveWebhook");

  // ── Payload validation: the token must never leave for a foreign host ──
  let r = await run([{ id: 1, author: PARTNER, text: "привет", channel: CHAN }], {},
    { api_url: "https://evil.example.com/v4/" });
  t.check("forged api_url host is rejected", r.result.skip === true && /not allowed/.test(r.result.reason), r.result);
  t.check("nothing written for a rejected payload", r.state === undefined, r.state);

  r = await run([{ id: 1, author: PARTNER, text: "привет", channel: CHAN }], {}, { access_token: null });
  t.check("payload without token is rejected", r.result.skip === true, r.result);

  r = await run([{ id: 1, author: PARTNER, text: "привет", channel: CHAN }], {}, { event: "task_created" });
  t.check("non-comment event is skipped", r.result.skip === true, r.result);

  // ── The recursion breaker ──
  // Pyrus fires a webhook for the bot's own comment too. Without this the bot answers
  // itself and dumps a whole article into the chat in seconds.
  r = await run([
    { id: 1, author: PARTNER, text: "Не печатает чек", channel: CHAN },
    { id: 2, author: BOT, text: "Добрый день! Что именно не работает?" }
  ], {});
  t.check("bot's own comment is skipped", r.result.skip === true && /own/.test(r.result.reason), r.result);

  // ── A foreign bot is not us ──
  // There used to be a fallback here: any author whose email began with `bot@` counted as
  // ours, «for service accounts whose id we have not been told about». In this Pyrus
  // organisation EVERY bot has an email of that shape, so the fallback claimed
  // `bot techSupport Supervisor`, `bot techSupport Approver` and the bots of other projects.
  // The live log shows what it cost: a turn dropped as «last comment is the bot's own» when
  // the Supervisor bot had written it, and that bot's messages labelled «Ассистент» in the
  // history — the model was told it had said things it never said.
  r = await run([
    { id: 8, author: PARTNER, text: "Не печатает чек", channel: CHAN },
    { id: 9, author: { id: 693964, type: "bot", email: "bot@c8163714-uuid" }, text: "При обработке запроса произошла ошибка" }
  ], {});
  t.check("a foreign bot@ account is not taken for our own",
    !/own/.test(String(r.result.reason)), r.result);
  // …but its message is internal, so it does not start a turn either. Both halves matter:
  // without the second the bot would have begun answering another bot's error messages.
  t.check("and its internal message does not start a turn",
    r.result.skip === true && /internal/.test(r.result.reason), r.result);

  r = await run([{ id: 9, author: { id: 4242, type: "bot", email: "real@person.ru" }, text: "..." }], {});
  t.check("author.type is not trusted: a real person is not a bot", r.result.skip === false, r.result);

  // The very first comment of a task is the body Pyrus reports without a channel, and it is
  // always the partner's — the same exception `speaker()` makes, for the same reason.
  r = await run([{ id: 10, author: PARTNER, text: "Здравствуйте, не печатает чек" }], {});
  t.check("the opening message is answered even without a channel", r.result.skip === false, r.result);

  // An internal comment in an ongoing thread is not.
  r = await run([
    { id: 10, author: PARTNER, text: "Не печатает чек", channel: CHAN },
    { id: 11, author: OPERATOR, text: "смотрю" }
  ], {});
  t.check("an operator's note in an ongoing thread does not start a turn",
    r.result.skip === true && /internal/.test(r.result.reason), r.result);

  // The id of the service account is configuration, not a literal: a migration or a
  // recreated integration changes it, and a stale value means the bot answering itself in
  // a loop. It used to be hardcoded in two files, which is how the two would disagree.
  r = await run([{ id: 9, author: { id: 999001, name: "Новый бот" }, text: "..." }],
    { config: { botAuthorId: 999001 } });
  t.check("a bot id taken from config is recognised", r.result.skip === true && /own/.test(r.result.reason), r.result);
  r = await run([{ id: 9, author: BOT, text: "...", channel: CHAN }], { config: { botAuthorId: 999001 } });
  t.check("and the previous account is then no longer the bot", r.result.skip === false, r.result);
  // Several accounts of ours may exist at once — a test one and a production one.
  r = await run([{ id: 9, author: BOT, text: "...", channel: CHAN }],
    { config: { botAuthorIds: [999001, 1314929] } });
  t.check("a list of our own accounts is honoured", r.result.skip === true && /own/.test(r.result.reason), r.result);

  // ── Which form the bot works in ──
  // `runtime.formId` was written and never read, so every webhook was a chat. Safe with the
  // webhook on one form; not safe the moment it is registered on the ticket form, because
  // that is also the form the bot creates its own subtasks on.
  const CHAT_FORM = 77;
  const TICKET_FORM = 2454249;
  const BOT_APPROVER = { current_step: 1, approvals: [[{ person: BOT, step: 1, approval_choice: "waiting" }]] };
  const FIRST_LINE_APPROVER = { current_step: 1, approvals: [[{ person: OPERATOR, step: 1, approval_choice: "waiting" }]] };

  // A ticket, as Pyrus reports it: the task lives on the ticket form and carries approvals.
  async function ticket(comments, extraTask, forms) {
    const env = makeEnv({
      payload: {
        task_id: 11613, event: "comment", access_token: "t", api_url: "https://api.pyrus.com/v4/",
        task: Object.assign({ id: 11613, form_id: TICKET_FORM, fields: [], comments: comments }, extraTask || {})
      },
      db: {
        config: {
          forms: forms || { [CHAT_FORM]: { role: "chat" }, [TICKET_FORM]: { role: "ticket" } }
        }
      }
    });
    return { result: await receiveWebhook(env), state: env.db[KEY], notes: env.notes };
  }

  // Absent `config.forms` must mean «behave exactly as before»: a default of silence here
  // would have taken the live bot down on the deploy that introduced this.
  r = await run([{ id: 60, author: PARTNER, text: "Не печатает чек", channel: CHAN }], {});
  t.check("with no forms configured every form is still a chat",
    r.result.skip === false && r.result.stage === "intake", r.result);
  t.check("and the role is recorded for the rest of the graph", r.state.runtime.role === "chat", r.state.runtime);
  t.check("without an explicit form permission managed answers fail closed",
    r.state.runtime.knowledgeExecution === "handover_only", r.state.runtime);

  r = await run([{ id: 60, author: PARTNER, text: "Не печатает чек", channel: CHAN }], {
    config: { forms: { [CHAT_FORM]: {
      role: "chat", environment: "test", knowledgeExecution: "partner_answer"
    } } }
  });
  t.check("the test chat form explicitly enables accepted partner answers",
    r.state.runtime.knowledgeExecution === "partner_answer", r.state.runtime);

  r = await run([{ id: 60, author: PARTNER, text: "Не печатает чек", channel: CHAN }], {
    config: { forms: { [CHAT_FORM]: { role: "chat", knowledgeExecution: "unknown" } } }
  });
  t.check("an unknown execution value also fails closed",
    r.state.runtime.knowledgeExecution === "handover_only", r.state.runtime);

  // Once the map exists it is a whitelist. An unlisted form is left completely alone.
  let k = await ticket([{ id: 61, author: PARTNER, text: "вопрос", channel: CHAN }], BOT_APPROVER,
    { [CHAT_FORM]: { role: "chat" } });
  t.check("a form absent from the whitelist is left alone",
    k.result.skip === true && /not one the bot works in/.test(k.result.reason), k.result);

  // ── The gate: is it the bot's turn? ──
  k = await ticket([{ id: 62, author: PARTNER, text: "не приходят отчёты", channel: CHAN }], BOT_APPROVER);
  t.check("an email ticket where the bot is the current approver is worked",
    k.result.skip === false && k.result.stage === "intake", k.result);
  t.check("and it is recorded as a ticket, not a chat", k.state.runtime.role === "ticket", k.state.runtime);

  // The case that would have hurt most: the subtask the bot itself created a minute ago. The
  // first line owns step 1 there — which is also why posting action:"finished" on a fresh
  // subtask always answered 400. Permission and mandate are the same fact.
  // ── The step is only required where the form says so ──
  // The idea was that the workflow grants the mandate, and on production it does: step 1 of a
  // subtask belongs to «бот Approver» / «[support] Первая линия», which is also why finishing
  // a freshly created subtask always answered 400. But on the test copy of the form the bot
  // sits on step 1 of EVERY task, including one an operator made by hand — there the signal
  // separates nothing. So by default it is logged, not enforced.
  const STRICT = { [CHAT_FORM]: { role: "chat" }, [TICKET_FORM]: { role: "ticket", requireApprover: true } };

  k = await ticket([{ id: 63, author: PARTNER, text: "есть новости?", channel: CHAN }], FIRST_LINE_APPROVER, STRICT);
  t.check("with requireApprover a step that belongs to the first line is left alone",
    k.result.skip === true && /belongs to someone else/.test(k.result.reason), k.result);

  // «Cannot tell» must mean silence, not «probably mine» — again, only where required.
  k = await ticket([{ id: 64, author: PARTNER, text: "вопрос", channel: CHAN }], { current_step: 1, approvals: "?" }, STRICT);
  t.check("with requireApprover a payload that does not say who approves keeps the bot out",
    k.result.skip === true && /does not say/.test(k.result.reason), k.result);

  // Without it the same ticket is worked, which is what makes the test form usable at all.
  k = await ticket([{ id: 64, author: PARTNER, text: "вопрос", channel: CHAN }], FIRST_LINE_APPROVER);
  t.check("without requireApprover the step does not block the turn",
    k.result.skip === false && k.result.stage === "intake", k.result);

  // ── A call-center ticket is named by the form itself ──
  // «Id задачи из КЦ» filled means the request came from the call center: there is no partner
  // in the task, the correspondence is internal only. A field, not a guess about a workflow.
  k = await ticket([{ id: 66, author: PARTNER, text: "заявка", channel: CHAN }],
    Object.assign({}, BOT_APPROVER, {
      fields: [{ id: 4, type: "title", name: "Системные поля", value: { fields: [{ id: 9, type: "number", name: "Id задачи из КЦ", value: 778899 }] } }]
    }));
  t.check("a filled «Id задачи из КЦ» keeps the bot out",
    k.result.skip === true && /колл-центра/.test(k.result.reason), k.result);

  // The same field present but empty is an ordinary ticket.
  k = await ticket([{ id: 67, author: PARTNER, text: "заявка", channel: CHAN }],
    Object.assign({}, BOT_APPROVER, {
      fields: [{ id: 4, type: "title", name: "Системные поля", value: { fields: [{ id: 9, type: "number", name: "Id задачи из КЦ" }] } }]
    }));
  t.check("an empty «Id задачи из КЦ» does not keep the bot out",
    k.result.skip === false && k.result.stage === "intake", k.result);

  // ── The subtask the bot created itself ──
  // It is created on this very form. If email correspondence is enabled on it, the partner's
  // reply arrives with an inbound channel — and without this check the bot would take over a
  // request it had handed to the first line a minute earlier. The task author settles it.
  k = await ticket([{ id: 68, author: PARTNER, text: "а что с моим обращением?", channel: CHAN }],
    Object.assign({}, BOT_APPROVER, { author: BOT }));
  t.check("a task the bot itself created is left to the first line",
    k.result.skip === true && /создал сам бот/.test(k.result.reason), k.result);

  // Call-center tickets: no channel at all, colleagues and the bot share one internal
  // correspondence. There is no partner to answer, so there is nothing to do. The opening
  // message is exempt from the internal-comment guard — Pyrus reports the task body without a
  // channel — so this is the check that has to catch such a ticket.
  k = await ticket([{ id: 65, author: PARTNER, text: "заявка из колл-центра" }], BOT_APPROVER);
  t.check("a ticket with no inbound channel is left alone",
    k.result.skip === true && /nobody to reply to/.test(k.result.reason), k.result);

  // ── Idempotency: one comment is answered once ──
  r = await run([{ id: 7, author: PARTNER, text: "Повтор", channel: CHAN }],
    { [KEY]: { lastProcessedCommentId: "7" } });
  t.check("redelivered comment is skipped", r.result.skip === true && /already answered/.test(r.result.reason), r.result);

  r = await run([{ id: 8, author: PARTNER, text: "Новое", channel: CHAN }],
    { [KEY]: { lastProcessedCommentId: "7" } });
  t.check("a different comment is processed", r.result.skip === false && r.result.stage === "intake", r.result);

  // ── Ordinary first message ──
  r = await run([{ id: 1, author: PARTNER, text: "Не печатает чек", channel: CHAN }], {});
  t.check("fresh message enters intake", r.result.stage === "intake" && r.result.skip === false, r.result);
  t.check("incoming comment id is recorded for the debounce", r.state.runtime.incomingCommentId === "1", r.state.runtime);
  t.check("outbound channel is derived from the partner's channel",
    r.state.runtime.outboundChannel && r.state.runtime.outboundChannel.direction === "outbound" &&
    r.state.runtime.outboundChannel.to === "p@x.ru", r.state.runtime.outboundChannel);
  t.check("first reply is marked for the greeting", r.state.runtime.isFirstBotReply === true, r.state.runtime);
  t.check("token is not written into the agent context",
    JSON.stringify(r.values).indexOf("\"t\"") < 0, r.values);

  // An address once known for a task stays known. Pyrus may truncate `comments` from the
  // tail, and if the truncation takes away every inbound comment there is nothing left to
  // derive the channel from — with finalize now refusing to talk into a channel-less void,
  // that loss would turn a healthy conversation into a handover.
  r = await run([{ id: 55, author: OPERATOR, text: "внутренняя заметка" }],
    { [KEY]: { taskId: 11613, runtime: { outboundChannel: { type: "email", direction: "outbound", to: "p@x.ru" } } } });
  t.check("a known reply address survives a thread with no inbound comment left",
    r.state.runtime.outboundChannel && r.state.runtime.outboundChannel.to === "p@x.ru",
    r.state.runtime.outboundChannel);

  // Greeting must not repeat when Pyrus truncates comments from the tail.
  r = await run([{ id: 5, author: PARTNER, text: "и ещё", channel: CHAN }],
    { [KEY]: { botHasReplied: true } });
  t.check("no second greeting when the thread is truncated", r.state.runtime.isFirstBotReply === false, r.state.runtime);

  // ── Writes touch only the paths this function owns ──
  // A full rewrite resurrected everything the run had not seen: the answered-comment
  // marker a concurrent finalize had just written, and facts collected by another turn.
  r = await run([{ id: 6, author: PARTNER, text: "дальше", channel: CHAN }], {
    // `taskId` inside the payload is the handle the point write aims at: the platform
    // matches filters against the contents of `value`, never against the document key.
    [KEY]: {
      taskId: 11613,
      stage: null,
      lastProcessedCommentId: "5",
      subtaskId: 777,
      data: { unitFullName: "[dodopizza.ru] Тамбов-1", problemSummary: "не печатает чек" }
    }
  });
  t.check("existing document is patched, not rewritten", r.updates.length === 1, r.updates);
  // The document is addressed by a field inside its payload: the key is not filterable.
  t.check("the write is aimed at this task, not at the document key",
    r.updates[0].filters.taskId === 11613 && r.updates[0].filters.key === undefined,
    r.updates[0].filters);
  // `pendingOutcome` is among them on purpose: the decision of a turn must not outlive it.
  // `data.handoverReason` for the same reason — the reason recorded about one handover must
  // not be read out to the operator about the next.
  t.check("only own paths are written",
    setPaths(r.updates[0]).join(",") === "botHasReplied,data.handoverReason,pendingOutcome,runtime,taskId,updatedAt",
    setPaths(r.updates[0]));
  t.check("a point write that finds its document needs no whole-document rescue",
    r.puts.length === 0, r.puts);
  t.check("answered-comment marker survives", r.state.lastProcessedCommentId === "5", r.state);
  t.check("facts of the current turn survive",
    r.state.data.problemSummary === "не печатает чек", r.state.data);
  t.check("subtaskId survives", r.state.subtaskId === 777, r.state);

  // ── The decision of a turn must not outlive that turn ──
  // finalize consumes `pendingOutcome` only when it manages to post. A run that died on a
  // Pyrus outage, on a missing token or on being superseded leaves it behind — and finalize
  // is the `next-error-step` of nearly every node, so the next turn that throws anywhere
  // reaches finalize, finds a decision made about a DIFFERENT message and posts it to the
  // partner, acting on its `action`: closing or escalating the task on a stale verdict.
  r = await run([{ id: 12, author: PARTNER, text: "новое сообщение", channel: CHAN }], {
    [KEY]: {
      taskId: 11613,
      stage: "gathering",
      lastProcessedCommentId: "11",
      data: { unitFullName: "[dodopizza.ru] Тамбов-1", problemSummary: "не печатает чек" },
      pendingOutcome: {
        kind: "escalated", replyText: "Ответ на ПРОШЛОЕ сообщение",
        action: null, approvalChoice: "approved", nextStage: "escalated"
      }
    }
  });
  t.check("a stale decision is cleared at the start of a turn", r.state.pendingOutcome === null, r.state.pendingOutcome);
  t.check("and clearing it costs no whole-document rescue", r.puts.length === 0, r.puts);
  t.check("clearing the decision does not touch the collected facts",
    r.state.data.problemSummary === "не печатает чек" && r.state.stage === "gathering", r.state);

  // ── Кто в треде, когда партнёр пришёл через веб-виджет ──
  // Ровно этот payload видно в выгрузке живого чата: автором комментария Pyrus называет
  // СВОЙ служебный аккаунт (`last_name: "Pyrus.com"`), а имени партнёра нет ни в канале, ни
  // в поле «Имя» — там `Anonymous user`. Раньше побеждал автор, и оператор читал «Партнёр:
  // Pyrus.com», что похоже на название организации-контрагента.
  r = await run([{
    id: 1,
    author: { id: 1730, first_name: "", last_name: "Pyrus.com", type: "user" },
    text: "здравствуйте",
    channel: { type: "web_widget", direction: "inbound", from: { name: "Anonymous user" } }
  }], {});
  t.check("служебное имя Pyrus за имя партнёра не выдаётся",
    r.state.runtime.partnerName === null, r.state.runtime.partnerName);

  r = await run([{ id: 1, author: PARTNER, text: "здравствуйте", channel: CHAN }], {});
  t.check("настоящее имя из канала или от автора сохраняется",
    r.state.runtime.partnerName === "p@x.ru", r.state.runtime.partnerName);

  // A point write cannot create a document — there is no upsert — and it reports the miss
  // as count 0 instead of failing. The fallback is what makes the first turn persist.
  r = await run([{ id: 1, author: PARTNER, text: "первое обращение", channel: CHAN }], {});
  t.check("missing document is created after the point write misses", !!r.state, r.state);
  const firstTurnPaths = setPaths(r.updates[0]);
  t.check("a new document never updates data together with one of its child paths",
    firstTurnPaths.indexOf("data") >= 0 && !firstTurnPaths.some(p => /^data\./.test(p)), firstTurnPaths);
  t.check("the created document carries the facts subtree", !!r.state.data, r.state);
  t.check("and the runtime of this request", !!r.state.runtime.token, r.state.runtime);

  // Harvesting the email writes that one field, not the whole subtree.
  r = await run([{ id: 31, author: PARTNER, text: "мой адрес ivan@shop.ru", channel: CHAN }],
    { [KEY]: { taskId: 11613, stage: "awaiting_email", data: { unitFullName: "[dodopizza.ru] Тамбов-1" } } });
  t.check("email is written as a single path",
    setPaths(r.updates[0]).indexOf("data.email") >= 0 &&
    setPaths(r.updates[0]).indexOf("data") < 0, setPaths(r.updates[0]));
  t.check("unit is untouched by the email write",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1", r.state.data);

  // ── Who said what in the history the model reads ──
  // An operator's internal note has no channel. Labelled «Партнёр», it made the model
  // answer things the partner had never said — including the bot's own summaries.
  r = await run([
    { id: 1, author: PARTNER, text: "Не печатает чек", channel: CHAN },
    { id: 2, author: BOT, text: "Проверьте кабель" },
    { id: 3, author: OPERATOR, text: "[Внутренняя переписка] проверил, дело в драйвере" },
    { id: 4, author: PARTNER, text: "не помогло", channel: CHAN }
  ], {});
  const roles = r.notes.filter(n => /^(Партнёр|Ассистент|Оператор):/.test(n));
  t.check("opening message is the partner's", /^Партнёр: Не печатает чек/.test(roles[0]), roles);
  t.check("bot's reply is labelled Ассистент", /^Ассистент:/.test(roles[1]), roles);
  t.check("operator's internal note is labelled Оператор", /^Оператор:/.test(roles[2]), roles);
  t.check("partner's reply through the channel is labelled Партнёр", /^Партнёр: не помогло/.test(roles[3]), roles);

  // The task body arrives without a channel and is still the partner's.
  r = await run([{ id: 1, author: PARTNER, text: "Здравствуйте, не печатает чек" }], {});
  t.check("channel-less opening message is not mistaken for an operator",
    r.notes.some(n => /^Партнёр: Здравствуйте/.test(n)), r.notes);

  // ── Attachment with no text: the bot cannot read it, a human must ──
  r = await run([{ id: 3, author: PARTNER, text: "", attachments: [{ id: 1, name: "s.png" }], channel: CHAN }], {});
  t.check("attachment without text hands over", r.result.stage === "attachment" && r.result.skip === false, r.result);
  t.check("reason for the operator's summary is set", /вложение/.test(r.result.reason), r.result);

  r = await run([{ id: 4, author: PARTNER, text: "", attachments: [{ id: 1 }], channel: CHAN }],
    { [KEY]: { stage: "awaiting_confirmation" } });
  t.check("attachment hands over on the confirmation stage too", r.result.stage === "attachment", r.result);

  r = await run([{ id: 4, author: PARTNER, text: "вот скриншот", attachments: [{ id: 1 }], channel: CHAN }], {});
  t.check("attachment WITH text is handled normally", r.result.stage === "intake", r.result);

  // ── A pasted log must not sit in the prompt for the next twenty turns ──
  // Notes are rebuilt from the thread on every webhook, so an unbounded comment was paid
  // for on every model call until it fell out of the window — crowding out the instructions.
  const hugeLog = "ERROR ".repeat(2000);
  r = await run([{ id: 50, author: PARTNER, text: hugeLog, channel: CHAN }], {});
  const longest = r.notes.reduce((m, n) => Math.max(m, n.length), 0);
  t.check("a pasted log is cut down for the prompt", longest < 2000, longest);
  t.check("and the cut is visible rather than silent",
    r.notes.some(n => /сообщение обрезано/.test(n)), r.notes.map(n => n.slice(0, 60)));
  // The code that looks for the unit, the business and the branch reads the value from the
  // context, so it is capped far more generously than the history lines.
  t.check("the text the tools read is kept much longer than a history line",
    r.values.dialog.incomingText.length > 2000, r.values.dialog.incomingText.length);

  // ── Stage resolution ──
  r = await run([{ id: 5, author: PARTNER, text: "Ну что там?", channel: CHAN }], { [KEY]: { stage: "escalated" } });
  t.check("operator owns the thread: bot stays quiet", r.result.skip === true && r.result.stage === "escalated", r.result);

  r = await run([{ id: 6, author: PARTNER, text: "Получилось!", channel: CHAN }],
    { [KEY]: { stage: "awaiting_confirmation" } });
  t.check("confirmation stage is entered", r.result.stage === "awaiting_confirmation", r.result);

  // ── An explicit request to close belongs to the state machine, not to the model ──
  // On awaiting_answers there is no confirmation agent in front of the solver. In a live
  // turn the model wrote «закрываю» but returned kind:handover, so the partner heard one
  // action while Pyrus performed the opposite one. Only an explicit action + current-chat
  // object is accepted here; equipment and business procedures must remain ordinary text.
  r = await run([{ id: 70, author: PARTNER,
    text: "Простите, не актуально, сами решили, чат можете закрыть", channel: CHAN }],
    { [KEY]: { stage: "awaiting_answers", data: { topicKey: "employee_card_change" } } });
  t.check("a close request is heard while the article is waiting for an answer",
    r.result.stage === "close_request", r.result);

  for (const storedStage of ["intake", "awaiting_email", "awaiting_confirmation"]) {
    r = await run([{ id: 71, author: PARTNER, text: "Закройте, пожалуйста, обращение", channel: CHAN }],
      { [KEY]: { stage: storedStage } });
    t.check("a close request is heard on " + storedStage, r.result.stage === "close_request", r.result);
  }

  r = await run([{ id: 72, author: PARTNER, text: "Закройте крышку кассы", channel: CHAN }],
    { [KEY]: { stage: "awaiting_answers", data: { topicKey: "pos_down" } } });
  t.check("closing the cash-register cover is not closing the chat",
    r.result.stage === "awaiting_answers", r.result);

  r = await run([{ id: 73, author: PARTNER, text: "Не закрывайте чат", channel: CHAN }],
    { [KEY]: { stage: "awaiting_answers", data: { topicKey: "employee_card_change" } } });
  t.check("an explicit negation is not taken for a close request",
    r.result.stage === "awaiting_answers", r.result);

  r = await run([{ id: 21, author: PARTNER, text: "Ещё вопрос", action: "reopened", channel: CHAN }],
    { [KEY]: { stage: "closed", data: { unitFullName: "Москва 12" } } });
  t.check("chat closed by the bot goes to the operator silently", r.result.stage === "reopened", r.result);

  // ── The answer to a question the ARTICLE asked goes straight back to the solver ──
  // Through the gathering stage it cost intake and routing on every answer — two extra model
  // calls on an article that legitimately asks up to a dozen questions — and routing was
  // free to rewrite topicKey in the middle of the walk.
  r = await run([{ id: 40, author: PARTNER, text: "фамилию", channel: CHAN }],
    { [KEY]: { stage: "awaiting_answers", data: { topicKey: "employee_change", unitFullName: "Москва 12" } } });
  t.check("an answer to the article returns to the solver, not to intake",
    r.result.stage === "awaiting_answers" && r.result.skip === false, r.result);

  // No topic means no article to return to, and intake is always the safe fallback.
  r = await run([{ id: 41, author: PARTNER, text: "фамилию", channel: CHAN }],
    { [KEY]: { stage: "awaiting_answers", data: { unitFullName: "Москва 12" } } });
  t.check("without a topic the stage falls back to intake", r.result.stage === "intake", r.result);

  // What the article still wants to know has to be IN the prompt on that stage: nothing
  // runs in front of the solver there to publish it, so it is carried in the document.
  r = await run([{ id: 42, author: PARTNER, text: "фамилию", channel: CHAN }], {
    [KEY]: {
      stage: "awaiting_answers",
      data: {
        topicKey: "employee_change",
        treeAnswers: { whatToChange: "фамилию" },
        openAnswerPrompts: "newValue — на какое значение менять"
      }
    }
  });
  const factsNote = r.notes.filter(n => /Известные данные/.test(n))[0] || "";
  t.check("the open questions of the article reach the prompt",
    /Ещё не отвечено \(ключ — вопрос\): newValue — на какое значение менять/.test(factsNote), factsNote);
  t.check("and so does what has already been collected",
    /Уже собрано по тематике: whatToChange: фамилию/.test(factsNote), factsNote);

  // ── Email is only harvested where it is expected ──
  r = await run([{ id: 30, author: PARTNER, text: "письмо от noreply@pyrus.com не пришло", channel: CHAN }], {});
  t.check("quoted address is ignored outside awaiting_email", !r.state.data.email, r.state.data);

  r = await run([{ id: 31, author: PARTNER, text: "мой адрес ivan@shop.ru", channel: CHAN }],
    { [KEY]: { stage: "awaiting_email" } });
  t.check("address is taken on awaiting_email", r.state.data.email === "ivan@shop.ru", r.state.data);

  // ── A reopen after a handover is a NEW обращение ──
  // `escalated` used to be a trap: tasks are reused for months and nothing cleared it,
  // so the bot went silent in that chat forever.
  const seed = {
    [KEY]: {
      stage: "escalated",
      botHasReplied: true,
      subtaskId: "999",
      clarifyStreak: 2,
      pendingOutcome: { kind: "escalated" },
      lastProcessedCommentId: "10",
      data: {
        unitFullName: "Москва 12", email: "p@x.ru", problemSummary: "старая проблема",
        topicKey: "old_topic", componentName: "Касса",
        attempts: [{ step: 1, advice: "перезагрузить" }], preQuestionsAsked: ["old_topic"]
      }
    }
  };
  const reopenThread = [
    { id: 10, author: PARTNER, text: "старая проблема", channel: CHAN },
    { id: 11, author: BOT, text: "Передаю специалисту." },
    { id: 12, author: BOT, text: "Решено.", action: "finished" },
    { id: 13, author: PARTNER, text: "У меня остался еще один вопрос", action: "reopened", channel: CHAN }
  ];
  r = await run(reopenThread, seed);
  t.check("reopen by the partner starts a new request", r.result.stage === "intake" && r.result.skip === false, r.result);
  t.check("unit is carried over", r.state.data.unitFullName === "Москва 12", r.state.data);
  t.check("email is carried over", r.state.data.email === "p@x.ru", r.state.data);
  t.check("facts of the solved problem are dropped",
    !r.state.data.problemSummary && !r.state.data.topicKey && !r.state.data.componentName &&
    !r.state.data.attempts && !r.state.data.preQuestionsAsked, r.state.data);
  t.check("subtaskId is cleared so a new subtask is possible", r.state.subtaskId === null, r.state.subtaskId);
  t.check("clarify streak is cleared", r.state.clarifyStreak === 0, r.state.clarifyStreak);
  t.check("stale pendingOutcome is cleared", r.state.pendingOutcome === null, r.state.pendingOutcome);
  t.check("the new request is greeted again", r.state.runtime.isFirstBotReply === true, r.state.runtime);

  const dialogNotes = r.notes.filter(n => /^(Партнёр|Ассистент):/.test(n));
  t.check("prompt history starts after the close",
    dialogNotes.length === 1 && /остался еще один вопрос/.test(dialogNotes[0]), dialogNotes);

  // The operator may reopen the task himself — the bot must not answer a colleague.
  r = await run([
    { id: 12, author: BOT, text: "Решено.", action: "finished" },
    { id: 14, author: OPERATOR, text: "Переоткрываю, недоделал", action: "reopened" }
  ], { [KEY]: { stage: "escalated", data: { unitFullName: "Москва 12" } } });
  // Caught by the internal-comment guard now, one step earlier and before anything is read
  // from the database — the reopen check below is the second line of defence rather than the
  // first. What matters is unchanged: the bot does not answer a colleague.
  t.check("operator's own reopen does not wake the bot",
    r.result.skip === true && /internal/.test(r.result.reason), r.result);

  // A partner writing into a thread the operator has NOT closed is still his business.
  r = await run([{ id: 15, author: PARTNER, text: "Есть новости?", channel: CHAN }],
    { [KEY]: { stage: "escalated" } });
  t.check("no reset without an actual reopen", r.result.skip === true, r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
