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
const CONFIG = { subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5, parentLinkFieldId: LINK_FIELD };

const CREATED = { body: { task: { id: 90001 } } };
const emptyRegister = () => ({ body: { tasks: [] } });
const registerWith = id => () => ({ body: { tasks: [{ id: id }] } });

async function run(options) {
  const o = options || {};
  const env = makeEnv({
    prev: { taskId: "11613" },
    db: Object.assign({ config: o.config === null ? undefined : (o.config || CONFIG), [KEY]: state(o.state) }, o.db),
    contextValues: { dialog: { taskId: "11613" } },
    onGet: o.onGet || emptyRegister,
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
  r = await run({ config: { subtaskFormId: 1096731, unitFieldId: 97, componentFieldId: 36, emailFieldId: 5 } });
  t.check("no link field: register is not queried", r.gets.length === 0, r.gets);
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
  t.check("a subtask that could not be linked is still finished properly",
    r.result.success === true &&
    r.posts.some(p => p.body && p.body.action === "finished"), r.result);

  // ── The subtask must arrive usable: summary plus a completed first step ──
  r = await run({});
  const summary = r.posts.find(p => p.body && p.body.text);
  t.check("summary comment is internal", !summary.body.channel, summary.body);
  t.check("summary names the parent task", /№11613/.test(summary.body.text), summary.body.text);
  t.check("summary carries unit, component and email",
    /Тамбов-1/.test(summary.body.text) && /Доступы/.test(summary.body.text) && /p@x\.ru/.test(summary.body.text),
    summary.body.text);
  t.check("first step is completed", r.posts.some(p => p.body && p.body.action === "finished"), r.posts);

  // A failed summary must not leave the subtask standing on its first step.
  r = await run({ failPostWhen: a => !!(a.body && a.body.text) });
  t.check("step is advanced even when the summary fails",
    r.posts.some(p => p.body && p.body.action === "finished"), r.posts);

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
