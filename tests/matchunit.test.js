// Tests for matchUnit: what the catalog search resolves, and what it refuses to decide.
//
// The tool exists because the agent kept losing the exact catalog string. It follows that
// what it hands BACK to the agent is part of its contract: a full name in the answer is a
// decision made, and while no decision has been made there must be none to copy.
const { loadFunction, makeEnv, suite } = require("./harness");

const matchUnit = loadFunction("functions/ID_Tools/matchUnit/code.js", ["query", "scope"]);

const TASK = 11613;

const CATALOG = [
  "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)",
  "[dodopizza.ru] Тамбов-2 (улица Мира, 5)",
  // One name, two businesses — the case the partner ran into.
  "[dodopizza.ru] Москва 0-22 (Цветной бульвар, 2)",
  "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)"
];

function run(query, scope, said) {
  // makeEnv clones the seed, so the document to inspect afterwards is the environment's own.
  // `said` is the partner's message this turn — the only place a business may come from.
  const env = makeEnv({
    db: { unitCatalog: CATALOG, ["state:" + TASK]: { taskId: TASK, data: {} } },
    contextValues: { dialog: { taskId: String(TASK), incomingText: said || "" } }
  });
  return matchUnit(env, [query, scope]).then(r => ({ result: r, state: env.db["state:" + TASK] }));
}

async function main() {
  const t = suite("matchUnit");

  let r = await run("Тамбов-1");
  t.check("an unambiguous point resolves to its catalog string",
    r.result.resolvedFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.result);
  t.check("and is written to the document without waiting for the agent to echo it",
    r.state.data.unitFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.state);
  t.check("a resolved search may show the full name it resolved",
    r.result.matches[0].fullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.result.matches);

  // ── The point that was chosen for the partner ──
  // Both businesses have «Москва 0-22». The tool refuses to pick, and used to list both
  // full names anyway; the agent copied the first and the partner got a pizzeria.
  r = await run("Москва 0-22");
  t.check("a name two businesses share is not resolved",
    r.result.resolvedFullName === null && r.result.count === 2, r.result);
  t.check("and it is reported as needing the business",
    r.result.needsBusinessClarification === true, r.result);
  t.check("no full name is offered for copying while the choice is open",
    r.result.matches.every(m => m.fullName === undefined), r.result.matches);
  t.check("nothing is written to the document either",
    !r.state.data.unitFullName, r.state);

  // The word the PARTNER used narrows it, and then the full name is his to have.
  r = await run("Москва 0-22", null, "кофейня Москва 0-22");
  t.check("the business the partner named resolves the same name",
    r.result.resolvedFullName === "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)", r.result);

  // ── A business the agent added to its own search ──
  // With the candidate full names gone from the list, the next way to get a name out of the
  // tool is to narrow the search — and the agent narrowed it with a word the partner had
  // never said. The pizzeria was resolved, written into the task document, and nothing in
  // the reply showed that a choice had been made at all.
  r = await run("пиццерия Москва 0-22", null, "Москва 0-22, нужно изменить фамилию сотрудника");
  t.check("a business the query adds on its own does not narrow anything",
    r.result.resolvedFullName === null && r.result.count === 2, r.result);
  t.check("and the partner is asked which business it is",
    r.result.needsBusinessClarification === true, r.result);
  t.check("nothing is written to the document on the agent's word",
    !r.state.data.unitFullName, r.state);

  // And when the two disagree, the partner is the one who knows.
  r = await run("пиццерия Москва 0-22", null, "у нас кофейня Москва 0-22");
  t.check("the partner's word outranks the business the query claims",
    r.result.resolvedFullName === "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)", r.result);

  // Both businesses in one message names neither.
  r = await run("Москва 0-22", null, "у нас и пиццерия, и кофейня Москва 0-22");
  t.check("a partner naming both businesses resolves nothing",
    r.result.resolvedFullName === null, r.result);

  // The same question, answered in whatever words come to hand. Case forms used to be
  // listed one by one, and the ones nobody thought of cost the partner a repeat question.
  for (const said of ["работаю в кофейне Москва 0-22", "пишу из дринкита, Москва 0-22",
    "это сотрудник кофейни, точка Москва 0-22", "нет, это кофейня Москва 0-22",
    "это не пиццерия, а кофейня, Москва 0-22"]) {
    r = await run("Москва 0-22", null, said);
    t.check("«" + said + "» resolves the coffee shop",
      r.result.resolvedFullName === "[drinkit.ru] Москва 0-22 (Дмитровское шоссе, 163А)", r.result);
  }

  // Noise words in any case form must not cost the search its match.
  for (const q of ["пиццерия Тамбов-1", "наша пиццерии Тамбов-1", "точке Тамбов-1",
    "в филиале Тамбов-1", "у нашего юнита Тамбов-1"]) {
    r = await run(q);
    t.check("«" + q + "» still finds the point",
      r.result.resolvedFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)", r.result);
  }

  r = await run("Тамбов");
  t.check("a city without a number is not resolved to its first point",
    r.result.resolvedFullName === null && r.result.count === 2, r.result);
  t.check("and asking about the business would be nonsense here",
    r.result.needsBusinessClarification === false, r.result);
  t.check("its candidates carry no full name either",
    r.result.matches.every(m => m.fullName === undefined), r.result.matches);

  // A request on behalf of a whole network has no point number to give, so any point of
  // that network will do — but only while the network itself is unambiguous.
  r = await run("Тамбов", "network");
  t.check("a network request takes the first point of the network",
    r.result.resolvedFullName === "[dodopizza.ru] Тамбов-1 (улица Кирова, 101)" && r.result.networkPick === true, r.result);

  r = await run("Москва 0-22", "network");
  t.check("but not when the city holds two businesses",
    r.result.resolvedFullName === null && r.result.needsBusinessClarification === true, r.result);

  r = await run("пиццерия Москва 0-22", "network");
  t.check("a network request cannot be narrowed by the agent's word either",
    r.result.resolvedFullName === null && r.result.needsBusinessClarification === true, r.result);

  r = await run("Тамбов-9");
  t.check("a point the catalog does not have resolves to nothing",
    r.result.resolvedFullName === null && r.result.count === 0, r.result);

  return t.report();
}

module.exports = main;
