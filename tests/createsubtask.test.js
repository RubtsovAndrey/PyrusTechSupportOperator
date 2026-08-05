// Tests for ID_Actions.createSubtask. The point of interest is that the subtask must
// exist exactly once per problem, and that the database cannot guarantee it: only Pyrus
// itself knows whether the subtask is already there.
const { loadFunction, makeEnv, suite } = require("./harness");

const createSubtask = loadFunction("functions/ID_Actions/createSubtask/code.js", []);

const KEY = "state:11613";
const LINK_FIELD = 12;

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
    runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t" }
  }, over || {});
}

// The subtask form knows which parent chat it belongs to only if that field is configured.
// Field ids are NOT pinned here: they differ from form to form — a copy of the production
// form renumbered every one of them — so they are resolved by name, and that is the path
// worth testing.
const CONFIG = { subtaskFormId: 1096731, parentLinkFieldId: LINK_FIELD };

// ── The real shape of the form, taken from a live payload ──
// Every trap in it is one the bot walked into: on this form 1 and 2 are notes, 5 is the
// «Открыта / Завершена» status, 36 is a title, and 97 does not exist at all — which is what
// the hardcoded 97/36/5/1/2 turned into a 400 on every attempt. «Тема обращения» and «Тема
// обращения (вручную)» sit next to «Тема», so a search by substring picks the wrong one.
const FORM_FIELDS = [
  { id: 1, type: "note", name: "ㅤ" },
  { id: 2, type: "note", name: "❗Инструкция по работе с задачами❗" },
  { id: 4, type: "title", name: "Системные поля", fields: [
    { id: 5, type: "status", name: "Открыта / Завершена" },
    { id: 7, type: "step", name: "Этап" },
    { id: 9, type: "number", name: "Id задачи из КЦ" }
  ] },
  { id: 25, type: "catalog", name: "Тема обращения" },
  { id: 26, type: "text", name: "Тема обращения (вручную)" },
  { id: 28, type: "catalog", name: "Компонент" },
  { id: 35, type: "catalog", name: "Юнит" },
  { id: 36, type: "title", name: "Время юнита", fields: [
    { id: 37, type: "text", name: "Локальное время юнита" }
  ] },
  { id: 41, type: "title", name: "Контактная информация", fields: [
    { id: 42, type: "text", name: "Имя" },
    { id: 44, type: "email", name: "Эл. почта" }
  ] },
  { id: 46, type: "title", name: "Входные данные", fields: [
    { id: 47, type: "text", name: "Тема" },
    { id: 48, type: "text", name: "Сообщение" }
  ] }
];
// What the form resolves to, so the expectations below read as the answer and not as magic.
const UNIT = 35, COMPONENT = 28, EMAIL = 44, SUBJECT = 47, MESSAGE = 48;

const CREATED = { body: { task: { id: 90001 } } };
const emptyRegister = () => ({ body: { tasks: [] } });
const registerWith = id => () => ({ body: { tasks: [{ id: id }] } });

// The same URL prefix serves the register and the form definition, so the stub routes by
// path the way Pyrus does: the register is the longer one and must be matched first.
function router(o) {
  const register = o.onGet || emptyRegister;
  return a => (/\/register/.test(a.url)
    ? register(a)
    : (o.formFields === null ? { body: {} } : { body: { fields: o.formFields || FORM_FIELDS } }));
}

async function run(options) {
  const o = options || {};
  const env = makeEnv({
    prev: { taskId: "11613" },
    db: Object.assign({ config: o.config === null ? undefined : (o.config || CONFIG), [KEY]: state(o.state) }, o.db),
    contextValues: { dialog: { taskId: "11613" } },
    onGet: router(o),
    onPost: o.onPost || (a => (/\/tasks$/.test(a.url) ? CREATED : { body: {} })),
    failPostWhen: o.failPostWhen
  });
  const result = await createSubtask(env);
  return { result, state: env.db[KEY], posts: env.posts, gets: env.gets, env };
}

