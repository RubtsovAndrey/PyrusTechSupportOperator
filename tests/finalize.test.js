// Tests for ID_Pyrus.finalize — the only place that writes to Pyrus. Two invariants
// matter most and both were once broken:
//   1. the stage moves only after the partner has actually been told something;
//   2. of two racing runs only the one holding the newest message speaks.
const { loadFunction, makeEnv, suite } = require("./harness");

const finalize = loadFunction("functions/ID_Pyrus/finalize/code.js");
// The decision and its delivery are two functions and two documents apart, so the
// handover of state between them is tested end to end.
const applyOutcome = loadFunction("functions/ID_Actions/applyOutcome/code.js", ["outcome", "replyText"]);
// And the round trip needs the third: a stage is only real if the next webhook reads it back.
const receiveWebhook = loadFunction("functions/ID_Pyrus/receiveWebhook/code.js");

const BOT = { id: 1314929, name: "Бот" };
const PARTNER = { id: 555, name: "Партнёр" };
// An operator writes into the internal correspondence: a real person, but no channel.
const OPERATOR = { id: 777, name: "Оператор" };
const CHAN = { type: "email", direction: "inbound", from: "p@x.ru" };
const KEY = "state:11613";

const runtime = {
  apiUrl: "https://api.pyrus.com/v4/",
  token: "t",
  outboundChannel: { type: "email", direction: "outbound", to: "p@x.ru" },
  incomingCommentId: "42",
  isFirstBotReply: false
};

// The thread as Pyrus reports it at the moment finalize probes it.
const threadWith = comments => () => ({ body: { task: { id: 11613, comments: comments } } });
const UNCHANGED = threadWith([{ id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN }]);

// `taskId` lives inside the payload because that is the only thing a point write can
// filter on: the platform matches filters against the contents of `value`, not the key.
function state(extra) {
  return Object.assign({ taskId: 11613, stage: "awaiting_confirmation", runtime: runtime }, extra || {});
}

const clarify = {
  kind: "clarify",
  replyText: "Подскажите, о какой точке идёт речь?",
  internalNote: null,
  action: null,
  approvalChoice: null,
  fieldUpdates: null,
  nextStage: "awaiting_confirmation"
};

// The webhook payload of the run itself: what this invocation was asked to answer.
function ownPayload(commentId) {
  return {
    task_id: 11613, event: "comment", access_token: "t",
    task: { id: 11613, comments: [{ id: commentId, author: PARTNER, text: "...", channel: CHAN }] }
  };
}

async function run(options) {
  const env = makeEnv(Object.assign({ prev: { taskId: "11613" }, onGet: UNCHANGED }, options));
  const result = await finalize(env);
  return { result, state: env.db[KEY], posts: env.posts, updates: env.updates, puts: env.puts, env };
}

