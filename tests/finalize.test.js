// Tests for ID_Pyrus.finalize — the only place that writes to Pyrus. Two invariants
// matter most and both were once broken:
//   1. the stage moves only after the partner has actually been told something;
//   2. of two racing runs only the one holding the newest message speaks.
const { loadFunction, makeEnv, suite } = require("./harness");

const finalize = loadFunction("functions/ID_Pyrus/finalize/code.js");
// The decision and its delivery are two functions and two documents apart, so the
// handover of state between them is tested end to end.
const applyOutcome = loadFunction("functions/ID_Actions/applyOutcome/code.js", ["outcome", "replyText"]);

const BOT = { id: 1314929, name: "Бот" };
const PARTNER = { id: 555, name: "Партнёр" };
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

function state(extra) {
  return Object.assign({ stage: "awaiting_confirmation", runtime: runtime }, extra || {});
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

  // ── Closing the dialog ──
  const solved = {
    kind: "solved",
    replyText: "Рад, что всё заработало!",
    internalNote: null,
    action: "finished",
    approvalChoice: null,
    fieldUpdates: [{ id: 5, value: { item_name: "Москва 12" } }],
    nextStage: "closed"
  };
  r = await run({ db: { [KEY]: state({ pendingOutcome: solved }) } });
  t.check("closing uses action finished", r.posts[0].body.action === "finished", r.posts[0].body);
  t.check("field updates are sent with it",
    Array.isArray(r.posts[0].body.field_updates) && r.posts[0].body.field_updates.length === 1, r.posts[0].body);
  t.check("stage becomes closed", r.state.stage === "closed", r.state);

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
  // The document field holding the key is `key`; `documentKey` is only the argument name
  // of Db.get/Db.put. Filtering on it matched nothing, reported count 0 and threw nothing,
  // so the whole turn was written into the void: the partner's answer was prepared, lost,
  // and the chat handed to an operator as if the bot had decided nothing.
  t.check("the filter addresses the stored key field",
    r.updates[0].filters.key === KEY && r.updates[0].filters.documentKey === undefined,
    r.updates[0].filters);
  t.check("a point write that hits its document needs no whole-document rescue",
    r.puts.length === 0, r.puts);

  const paths = Object.keys(r.updates[0].operator.$set).sort().join(",");
  t.check("only own paths are written",
    paths === "value.botHasReplied,value.lastProcessedCommentId,value.pendingOutcome,value.stage,value.updatedAt",
    paths);
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
  t.check("the decision is stored without a whole-document rescue", decided.puts.length === 0, decided.puts);

  r = await run({ db: decided.db });
  t.check("the partner is asked what the bot decided to ask",
    /о какой точке/i.test(r.posts[0].body.text), r.posts[0].body);
  t.check("and the chat is not handed to a human",
    r.posts[0].body.approval_choice !== "approved", r.posts[0].body);
  t.check("the stage follows the decision", r.state.stage === "gathering", r.state);

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
