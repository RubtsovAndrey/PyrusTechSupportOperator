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

  r = await run([{ id: 9, author: { id: 4242, email: "bot@9f1c-uuid" }, text: "..." }], {});
  t.check("bot recognised by bot@ email when id is unknown", r.result.skip === true, r.result);

  r = await run([{ id: 9, author: { id: 4242, type: "bot", email: "real@person.ru" }, text: "..." }], {});
  t.check("author.type is not trusted: a real person is not a bot", r.result.skip === false, r.result);

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
  t.check("only own paths are written",
    setPaths(r.updates[0]).join(",") === "botHasReplied,runtime,taskId,updatedAt",
    setPaths(r.updates[0]));
  t.check("a point write that finds its document needs no whole-document rescue",
    r.puts.length === 0, r.puts);
  t.check("answered-comment marker survives", r.state.lastProcessedCommentId === "5", r.state);
  t.check("facts of the current turn survive",
    r.state.data.problemSummary === "не печатает чек", r.state.data);
  t.check("subtaskId survives", r.state.subtaskId === 777, r.state);

  // The web widget reports the sender as an object, not a string. Concatenated into the
  // operator's summary it read «Кто обращается: [object Object]».
  r = await run([{
    id: 1,
    author: { id: 555, first_name: "", last_name: "" },
    text: "здравствуйте",
    channel: { type: "web_widget", direction: "inbound", from: { name: "Anonymous user" } }
  }], {});
  t.check("a channel address that is an object still yields a name",
    r.state.runtime.partnerName === "Anonymous user", r.state.runtime.partnerName);

  r = await run([{ id: 1, author: PARTNER, text: "здравствуйте", channel: CHAN }], {});
  t.check("a named author still wins over the channel address",
    r.state.runtime.partnerName === "Партнёр", r.state.runtime.partnerName);

  // A point write cannot create a document — there is no upsert — and it reports the miss
  // as count 0 instead of failing. The fallback is what makes the first turn persist.
  r = await run([{ id: 1, author: PARTNER, text: "первое обращение", channel: CHAN }], {});
  t.check("missing document is created after the point write misses", !!r.state, r.state);
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

  // ── Stage resolution ──
  r = await run([{ id: 5, author: PARTNER, text: "Ну что там?", channel: CHAN }], { [KEY]: { stage: "escalated" } });
  t.check("operator owns the thread: bot stays quiet", r.result.skip === true && r.result.stage === "escalated", r.result);

  r = await run([{ id: 6, author: PARTNER, text: "Получилось!", channel: CHAN }],
    { [KEY]: { stage: "awaiting_confirmation" } });
  t.check("confirmation stage is entered", r.result.stage === "awaiting_confirmation", r.result);

  r = await run([{ id: 21, author: PARTNER, text: "Ещё вопрос", action: "reopened", channel: CHAN }],
    { [KEY]: { stage: "closed", data: { unitFullName: "Москва 12" } } });
  t.check("chat closed by the bot goes to the operator silently", r.result.stage === "reopened", r.result);

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
  t.check("operator's own reopen does not wake the bot",
    r.result.skip === true && r.result.stage === "escalated", r.result);

  // A partner writing into a thread the operator has NOT closed is still his business.
  r = await run([{ id: 15, author: PARTNER, text: "Есть новости?", channel: CHAN }],
    { [KEY]: { stage: "escalated" } });
  t.check("no reset without an actual reopen", r.result.skip === true, r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