const created = posts => posts.filter(p => /\/tasks$/.test(p.url));
const fieldUpdates = posts => posts.filter(p => p.body && p.body.field_updates);

async function main() {
  const t = suite("createSubtask");

  // ── Already known locally: a redelivered webhook must not create a second one ──
  let r = await run({ state: { subtaskId: 90001 } });
  t.check("known subtask short-circuits", r.result.duplicate === true && r.result.subtaskId === 90001, r.result);
  t.check("nothing is sent to Pyrus", r.posts.length === 0 && r.gets.length === 0,
    { posts: r.posts.length, gets: r.gets.length });

  // ── A ticket has no subtask to create: the ticket IS the subtask ──
  // The article still routes here, because the catalog describes the problem and knows
  // nothing about the form the dialog lives on. A plain failure is enough: the graph carries
  // `success: false` without `action: "clarify"` through cond_subtask_created and
  // cond_subtask_needs_email straight to the escalation, with no new node.
  r = await run({ state: { runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t", role: "ticket" } } });
  t.check("a ticket does not get a subtask of its own", r.result.success === false, r.result);
  t.check("and nothing at all is sent to Pyrus", r.posts.length === 0 && r.gets.length === 0,
    { posts: r.posts.length, gets: r.gets.length });
  t.check("the reason says why, so the escalation summary is not a mystery",
    /ticket/.test(r.result.reason), r.result.reason);
  // Crucially it must NOT look like «ask the partner for an email», or the graph would ask
  // for an address instead of handing the ticket over.
  t.check("it is not mistaken for a request for the email", r.result.action !== "clarify", r.result);

  // A chat on the very same form still creates its subtask: the role of the task decides,
  // not the form the subtask is created on — during the tests those are the same form.
  r = await run({ state: { runtime: { apiUrl: "https://api.pyrus.com/v4/", token: "t", role: "chat" } } });
  t.check("a chat still creates its subtask", r.result.success === true && created(r.posts).length === 1, r.result);

  // ── The register is asked before creating ──
  // Two concurrent runs both read subtaskId as empty; only Pyrus can settle it.
  r = await run({ onGet: registerWith(90500) });
  t.check("subtask found in the register is adopted",
    r.result.duplicate === true && r.result.subtaskId === 90500, r.result);
  t.check("no second subtask is created", created(r.posts).length === 0, r.posts);
  t.check("the adopted id is written to the document", r.state.subtaskId === 90500, r.state);

  r = await run({});
  t.check("register is queried on the subtask form",
    /forms\/1096731\/register\?/.test(r.gets[0].url), r.gets[0]);
  t.check("filter uses the link field and exact matching",
    /[?&]fld12=eq\.11613(&|$)/.test(r.gets[0].url), r.gets[0].url);
  t.check("empty register means the subtask is created", created(r.posts).length === 1, r.posts);
  t.check("subtask id is returned", r.result.subtaskId === 90001, r.result);
  t.check("subtask id is persisted", r.state.subtaskId === 90001, r.state);

  // ── Without the field configured the check is impossible, not silently wrong ──
  r = await run({ config: { subtaskFormId: 1096731 } });
  // The form definition is still read — that is where the field ids come from — so the
  // question is whether the REGISTER was asked, not whether anything was.
  t.check("no link field: register is not queried",
    !r.gets.some(g => /\/register/.test(g.url)), r.gets.map(g => g.url));
  t.check("no link field: the subtask is still created", created(r.posts).length === 1, r.posts);
  t.check("no link field: nothing is written to it", fieldUpdates(r.posts).length === 0, r.posts);

  // ── A failed lookup must not block the branch ──
  r = await run({ onGet: () => { throw new Error("pyrus 500"); } });
  t.check("failed register lookup still creates the subtask", created(r.posts).length === 1, r.posts);

  // ── The link is written after creation, never inside it ──
  // Inside the creation body a wrong value shape would cost the subtask itself.
  r = await run({});
  const create = created(r.posts)[0];
  t.check("creation body carries no link field",
    !create.body.fields.some(f => Number(f.id) === LINK_FIELD), create.body.fields);
  t.check("link is written as a separate request", fieldUpdates(r.posts).length === 1, r.posts);
  t.check("link points at the parent task",
    JSON.stringify(fieldUpdates(r.posts)[0].body.field_updates[0].value).indexOf("11613") >= 0,
    fieldUpdates(r.posts)[0].body);

  // The shape of a form_link value is not documented among what we have, so the second
  // candidate is tried when Pyrus rejects the first.
  r = await run({
    failPostWhen: a => !!(a.body && a.body.field_updates &&
      typeof a.body.field_updates[0].value === "object")
  });
  t.check("rejected link shape is retried with the other one",
    fieldUpdates(r.posts).length === 2 &&
    fieldUpdates(r.posts)[1].body.field_updates[0].value === 11613, r.posts);
  t.check("a subtask that could not be linked is still a success",
    r.result.success === true, r.result);

  // ── The request itself goes into the form, not into correspondence ──
  // A comment is correspondence; the first line reads «Входные данные».
  r = await run({});
  const field = id => (created(r.posts)[0].body.fields.find(f => Number(f.id) === id) || {}).value;
  // ── The ids are the form's own, found by name ──
  // Hardcoded 97/36/5 were the production form's, and a copy of that form renumbered
  // everything: Pyrus answered 400 to the creation and to the retry without the optional
  // fields, because the mandatory three were wrong too. A field id cannot have a default.
  t.check("field ids are resolved from the form, not assumed",
    created(r.posts)[0].body.fields.map(f => Number(f.id)).sort((a, b) => a - b).join(",") ===
      [UNIT, COMPONENT, EMAIL, SUBJECT, MESSAGE].sort((a, b) => a - b).join(","),
    created(r.posts)[0].body.fields);
  t.check("«Тема» is the input-data field, not «Тема обращения» next to it",
    created(r.posts)[0].body.fields.some(f => Number(f.id) === SUBJECT) &&
    !created(r.posts)[0].body.fields.some(f => Number(f.id) === 25 || Number(f.id) === 26),
    created(r.posts)[0].body.fields);
  t.check("nested fields are found too, not only top-level ones",
    !!field(EMAIL) && !!field(SUBJECT), created(r.posts)[0].body.fields);
  t.check("the summary is a field of the created task", typeof field(MESSAGE) === "string", created(r.posts)[0].body.fields);
  t.check("the summary names the parent task", /№11613/.test(field(MESSAGE)), field(MESSAGE));
  t.check("the summary carries unit, component and email",
    /Тамбов-1/.test(field(MESSAGE)) && /Доступы/.test(field(MESSAGE)) && /p@x\.ru/.test(field(MESSAGE)), field(MESSAGE));
  t.check("the subject line says what the problem is", /отчёт/.test(field(SUBJECT)), field(SUBJECT));
  t.check("and no summary comment is posted at all",
    !r.posts.some(p => p.body && p.body.text), r.posts.map(p => p.body));

  // The bot is only the author of the subtask: step 1 belongs to another approver, and
  // Pyrus answered 400 to every attempt to finish it. Nothing needs finishing — the form's
  // route already carries the subtask to the people who work it.
  t.check("the bot does not try to complete a step that is not its own",
    !r.posts.some(p => p.body && p.body.action), r.posts.map(p => p.body));

  // A rejected optional field must cost the description, never the ticket.
  r = await run({
    failPostWhen: a => /\/tasks$/.test(a.url) && a.body.fields.some(f => Number(f.id) === MESSAGE)
  });
  t.check("creation is retried without the input-data fields", created(r.posts).length === 2, r.posts);
  t.check("the retry keeps unit, component and email",
    created(r.posts)[1].body.fields.map(f => Number(f.id)).sort((a, b) => a - b).join(",") ===
      [UNIT, COMPONENT, EMAIL].sort((a, b) => a - b).join(","),
    created(r.posts)[1].body.fields);
  t.check("the subtask still exists", r.result.success === true && r.result.subtaskId === 90001, r.result);
  const rescued = r.posts.find(p => p.body && p.body.text);
  t.check("and the summary falls back to an internal comment",
    !!rescued && !rescued.body.channel && /№11613/.test(rescued.body.text), rescued && rescued.body);

  // ── A number pinned in config wins over the name ──
  // The escape hatch for a form whose field is named unexpectedly.
  r = await run({ config: { subtaskFormId: 1096731, unitFieldId: 777 } });
  t.check("a pinned field id overrides the one found by name",
    created(r.posts)[0].body.fields.some(f => Number(f.id) === 777) &&
    !created(r.posts)[0].body.fields.some(f => Number(f.id) === UNIT),
    created(r.posts)[0].body.fields);

  // The nesting of a form definition is documented worse than that of a task, so both
  // plausible shapes are accepted rather than guessed at.
  r = await run({
    formFields: [
      { id: 35, type: "catalog", name: "Юнит" },
      { id: 28, type: "catalog", name: "Компонент" },
      { id: 41, type: "title", name: "Контакты", value: { fields: [{ id: 44, type: "email", name: "Эл. почта" }] } }
    ]
  });
  t.check("a form that nests under value.fields resolves just as well",
    created(r.posts)[0].body.fields.some(f => Number(f.id) === EMAIL), created(r.posts)[0].body.fields);

  // Nothing to fall back to when the optional fields are not on the form at all.
  r = await run({
    formFields: [
      { id: 35, type: "catalog", name: "Юнит" },
      { id: 28, type: "catalog", name: "Компонент" },
      { id: 44, type: "email", name: "Эл. почта" }
    ]
  });
  const commented = r.posts.find(p => p.body && p.body.text);
  t.check("no message field on the form: the summary goes into a comment",
    !!commented && /Доступы/.test(commented.body.text), commented && commented.body);

  // ── The mandatory three cannot be guessed ──
  // Pyrus rejects a creation with a wrong field id whole, not partially, so sending «what we
  // have» would cost the request. The graph turns this failure into a handover, and the log
  // above has already listed every field of the form.
  r = await run({ formFields: [{ id: 1, type: "note", name: "ㅤ" }] });
  t.check("a form without the mandatory fields creates nothing",
    r.result.success === false && created(r.posts).length === 0, r.result);
  t.check("and says which form could not be read",
    /1096731/.test(String(r.result.reason)), r.result.reason);
  t.check("it is not mistaken for a request for the email", r.result.action !== "clarify", r.result);

  // The form request itself failing must not look like «no such field».
  r = await run({ formFields: null });
  t.check("an unreadable form definition also refuses instead of guessing",
    r.result.success === false && created(r.posts).length === 0, r.result);

  // ── Missing facts ──
  r = await run({ state: { data: { unitFullName: facts.unitFullName, componentName: facts.componentName } } });
  t.check("no email: the partner is asked instead of creating a broken subtask",
    r.result.action === "clarify" && created(r.posts).length === 0, r.result);

  r = await run({ state: { data: { email: "p@x.ru" } } });
  t.check("no unit or component: nothing is created",
    r.result.success === false && created(r.posts).length === 0, r.result);

  r = await run({ state: { runtime: {} } });
  t.check("no token: fails loudly instead of guessing",
    r.result.success === false && /token/.test(r.result.reason), r.result);

  // ── Pyrus answers without an id ──
  r = await run({ onPost: a => (/\/tasks$/.test(a.url) ? { body: {} } : { body: {} }) });
  t.check("creation without task.id is a failure, not a silent success",
    r.result.success === false, r.result);
  t.check("no subtaskId is written when creation failed", !r.state.subtaskId, r.state);

  return t.report();
}

module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
