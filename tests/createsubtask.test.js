// Tests for ID_Actions.createSubtask. The contract is deliberately stricter than
// «POST /tasks returned an id»: exactly one run may create a task, and the parent chat is
// closed only after Pyrus confirms its native parent_task_id relation.
const { loadFunction, makeEnv, suite } = require("./harness");
const { loadGraph, runTurn } = require("./graph");

const createSubtask = loadFunction("functions/ID_Actions/createSubtask/code.js", []);
const GRAPH = loadGraph();

const KEY = "state:11613";
const REQUEST_KEY = "11613:71";
const facts = {
  unitFullName: "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
  componentName: "Доступы",
  email: "p@x.ru",
  problemSummary: "нужен доступ к отчётам",
  topicKey: "access_request"
};

function state(over) {
  return Object.assign({
    stage: "awaiting_email",
    data: Object.assign({}, facts),
    runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t", role: "chat", incomingCommentId: 71 },
    subtaskId: null,
    subtaskIntegrity: null,
    subtaskRequestKey: REQUEST_KEY,
    subtaskClaim: null,
    subtaskClaimAt: null,
    taskId: 11613
  }, over || {});
}

const CONFIG = { subtaskFormId: 2454249, subtaskClaimTtlMs: 120000 };

// Live-like form shape. A copied form renumbers all of these fields, so production code
// resolves exact names and never assumes the ids of another form.
const FORM_FIELDS = [
  { id: 1, type: "note", name: "ㅤ" },
  { id: 2, type: "note", name: "❗Инструкция по работе с задачами❗" },
  { id: 4, type: "title", name: "Системные поля", fields: [
    { id: 5, type: "status", name: "Открыта / Завершена" },
    { id: 9, type: "number", name: "Id задачи из КЦ" }
  ] },
  { id: 25, type: "catalog", name: "Тема обращения" },
  { id: 26, type: "text", name: "Тема обращения (вручную)" },
  { id: 28, type: "catalog", name: "Компонент" },
  { id: 35, type: "catalog", name: "Юнит" },
  { id: 41, type: "title", name: "Контактная информация", fields: [
    { id: 44, type: "email", name: "Эл. почта" }
  ] },
  { id: 46, type: "title", name: "Входные данные", fields: [
    { id: 47, type: "text", name: "Тема" },
    { id: 48, type: "text", name: "Сообщение" }
  ] }
];
const UNIT = 35, COMPONENT = 28, EMAIL = 44, SUBJECT = 47, MESSAGE = 48;
const CREATED = { body: { task: { id: 90001, form_id: 2454249, parent_task_id: 11613 } } };

function messageWithMarker(text) {
  return [{ id: MESSAGE, value: String(text || "Сводка") + "\n\nИдентификатор обращения ИИ: " + REQUEST_KEY }];
}

function defaultGet(o, a) {
  if (/\/forms\/2454249$/.test(a.url)) {
    return o.formFields === null ? { body: {} } : { body: { fields: o.formFields || FORM_FIELDS } };
  }
  if (/\/tasks\/11613$/.test(a.url)) {
    return { body: { task: o.parentTask || { id: 11613, linked_task_ids: [] } } };
  }
  const child = /\/tasks\/(\d+)$/.exec(a.url);
  if (child) {
    const id = Number(child[1]);
    return { body: { task: o.childTask || {
      id: id, form_id: 2454249, parent_task_id: 11613, fields: messageWithMarker()
    } } };
  }
  return { body: {} };
}

function buildEnv(options) {
  const o = options || {};
  return makeEnv({
    prev: { taskId: "11613" },
    payload: { access_token: "t" },
    db: Object.assign({
      config: o.config === null ? undefined : (o.config || CONFIG),
      [KEY]: state(o.state)
    }, o.db),
    contextValues: { dialog: { taskId: "11613" } },
    onGet: a => {
      if (o.onGet) {
        const answer = o.onGet(a);
        if (answer !== undefined) return answer;
      }
      return defaultGet(o, a);
    },
    onPost: o.onPost || (a => (/\/tasks$/.test(a.url) ? CREATED : { body: {} })),
    failPostWhen: o.failPostWhen
  });
}

async function run(options) {
  const env = buildEnv(options);
  const result = await createSubtask(env);
  return { result, state: env.db[KEY], posts: env.posts, gets: env.gets, env };
}

const created = posts => posts.filter(p => /\/tasks$/.test(p.url));

