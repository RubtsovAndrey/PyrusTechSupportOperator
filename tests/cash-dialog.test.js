// Full graph conversations for the first executable cash policies. Unlike the catalog
// acceptance test, these assertions see exactly what Pyrus would receive in external and
// internal correspondence, including confirmation, field classification and handover.
const { suite } = require("./harness");
const { conversation } = require("./dialog");

const RESTAURANT = "Касса → Касса ресторана → Печать чека";
const DELIVERY = "Касса → Касса доставки → Печать чека";
let taskId = 780000;

function chat(options) {
  const supplied = options || {};
  const config = Object.assign({
    forms: { "77": { role: "chat", environment: "test", knowledgeExecution: "partner_answer" } }
  }, supplied.config || {});
  return conversation(Object.assign({ taskId: ++taskId }, supplied, { config: config }));
}

async function main() {
  const t = suite("cash policy dialogs");

  // Known answer -> external correspondence only -> confirmed close.
  let bot = chat();
  let r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("error 148 is answered externally in the test chat",
    r.stage === "awaiting_confirmation" && r.replies.length === 1 &&
    /ИНН/.test(r.replies[0]) && /другого кассира/.test(r.replies[0]), r);
  t.check("a normal known answer creates no internal message",
    r.internal.length === 0, r.internal);
  t.check("the restaurant component is stored before confirmation",
    bot.data.componentName === RESTAURANT, bot.data.componentName);
  r = await bot.turn("Да, помогло");
  t.check("confirmed error-148 resolution closes the chat",
    r.kind === "solved" && r.stage === "closed", r);
  t.check("successful close still creates no internal message",
    r.internal.length === 0, r.internal);

  // Known answer -> explicit failure -> one operator summary containing the attempt.
  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе доставки чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Не помогло");
  t.check("a failed known answer is handed over",
    r.kind === "escalated" && r.stage === "escalated", r);
  t.check("handover creates exactly one internal summary",
    r.internal.length === 1 && /Что уже пробовали/.test(r.internal[0]) &&
    /ИНН/.test(r.internal[0]) && /не помогла партнёру/.test(r.internal[0]), r.internal);
  t.check("failed delivery cash keeps the delivery component",
    bot.data.componentName === DELIVERY, bot.data.componentName);

  // Shift: questions stay external and silent internally; only a usable setup gets advice.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе доставки смена превысила 24 часа",
    { unit: "Тамбов-1" }
  );
  t.check("shift policy asks about Test Driver externally",
    r.stage === "awaiting_answers" && /Тест драйвера ККТ/.test(r.replies.join(" ")),
    r.replies);
  t.check("a diagnostic question creates no internal message",
    r.internal.length === 0, r.internal);
  r = await bot.turn("Да", {
    answers: { kktDriverAvailable: "да" }
  });
  t.check("a bare yes follows the confirmed setup and serves the canonical instruction",
    r.stage === "awaiting_confirmation" && /Отчёт о закрытии смены \(с гашением\)/.test(r.replies.join(" ")) &&
    /Вид/.test(r.replies.join(" ")) && /Обновить/.test(r.replies.join(" ")),
    r.replies);
  t.check("the shift instruction is also external-only",
    r.internal.length === 0, r.internal);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе ресторана смена превысила 24 часа",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("Нет", {
    answers: { kktDriverAvailable: "нет" }
  });
  t.check("no Test Driver produces no unsafe partner instruction",
    r.stage === "escalated" && !/Сформировать отчёт/.test(r.replies.join(" ")), r.replies);
  t.check("the setup stop condition produces one operator summary",
    r.internal.length === 1 && /Доступность драйвера ККТ/.test(r.internal[0]), r.internal);

  // Z report: the bot asks every safety question and stays out of internal correspondence.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана Z-отчёт не распечатался",
    { unit: "Тамбов-1" }
  );
  t.check("ambiguous Z report asks whether the shift closed",
    /точно отображается закрытой/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("Смена в Додо ИС закрыта, не вышел только Z-отчёт", {
    answers: { shiftClosedInDodo: "смена в Додо ИС закрыта" }
  });
  t.check("closed shift asks about later documents",
    /другие фискальные документы/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("После закрытия ничего не печатали", {
    answers: { laterFiscalDocuments: "после закрытия ничего не печатали" }
  });
  t.check("safe last-document state asks about Test Driver",
    /Тест драйвера ККТ/.test(r.replies.join(" ")) && r.internal.length === 0, r);
  r = await bot.turn("Да, драйвер открывается", {
    answers: { kktDriverAvailable: "да, драйвер открывается" }
  });
  t.check("only then is copy-last-document sent externally",
    r.stage === "awaiting_confirmation" &&
    /Печать копии последнего документа/.test(r.replies.join(" ")) &&
    r.internal.length === 0, r);
  r = await bot.turn("Да, помогло");
  t.check("successful Z-report recovery closes without an internal note",
    r.stage === "closed" && r.internal.length === 0, r);

  bot = chat();
  await bot.turn(
    "Тамбов-1, на кассе доставки смена закрылась, Z-отчёт не вышел",
    { unit: "Тамбов-1" }
  );
  r = await bot.turn("После закрытия печатали другой чек", {
    answers: {
      shiftClosedInDodo: "смена в Додо ИС закрыта",
      laterFiscalDocuments: "после закрытия печатали другой чек"
    }
  });
  t.check("a later fiscal document blocks the copy instruction",
    r.stage === "escalated" && !/Печать копии/.test(r.replies.join(" ")), r.replies);
  t.check("that stop condition is visible only in one operator summary",
    r.internal.length === 1 && /Документы после закрытия/.test(r.internal[0]), r.internal);

  // Country and role boundaries go through the same real graph.
  bot = chat({ units: ["[dodopizza.by] Минск-1 (улица Ленина, 1)"] });
  r = await bot.turn(
    "Минск-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Минск-1" }
  );
  t.check("a Belarusian unit does not hear the Russian INN instruction",
    r.stage === "escalated" && !/ИНН/.test(r.replies.join(" ")), r);
  t.check("the out-of-country request is handed over with one internal summary",
    r.internal.length === 1, r.internal);

  bot = chat({ config: { forms: { "77": { role: "ticket" } } } });
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("a ticket cannot execute the first-line chat policy",
    r.stage === "escalated" && !/ИНН/.test(r.replies.join(" ")) && r.internal.length === 1, r);

  bot = chat({ config: { forms: { "77": { role: "chat", knowledgeExecution: "handover_only" } } } });
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана чек не закрывается, ошибка 148",
    { unit: "Тамбов-1" }
  );
  t.check("a chat form without explicit partner permission keeps the answer internal",
    r.stage === "escalated" && !/ИНН/.test(r.replies.join(" ")) &&
    r.internal.length === 1 && /ИНН/.test(r.internal[0]), r);

  // The rest of the cash bubble remains operator-only until separately accepted.
  bot = chat();
  r = await bot.turn(
    "Тамбов-1, на кассе ресторана ККМ не подключен",
    { unit: "Тамбов-1" }
  );
  t.check("unaccepted KKM advice is not exposed externally",
    r.stage === "escalated" && !/USB-порт/.test(r.replies.join(" ")), r.replies);
  t.check("the operator receives the KKM hint and source context",
    r.internal.length === 1 && /Проверьте соединение между ККМ/.test(r.internal[0]) &&
    /b12b10c3/.test(r.internal[0]), r.internal);

  return t.report();
}

module.exports = main;

if (require.main === module) {
  main().then(r => { process.exitCode = r.failed ? 1 : 0; });
}