async function main() {
  const t = suite("finalize");

  // ── Skipped runs must not touch anything ──
  let r = await run({
    prev: { taskId: "11613", skip: true, reason: "last comment is the bot's own" },
    db: { [KEY]: state({ pendingOutcome: null }) }
  });
  t.check("skipped run posts nothing", r.posts.length === 0, r.posts);
  t.check("skipped run leaves the stage alone", r.state.stage === "awaiting_confirmation", r.state);
  t.check("skipped run reports itself", r.result.kind === "skipped", r.result);

  // ── The happy path ──
  r = await run({ db: { [KEY]: state({ pendingOutcome: clarify }) } });
  t.check("reply is posted once", r.posts.length === 1, r.posts);
  t.check("reply text reaches Pyrus", r.posts[0].body.text === clarify.replyText, r.posts[0].body);
  t.check("reply goes out through the partner's channel",
    r.posts[0].body.channel && r.posts[0].body.channel.direction === "outbound", r.posts[0].body);
  t.check("stage is advanced after a successful post", r.state.stage === "awaiting_confirmation", r.state);
  t.check("pendingOutcome is consumed", r.state.pendingOutcome === null, r.state);
  t.check("answered comment is recorded for idempotency", r.state.lastProcessedCommentId === "42", r.state);
  t.check("botHasReplied is set so the greeting is not repeated", r.state.botHasReplied === true, r.state);

  // ── Debounce: the partner wrote again while the run was thinking ──
  r = await run({
    db: { [KEY]: state({ pendingOutcome: clarify }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 43, author: PARTNER, text: "точка Москва 12", channel: CHAN }
    ])
  });
  t.check("superseded run posts nothing", r.posts.length === 0, r.posts);
  t.check("superseded run does not move the stage", r.state.stage === "awaiting_confirmation", r.state);
  t.check("superseded run keeps pendingOutcome for the newer run to overwrite",
    r.state.pendingOutcome !== null, r.state.pendingOutcome);
  t.check("superseded run reports itself", r.result.kind === "superseded", r.result);

  // The bot's own reply is the newest comment in the thread — that is not a supersede.
  r = await run({
    db: { [KEY]: state({ pendingOutcome: clarify }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 44, author: BOT, text: "Уже отвечено ранее" }
    ])
  });
  t.check("bot's own newer comment does not suppress the reply", r.posts.length === 1, r.posts);

  // The run's own comment id comes from its own payload, never from the shared document:
  // a webhook that arrived a moment later has already overwritten runtime.incomingCommentId,
  // and a stale run trusting that value would decide it is current and answer too.
  r = await run({
    payload: ownPayload(42),
    db: { [KEY]: state({ pendingOutcome: clarify, runtime: Object.assign({}, runtime, { incomingCommentId: "43" }) }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 43, author: PARTNER, text: "точка Москва 12", channel: CHAN }
    ])
  });
  t.check("stale run defers even when the document points at the newer comment",
    r.posts.length === 0 && r.result.kind === "superseded", { posts: r.posts, result: r.result });

  // And the run that does own the newest comment speaks.
  r = await run({
    payload: ownPayload(43),
    db: { [KEY]: state({ pendingOutcome: clarify, runtime: Object.assign({}, runtime, { incomingCommentId: "42" }) }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 43, author: PARTNER, text: "точка Москва 12", channel: CHAN }
    ])
  });
  t.check("the run holding the newest comment answers", r.posts.length === 1, r.posts);
  t.check("and records that comment as answered", r.state.lastProcessedCommentId === "43", r.state);

  // ── An operator's internal note is not «a newer message» ──
  // It has no channel, so it produces no run that holds a decision to speak with: treating
  // it as a supersede made this run stand down and left the partner with no answer at all.
  // A thread that really belongs to a human is silenced a step earlier, by the escalated
  // stage in receiveWebhook — not here.
  r = await run({
    payload: ownPayload(42),
    db: { [KEY]: state({ pendingOutcome: clarify }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 43, author: OPERATOR, text: "смотрю, что там по кассе" }
    ])
  });
  t.check("operator's internal note does not suppress the answer to the partner",
    r.posts.length === 1 && r.result.kind !== "superseded", { posts: r.posts.length, result: r.result });

  // But a real message of the partner still wins, even arriving after the operator's note.
  r = await run({
    payload: ownPayload(42),
    db: { [KEY]: state({ pendingOutcome: clarify }) },
    onGet: threadWith([
      { id: 42, author: PARTNER, text: "Не печатает чек", channel: CHAN },
      { id: 43, author: OPERATOR, text: "смотрю" },
      { id: 44, author: PARTNER, text: "и ещё вот что", channel: CHAN }
    ])
  });
  t.check("a newer message of the partner still supersedes the run",
    r.posts.length === 0 && r.result.kind === "superseded", { posts: r.posts.length, result: r.result });

  // A failed probe must not swallow the answer: at worst we reply to a stale thread.
  r = await run({
    db: { [KEY]: state({ pendingOutcome: clarify }) },
    onGet: () => { throw new Error("pyrus timeout"); }
  });
  t.check("failed probe still sends the reply", r.posts.length === 1, r.posts);

  // ── Pyrus refuses the comment: the stage must not move ──
  // Written before the post, a short outage left the bot convinced it had asked a
  // question the partner never saw, and the next message was read as an answer to it.
  r = await run({ db: { [KEY]: state({ stage: "intake", pendingOutcome: clarify }) }, failPost: true });
  t.check("failed post does not advance the stage", r.state.stage === "intake", r.state);
  t.check("failed post keeps pendingOutcome", r.state.pendingOutcome !== null, r.state.pendingOutcome);
  t.check("failed post is reported as a failure", r.result.success === false, r.result);

  // ── Escalation: summary to the internal correspondence, then the handover ──
  const escalated = {
    kind: "escalated",
    replyText: "Передаю обращение специалисту.",
    internalNote: "[Внутренняя переписка]\nБот передаёт обращение оператору.",
    action: null,
    approvalChoice: "approved",
    fieldUpdates: null,
    nextStage: "escalated"
  };
  r = await run({ db: { [KEY]: state({ pendingOutcome: escalated }) } });
  t.check("two comments are posted: summary and reply", r.posts.length === 2, r.posts.map(p => p.body));
  t.check("summary goes first", /Внутренняя переписка/.test(r.posts[0].body.text), r.posts[0].body);
  t.check("summary has NO channel, so the partner never sees it",
    r.posts[0].body.channel === undefined, r.posts[0].body);
  t.check("handover advances the Pyrus step", r.posts[1].body.approval_choice === "approved", r.posts[1].body);
  t.check("stage becomes escalated", r.state.stage === "escalated", r.state);

  // ── Silent handover: the operator gets a summary, the partner gets nothing ──
  const silent = {
    kind: "handover_silent",
    replyText: null,
    internalNote: "[Внутренняя переписка]\nПартнёр написал в закрытый чат.",
    action: null,
    approvalChoice: "approved",
    fieldUpdates: null,
    nextStage: "escalated"
  };
  r = await run({ db: { [KEY]: state({ stage: "closed", pendingOutcome: silent }) } });
  t.check("silent handover sends no text to the partner",
    r.posts.every(p => !p.body.channel), r.posts.map(p => p.body));
  t.check("silent handover still advances the step",
    r.posts.some(p => p.body.approval_choice === "approved"), r.posts.map(p => p.body));
  t.check("botHasReplied stays false when the partner heard nothing",
    r.state.botHasReplied === false, r.state.botHasReplied);

  // ── A reply the partner cannot receive must not look like a delivered one ──
  // `body.channel` is what carries a comment out of Pyrus. Without it the comment stays in
  // the internal correspondence and Pyrus still answers 200, so the stage advanced and the
  // bot believed it had asked a question the partner never saw — reading his next message as
  // the answer to it. The only silent failure left in the project.
  r = await run({
    db: {
      [KEY]: state({
        pendingOutcome: clarify,
        data: { unitFullName: "[dodopizza.ru] Тамбов-1" },
        // No outboundChannel in the runtime, and no channel to derive one from in the thread.
        runtime: { apiUrl: runtime.apiUrl, token: "t", incomingCommentId: "42", isFirstBotReply: false, unitFieldId: 97 }
      })
    },
    onGet: threadWith([{ id: 42, author: PARTNER, text: "Не печатает чек" }])
  });
  t.check("nothing is sent to the partner when there is no way to reach him",
    r.posts.every(p => p.body.channel === undefined), r.posts.map(p => p.body));
  t.check("the operator is told, and gets the text the bot meant to send",
    r.posts.some(p => /нет канала связи/.test(p.body.text || "") && /о какой точке/i.test(p.body.text || "")),
    r.posts.map(p => p.body.text));
  t.check("the turn becomes a handover instead of a delivered answer",
    r.state.stage === "escalated" && r.result.kind === "escalated", { stage: r.state.stage, kind: r.result.kind });
  t.check("and the bot is not recorded as having spoken to the partner",
    r.state.botHasReplied === false, r.state.botHasReplied);
  t.check("the Pyrus fields are still filled on the way out",
    r.posts.some(p => Array.isArray(p.body.field_updates) && p.body.field_updates.length === 1),
    r.posts.map(p => p.body.field_updates));

  // ── Closing the dialog ──
  const solved = {
    kind: "solved",
    replyText: "Рад, что всё заработало!",
    internalNote: null,
    action: "finished",
    approvalChoice: null,
    // Old in-flight shape: no approval yet and a stale incomplete ready-made array.
    fieldUpdates: [{ id: 5, value: { item_name: "старое значение" } }],
    nextStage: "closed"
  };
  r = await run({ db: { [KEY]: state({
    pendingOutcome: solved,
    data: { unitFullName: "[dodopizza.ru] Тамбов-1", componentName: "Касса" },
    runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
  }) } });
  t.check("closing uses action finished", r.posts[0].body.action === "finished", r.posts[0].body);
  t.check("closing approves the workflow step in the same request",
    r.posts[0].body.approval_choice === "approved", r.posts[0].body);
  t.check("a stale fieldUpdates array is replaced with both current required fields",
    Array.isArray(r.posts[0].body.field_updates) && r.posts[0].body.field_updates.length === 2 &&
    r.posts[0].body.field_updates.every(x => x.id === 97 || x.id === 36), r.posts[0].body);
  t.check("stage becomes closed", r.state.stage === "closed", r.state);

  // Missing classification is never allowed to disappear behind `action: finished`.
  // The safe fallback is an approved handover: the task stays open for the operator.
  r = await run({ db: { [KEY]: state({
    pendingOutcome: solved,
    data: { componentName: "Касса" },
    runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
  }) } });
  const missingUnitPost = r.posts[r.posts.length - 1].body;
  t.check("missing unit blocks close and hands the task over",
    missingUnitPost.action === undefined && missingUnitPost.approval_choice === "approved" &&
    r.state.stage === "escalated", { post: missingUnitPost, stage: r.state.stage });
  t.check("the partner is not falsely told that an unclassified task was closed",
    /Рад, что всё заработало/.test(missingUnitPost.text || "") &&
    !/Понадобится время/.test(missingUnitPost.text || ""), missingUnitPost);

  r = await run({ db: { [KEY]: state({
    pendingOutcome: solved,
    data: { unitFullName: "[dodopizza.ru] Тамбов-1" },
    runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
  }) } });
  const missingComponentPost = r.posts[r.posts.length - 1].body;
  t.check("missing component blocks close too",
    missingComponentPost.action === undefined && missingComponentPost.approval_choice === "approved" &&
    r.state.stage === "escalated", { post: missingComponentPost, stage: r.state.stage });
  t.check("a solved issue keeps its farewell even when only classification goes to the operator",
    /Рад, что всё заработало/.test(missingComponentPost.text || "") &&
    !/Понадобится время/.test(missingComponentPost.text || ""), missingComponentPost);

  const decidedSolvedWithoutComponent = makeEnv({
    prev: { taskId: "11613", status: "resolved", reason: "партнёр подтвердил решение" },
    db: { [KEY]: state({
      pendingOutcome: null,
      data: { unitFullName: "[dodopizza.ru] Тамбов-1" },
      runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
    }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(decidedSolvedWithoutComponent, ["solved", null]);
  t.check("applyOutcome answers a confirmed solution with the solved acknowledgement",
    decidedSolvedWithoutComponent.db[KEY].pendingOutcome.kind === "escalated" &&
    /Рад был помочь/.test(decidedSolvedWithoutComponent.db[KEY].pendingOutcome.replyText || "") &&
    !/Понадобится время/.test(decidedSolvedWithoutComponent.db[KEY].pendingOutcome.replyText || ""),
    decidedSolvedWithoutComponent.db[KEY].pendingOutcome);

  r = await run({ db: { [KEY]: state({
    pendingOutcome: solved,
    data: { unitFullName: "[dodopizza.ru] Тамбов-1", componentName: "Касса" },
    runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: null })
  }) } });
  const missingFieldPost = r.posts[r.posts.length - 1].body;
  t.check("an unresolved Pyrus field id also blocks close",
    missingFieldPost.action === undefined && missingFieldPost.approval_choice === "approved" &&
    r.state.stage === "escalated", { post: missingFieldPost, stage: r.state.stage });

  // ── Field updates are rebuilt here, not carried in the document ──
  // Carried as a ready array they sat INSIDE the value of a $set, which the db adapter
  // cannot convert — so applyOutcome's write silently took the whole-document rescue path.
  // They are derived from facts this document already holds, so a boolean is enough.
  r = await run({
    db: {
      [KEY]: state({
        pendingOutcome: { kind: "solved", replyText: "Готово", action: "finished", withFieldUpdates: true, nextStage: "closed" },
        data: { unitFullName: "[dodopizza.ru] Тамбов-1", componentName: "Касса" },
        runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
      })
    }
  });
  const fu = r.posts[0].body.field_updates || [];
  t.check("unit and component are rebuilt from the document", fu.length === 2, fu);
  t.check("a current close is approved as well as finished",
    r.posts[0].body.approval_choice === "approved" && r.posts[0].body.action === "finished", r.posts[0].body);
  t.check("the unit goes into the field receiveWebhook found",
    fu[0].id === 97 && fu[0].value.item_name === "[dodopizza.ru] Тамбов-1", fu[0]);
  t.check("the component goes into its own field",
    fu[1].id === 36 && fu[1].value.item_name === "Касса", fu[1]);

  // Nothing to put in them: an empty field_updates must not be sent at all.
  r = await run({
    db: {
      [KEY]: state({
        pendingOutcome: { kind: "escalated", replyText: "Передаю специалисту", approvalChoice: "approved", withFieldUpdates: true, nextStage: "escalated" },
        data: {},
        runtime: Object.assign({}, runtime, { unitFieldId: 97, componentFieldId: 36 })
      })
    }
  });
  t.check("no known unit means no field_updates key at all",
    r.posts[0].body.field_updates === undefined, r.posts[0].body);

  // ── The summary reaches the operator once, not once per repeat of the turn ──
  // It is posted before the reply, and the reply may fail — which keeps pendingOutcome so
  // the turn is repeated. The repeat used to post the summary a second time.
  const escalatedAgain = {
    kind: "escalated",
    replyText: "Передаю обращение специалисту.",
    internalNote: "[Внутренняя переписка]\nБот передаёт обращение оператору.",
    action: null,
    approvalChoice: "approved",
    withFieldUpdates: false,
    nextStage: "escalated"
  };
  let env = makeEnv({
    prev: { taskId: "11613" }, onGet: UNCHANGED, failPost: true,
    db: { [KEY]: state({ pendingOutcome: escalatedAgain }) }
  });
  await finalize(env);
  const afterFail = env.posts.length;
  t.check("the summary goes out on the first attempt",
    afterFail === 2 && /Внутренняя переписка/.test(env.posts[0].body.text), env.posts.map(p => p.body));
  t.check("and the fact is recorded so a repeat can see it",
    env.db[KEY].internalNotePostedFor === "42", env.db[KEY].internalNotePostedFor);

  // The very same document, the very same comment: the turn runs again, this time Pyrus
  // accepts the reply.
  const retry = makeEnv({ prev: { taskId: "11613" }, onGet: UNCHANGED, db: env.db });
  await finalize(retry);
  t.check("the repeat does not send the operator a second copy",
    retry.posts.length === 1 && !/Внутренняя переписка/.test(retry.posts[0].body.text),
    retry.posts.map(p => p.body));
  t.check("and the partner does get the answer on the repeat",
    /специалисту/.test(retry.posts[0].body.text), retry.posts[0].body);

  // ── The write touches only the paths finalize owns ──
  // A full rewrite put back the facts as they were when this run started, undoing what
  // the agents of a concurrent turn had collected in the meantime.
  r = await run({
    db: {
      [KEY]: state({
        pendingOutcome: clarify,
        data: { unitFullName: "[dodopizza.ru] Тамбов-1", problemSummary: "не печатает чек" }
      })
    }
  });
  // Filtering on `documentKey` matched nothing, reported count 0 and threw nothing, so the
  // whole turn was written into the void: the partner's answer was prepared, lost, and the
  // chat handed to an operator as if the bot had decided nothing. `key` misses just as
  // silently — the platform matches filters against the contents of `value`, and the
  // document key is not part of it.
  t.check("the write is aimed at a field inside the document, not at its key",
    r.updates[0].filters.taskId === 11613 &&
    r.updates[0].filters.key === undefined && r.updates[0].filters.documentKey === undefined,
    r.updates[0].filters);
  t.check("a point write that finds its document needs no whole-document rescue",
    r.state.pendingOutcome === null && r.puts.length === 0, [r.state.pendingOutcome, r.puts.length]);

  const paths = Object.keys(r.updates[0].operator.$set).sort().join(",");
  // `runtime.token` is among them: the turn is over and the secret has no reason to outlive
  // it in the document. Note it is a dotted path — the rest of `runtime` is untouched.
  t.check("only own paths are written",
    paths === "botHasReplied,lastProcessedCommentId,pendingOutcome,runtime.token,stage,updatedAt",
    paths);
  t.check("the token does not outlive the turn in the document",
    r.state.runtime.token === null && r.state.runtime.apiUrl === runtime.apiUrl, r.state.runtime);
  t.check("facts collected during the turn survive the stage write",
    r.state.data.problemSummary === "не печатает чек" &&
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1", r.state.data);

  // ── The chain that once broke in production ──
  // applyOutcome decided a clarifying question, the write silently matched no document,
  // and finalize found no outcome: the partner was greeted with «мы вернёмся с ответом»
  // and the chat went to a human. Both halves passed their own tests.
  const decided = makeEnv({
    prev: { taskId: "11613" },
    db: { [KEY]: state({ stage: "intake", pendingOutcome: null }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(decided, ["clarify", "Подскажите, о какой точке идёт речь?"]);
  t.check("the decision reaches the document",
    !!decided.db[KEY].pendingOutcome && decided.db[KEY].pendingOutcome.kind === "clarify",
    decided.db[KEY]);
  t.check("and it gets there through the point write, with no rescue needed",
    decided.puts.length === 0, decided.puts);

  const enriched = makeEnv({
    prev: {
      taskId: "11613",
      reason: "подходящей тематики нет",
      operatorKnowledge: {
        articles: [{
          title: "Закрытие кассовой смены",
          spaceTitle: "Техподдержка",
          excerpt: "Порядок действий при ошибке закрытия смены.",
          url: "https://kb.example/article/space-tech/article-1"
        }]
      }
    },
    db: { [KEY]: state({
      stage: "routing",
      pendingOutcome: null,
      data: { problemSummary: "не закрывается смена" }
    }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(enriched, ["escalated", null]);
  const enrichedNote = enriched.db[KEY].pendingOutcome.internalNote;
  t.check("general knowledge search is appended only to the operator summary",
    /Возможные материалы/.test(enrichedNote) &&
    /не отправлялись партнёру автоматически/.test(enrichedNote) &&
    /Закрытие кассовой смены/.test(enrichedNote) &&
    /https:\/\/kb\.example/.test(enrichedNote), enrichedNote);
  t.check("operator hints never become the partner reply",
    !/Закрытие кассовой смены/.test(enriched.db[KEY].pendingOutcome.replyText || ""),
    enriched.db[KEY].pendingOutcome);

  r = await run({ db: decided.db });
  t.check("the partner is asked what the bot decided to ask",
    /о какой точке/i.test(r.posts[0].body.text), r.posts[0].body);
  t.check("and the chat is not handed to a human",
    r.posts[0].body.approval_choice !== "approved", r.posts[0].body);
  t.check("the stage follows the decision", r.state.stage === "gathering", r.state);

  // ── A question asked by the article comes back to the article ──
  // The same reason `clarify_email` exists. Sent as a plain clarify, the answer landed in
  // `gathering` and travelled intake → routing → solver again.
  const asked = makeEnv({
    prev: { taskId: "11613", agentStage: "solver", kind: "questions", replyText: "На какое значение поменять?" },
    db: { [KEY]: state({ stage: "awaiting_answers", pendingOutcome: null, data: { topicKey: "employee_change" } }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(asked, ["clarify_answers", null]);
  t.check("the article's question waits on its own stage",
    asked.db[KEY].pendingOutcome.nextStage === "awaiting_answers", asked.db[KEY].pendingOutcome);
  t.check("and the question the solver wrote is what the partner is asked",
    /На какое значение/.test(asked.db[KEY].pendingOutcome.replyText), asked.db[KEY].pendingOutcome.replyText);
  const concise = makeEnv({
    prev: {
      taskId: "11613", agentStage: "solver", kind: "questions",
      replyText: "Пожалуйста, уточните: касса ресторана или доставки? Без этой информации не получится подобрать правильное решение."
    },
    db: { [KEY]: state({ stage: "awaiting_answers", pendingOutcome: null, data: { topicKey: "employee_change" } }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(concise, ["clarify_answers", null]);
  t.check("generic pressure after an article question is removed",
    concise.db[KEY].pendingOutcome.replyText === "Касса ресторана или доставки?",
    concise.db[KEY].pendingOutcome.replyText);
  // Exempting it from the loop guards would be exempting the one path that asks the most.
  t.check("it still counts towards the loop guard", asked.db[KEY].clarifyStreak === 1, asked.db[KEY].clarifyStreak);

  // Three of them in a row without the article moving on is still a handover.
  const looping = makeEnv({
    prev: { taskId: "11613", agentStage: "solver", kind: "questions", replyText: "И ещё раз?" },
    db: { [KEY]: state({ stage: "awaiting_answers", pendingOutcome: null, clarifyStreak: 3, data: { topicKey: "employee_change" } }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(looping, ["clarify_answers", null]);
  t.check("a looping article is handed to an operator",
    looping.db[KEY].pendingOutcome.kind === "escalated" &&
    looping.db[KEY].pendingOutcome.nextStage === "escalated", looping.db[KEY].pendingOutcome);

  // ── The full round trip of an article's question ──
  // Three functions and two webhooks: the solver asks, finalize delivers and records the
  // stage, and the NEXT webhook has to read that stage back and return to the solver. Each
  // half passes its own tests in isolation; this is the seam where a stage that nobody reads
  // back would look perfectly healthy — the same class of defect as the point write that
  // matched no document while both halves were green.
  const round = makeEnv({
    prev: { taskId: "11613", agentStage: "solver", kind: "questions", replyText: "На какое значение поменять?" },
    db: { [KEY]: state({ stage: "gathering", pendingOutcome: null, data: { topicKey: "employee_change", unitFullName: "Москва 12" } }) },
    contextValues: { dialog: { taskId: "11613" } }
  });
  await applyOutcome(round, ["clarify_answers", null]);

  const delivering = makeEnv({ prev: { taskId: "11613" }, onGet: UNCHANGED, payload: ownPayload(42), db: round.db });
  const delivered = await finalize(delivering);
  t.check("the article's question is delivered to the partner",
    delivered.success === true && /На какое значение/.test(delivering.posts[0].body.text), delivering.posts.map(p => p.body));
  t.check("and the stage recorded is the article's own",
    delivering.db[KEY].stage === "awaiting_answers", delivering.db[KEY].stage);

  // The partner answers. A fresh webhook, the same task document.
  const answering = makeEnv({
    payload: {
      task_id: 11613, event: "comment", access_token: "t", api_url: "https://api.pyrus.com/v4/",
      task: { id: 11613, form_id: 77, fields: [], comments: [{ id: 77, author: PARTNER, text: "фамилию", channel: CHAN }] }
    },
    db: delivering.db
  });
  const back = await receiveWebhook(answering);
  t.check("the answer goes back to the solver, not through intake",
    back.stage === "awaiting_answers" && back.skip === false, back);
  t.check("and the decision of the previous turn is not lying in wait",
    answering.db[KEY].pendingOutcome === null, answering.db[KEY].pendingOutcome);

  // ── Nothing decided: the partner must never be left unanswered ──
  r = await run({ db: { [KEY]: state({ stage: "intake", pendingOutcome: null }) } });
  t.check("missing outcome still answers the partner", r.posts.length === 1 && !!r.posts[0].body.text, r.posts);
  t.check("missing outcome hands over to a human", r.posts[0].body.approval_choice === "approved", r.posts[0].body);
  t.check("missing outcome escalates the stage", r.state.stage === "escalated", r.state);

  // ── Degenerate input ──
  r = await run({ prev: {}, db: {} });
  t.check("no taskId: nothing is posted", r.posts.length === 0 && r.result.success === false, r.result);

  r = await run({ db: { [KEY]: { stage: "intake", runtime: { apiUrl: runtime.apiUrl }, pendingOutcome: clarify } } });
  t.check("no token: fails loudly instead of guessing",
    r.result.success === false && /token/.test(r.result.reason), r.result);
  t.check("no token: stage untouched", r.state.stage === "intake", r.state);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