async function main() {
  const t = suite("createSubtask");

  let r = await run({ state: { subtaskId: 90001, subtaskIntegrity: "complete" } });
  t.check("a completed local subtask short-circuits a redelivery",
    r.result.duplicate === true && r.result.subtaskId === 90001, r.result);
  t.check("the completed redelivery makes no Pyrus request", r.posts.length === 0 && r.gets.length === 0,
    { posts: r.posts, gets: r.gets });

  r = await run({ state: { subtaskId: 90002, subtaskIntegrity: "unconfirmed_parent" } });
  t.check("an incomplete stored id is promoted only after native-link verification",
    r.result.success === true && r.result.recovered === true && r.state.subtaskIntegrity === "complete", r.result);
  t.check("verification reads that exact child and creates nothing",
    r.gets.some(g => /tasks\/90002$/.test(g.url)) && created(r.posts).length === 0, r.gets);

  r = await run({
    state: { subtaskId: 90002, subtaskIntegrity: "unconfirmed_parent" },
    childTask: { id: 90002, form_id: 2454249, parent_task_id: 777, fields: messageWithMarker() }
  });
  t.check("an id linked to another parent blocks duplication and parent closing",
    r.result.success === false && r.result.duplicateBlocked === true && created(r.posts).length === 0, r.result);

  r = await run({ state: { runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t", role: "ticket" } } });
  t.check("a ticket does not get a subtask of its own", r.result.success === false, r.result);
  t.check("ticket refusal is not an email clarification", r.result.action !== "clarify", r.result);
  t.check("ticket refusal reaches neither Pyrus endpoint", r.posts.length === 0 && r.gets.length === 0,
    { posts: r.posts, gets: r.gets });

  // No parent-link field exists or is needed. Native parent_task_id is part of the same
  // atomic Pyrus request that creates the subtask.
  r = await run({ config: { subtaskFormId: 2454249 } });
  t.check("no custom parent field is required", r.result.success === true, r.result);
  const create = created(r.posts)[0];
  t.check("creation carries the native parent_task_id", create.body.parent_task_id === 11613, create.body);
  t.check("there is no second field-update request for linkage",
    r.posts.length === 1 && !r.posts.some(p => p.body && p.body.field_updates), r.posts);
  t.check("confirmed native linkage is persisted and ownership stays through parent finalization",
    r.state.subtaskId === 90001 && r.state.subtaskIntegrity === "complete" &&
    typeof r.state.subtaskClaim === "string", r.state);

  const field = id => (create.body.fields.find(f => Number(f.id) === id) || {}).value;
  t.check("field ids are resolved from this form",
    create.body.fields.map(f => Number(f.id)).sort((a, b) => a - b).join(",") ===
      [UNIT, COMPONENT, EMAIL, SUBJECT, MESSAGE].sort((a, b) => a - b).join(","), create.body.fields);
  t.check("exact «Тема» wins over adjacent similarly named fields",
    !!field(SUBJECT) && !create.body.fields.some(f => Number(f.id) === 25 || Number(f.id) === 26), create.body.fields);
  t.check("the mandatory message carries the problem and recovery marker without duplicating form fields",
    /Суть: нужен доступ к отчётам/.test(field(MESSAGE)) &&
    !/Юнит:|Email:|Компонент:|Родительская задача:/.test(field(MESSAGE)) &&
    field(MESSAGE).includes("Идентификатор обращения ИИ: " + REQUEST_KEY), field(MESSAGE));

  r = await run({
    state: { data: Object.assign({}, facts, {
      topicKey: "ratings_questions",
      componentName: "Стандарты|Маркетинг → Контроллинг → Рейтинг стандартов",
      treeNode: "standardsCollect",
      treeAnswers: {
        ratingKind: "Рейтинг стандартов",
        expectedResult: "Пересмотреть снятые баллы"
      }
    }) },
    db: { knowledge_catalog: { topics: [{
      key: "ratings_questions",
      description: "Вопросы по рейтингам",
      nodes: {
        ratingKindFirst: { ask: [{
          key: "ratingKind", label: "Вид рейтинга",
          includeInSubtaskSummary: false, question: "Какой рейтинг?"
        }] },
        standardsCollect: { ask: [{
          key: "expectedResult", label: "Ожидаемый результат и детали",
          question: "Какой результат ожидаете?"
        }] }
      }
    }] } }
  });
  const ratingsCreate = created(r.posts)[0];
  const ratingsMessage = ratingsCreate.body.fields.find(f => Number(f.id) === MESSAGE).value;
  t.check("an article can hide a routing answer already represented by a form field",
    !/Вид рейтинга/.test(ratingsMessage) &&
    /Ожидаемый результат и детали: Пересмотреть снятые баллы/.test(ratingsMessage),
    ratingsMessage);
  t.check("no correspondence or foreign workflow action is posted",
    !r.posts.some(p => p.body && (p.body.text || p.body.action)), r.posts);
  const postsAfterCreate = r.posts.length;
  const gapRun = await createSubtask(r.env);
  t.check("a delivery arriving after creation but before parent finalization stays silent",
    gapRun.skip === true && r.posts.length === postsAfterCreate, gapRun);

  // Both executions read the same old state before their async form request completes.
  // The database compare-and-set, not timing, must still allow exactly one POST /tasks.
  const concurrentEnv = buildEnv({});
  const pair = await Promise.all([createSubtask(concurrentEnv), createSubtask(concurrentEnv)]);
  t.check("two simultaneous runs create exactly one subtask", created(concurrentEnv.posts).length === 1,
    { results: pair, posts: concurrentEnv.posts });
  t.check("the losing run is a silent deferral, not an escalation",
    pair.filter(x => x && x.success === true).length === 1 &&
    pair.filter(x => x && x.skip === true && x.deferred === true).length === 1, pair);

  r = await run({ state: { subtaskClaim: "other", subtaskClaimAt: Date.now() } });
  t.check("a fresh foreign claim defers silently", r.result.skip === true && r.result.deferred === true, r.result);
  t.check("a fresh foreign claim creates nothing", created(r.posts).length === 0, r.posts);

  const deferredEnv = buildEnv({ state: { subtaskClaim: "other", subtaskClaimAt: Date.now() } });
  const deferredTrace = await runTurn(GRAPH, deferredEnv, "func_createsubtask_v5r8k", {});
  t.check("the real graph sends an atomic-claim loser straight to a no-op finalize",
    deferredTrace.some(x => x.id === "cond_subtask_deferred" && x.value === true) &&
    !deferredTrace.some(x => x.id === "func_escalate_m9k4j") && deferredEnv.posts.length === 0,
    deferredTrace);

  r = await run({
    state: { subtaskClaim: "old", subtaskClaimAt: Date.now() - 300000 },
    parentTask: { id: 11613, linked_task_ids: [90011] },
    childTask: { id: 90011, form_id: 2454249, parent_task_id: 11613, fields: messageWithMarker("Уже создано") }
  });
  t.check("a stale claim recovers the matching native child instead of recreating it",
    r.result.recovered === true && r.result.subtaskId === 90011 && created(r.posts).length === 0, r.result);
  t.check("recovery stores complete integrity", r.state.subtaskIntegrity === "complete" && r.state.subtaskId === 90011, r.state);

  r = await run({
    state: { subtaskClaim: "old", subtaskClaimAt: Date.now() - 300000 },
    onGet: a => { if (/tasks\/11613$/.test(a.url)) throw new Error("pyrus 500"); }
  });
  t.check("a failed recovery never takes over a stale claim",
    r.result.success === false && !r.result.skip && created(r.posts).length === 0, r.result);

  r = await run({
    state: { subtaskClaim: "old", subtaskClaimAt: Date.now() - 300000 },
    parentTask: { id: 11613, linked_task_ids: [] }
  });
  t.check("an expired claim with no visible child still never creates a second task",
    r.result.success === false && r.result.duplicateBlocked === true && created(r.posts).length === 0,
    r.result);

  // A 500 can mean «created, response lost». There must be no blind second POST.
  r = await run({
    onPost: a => { if (/\/tasks$/.test(a.url)) throw new Error("pyrus 500 after accept"); return { body: {} }; },
    parentTask: { id: 11613, linked_task_ids: [] }
  });
  t.check("an ambiguous 5xx is not retried blindly", created(r.posts).length === 1, r.posts);
  t.check("an unrecovered ambiguous response leaves an uncertainty claim",
    r.result.success === false && r.result.uncertain === true && r.state.subtaskIntegrity === "uncertain_response" &&
    !!r.state.subtaskClaim, { result: r.result, state: r.state });

  const uncertainState = r.state;
  r = await run({ state: uncertainState });
  t.check("a redelivery during the uncertainty window does not create again",
    r.result.skip === true && created(r.posts).length === 0, r.result);

  r = await run({
    onPost: a => { if (/\/tasks$/.test(a.url)) throw new Error("pyrus 500 after accept"); return { body: {} }; },
    parentTask: { id: 11613, linked_task_ids: [90012] },
    childTask: { id: 90012, form_id: 2454249, parent_task_id: 11613, fields: messageWithMarker("Принято") }
  });
  t.check("a lost HTTP response is recovered through native linked_task_ids and the marker",
    r.result.success === true && r.result.recovered === true && r.result.subtaskId === 90012, r.result);
  t.check("recovered acceptance still issued only one create request", created(r.posts).length === 1, r.posts);

  // An explicit 400 proves the first request was rejected, so dropping only the optional
  // subject is a safe and useful retry.
  let attempt = 0;
  r = await run({
    onPost: a => {
      if (!/\/tasks$/.test(a.url)) return { body: {} };
      attempt++;
      if (attempt === 1) { const e = new Error("pyrus 400"); e.status = 400; throw e; }
      return CREATED;
    }
  });
  t.check("an explicit 400 retries once without only the optional subject", created(r.posts).length === 2,
    r.posts);
  t.check("the safe retry retains all mandatory fields",
    created(r.posts)[1].body.fields.map(f => Number(f.id)).sort((a, b) => a - b).join(",") ===
      [UNIT, COMPONENT, EMAIL, MESSAGE].sort((a, b) => a - b).join(","), created(r.posts)[1].body.fields);
  t.check("the accepted safe retry completes normally", r.result.success === true, r.result);

  r = await run({
    onPost: a => { if (/\/tasks$/.test(a.url)) { const e = new Error("pyrus 400"); e.status = 400; throw e; } return { body: {} }; }
  });
  t.check("two explicit rejections leave no subtask", r.result.success === false && !r.state.subtaskId, r.result);
  t.check("a definitive rejection releases the claim for a corrected later attempt",
    r.state.subtaskClaim === null && r.state.subtaskIntegrity === null, r.state);

  r = await run({ onPost: a => (/\/tasks$/.test(a.url) ? { body: { task: { id: 90001 } } } : { body: {} }) });
  t.check("a sparse create response is verified with one child GET",
    r.result.success === true && r.gets.some(g => /tasks\/90001$/.test(g.url)), { result: r.result, gets: r.gets });

  r = await run({
    onPost: a => (/\/tasks$/.test(a.url)
      ? { body: { task: { id: 90001, form_id: 2454249, parent_task_id: 777 } } }
      : { body: {} }),
    childTask: { id: 90001, form_id: 2454249, parent_task_id: 777, fields: messageWithMarker() }
  });
  t.check("an unconfirmed native parent relation never closes the chat",
    r.result.success === false && r.result.subtaskId === 90001 && r.state.subtaskIntegrity === "unconfirmed_parent", r.result);

  r = await run({ state: { subtaskRequestKey: null } });
  t.check("missing idempotency scope fails closed before creation",
    r.result.success === false && created(r.posts).length === 0, r.result);

  r = await run({ config: { subtaskFormId: 2454249, unitFieldId: 777 } });
  t.check("a field id pinned in config overrides name resolution",
    created(r.posts)[0].body.fields.some(f => Number(f.id) === 777) &&
    !created(r.posts)[0].body.fields.some(f => Number(f.id) === UNIT), created(r.posts)[0].body.fields);

  r = await run({
    formFields: [
      { id: 35, type: "catalog", name: "Юнит" },
      { id: 28, type: "catalog", name: "Компонент" },
      { id: 41, type: "title", name: "Контакты", value: { fields: [{ id: 44, type: "email", name: "Эл. почта" }] } },
      { id: 48, type: "text", name: "Сообщение" }
    ]
  });
  t.check("value.fields nesting is resolved too",
    created(r.posts)[0].body.fields.some(f => Number(f.id) === EMAIL), created(r.posts)[0].body.fields);

  r = await run({ formFields: [
    { id: 35, type: "catalog", name: "Юнит" },
    { id: 28, type: "catalog", name: "Компонент" },
    { id: 44, type: "email", name: "Эл. почта" }
  ] });
  t.check("a form without mandatory «Сообщение» creates nothing",
    r.result.success === false && created(r.posts).length === 0, r.result);

  r = await run({ formFields: [{ id: 1, type: "note", name: "ㅤ" }] });
  t.check("unknown mandatory fields are never guessed",
    r.result.success === false && created(r.posts).length === 0 && /2454249/.test(r.result.reason), r.result);

  r = await run({ formFields: null });
  t.check("an unreadable form definition refuses instead of guessing",
    r.result.success === false && created(r.posts).length === 0, r.result);

  r = await run({ state: { data: { unitFullName: facts.unitFullName, componentName: facts.componentName } } });
  t.check("missing email asks the partner before any Pyrus call",
    r.result.action === "clarify" && created(r.posts).length === 0, r.result);

  r = await run({ state: { data: { email: "p@x.ru" } } });
  t.check("missing unit or component creates nothing",
    r.result.success === false && created(r.posts).length === 0, r.result);

  const noTokenEnv = buildEnv({ state: { runtime: { role: "chat" } } });
  noTokenEnv.Context.getMessageContent = () => ({ payload: {} });
  const noToken = await createSubtask(noTokenEnv);
  t.check("missing token fails loudly instead of guessing",
    noToken.success === false && /token/.test(noToken.reason), noToken);

  r = await run({ onPost: a => (/\/tasks$/.test(a.url) ? { body: {} } : { body: {} }) });
  t.check("a response without task.id is an ambiguous failure, not success",
    r.result.success === false && r.result.uncertain === true && !r.state.subtaskId, r.result);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
