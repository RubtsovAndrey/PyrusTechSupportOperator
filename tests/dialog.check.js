// Разговоры целиком, глазами человека: `node tests/dialog.check.js`.
// Проверок здесь нет — это отчёт. Утверждения о том, как разговор ОБЯЗАН идти, лежат в
// `tests/dialog.test.js` и гоняются вместе со всем набором.
const { conversation } = require("./dialog");

let taskId = 700000;

function show(title, lines) {
  console.log("\n=== " + title + " ===");
  lines.forEach(l => console.log(l));
}

function render(r, i) {
  const out = ["  [" + (i + 1) + "] партнёр: " + (r.partner === null ? "(вложение без текста)" : r.partner)];
  r.replies.forEach(t => out.push("      бот: " + String(t).replace(/\n+/g, " / ")));
  r.internal.forEach(t => out.push("      оператору: " + String(t).split("\n").filter(Boolean).slice(0, 3).join(" | ")));
  if (!r.replies.length && !r.internal.length) out.push("      (бот промолчал)");
  out.push("      исход: " + (r.kind || "—") + ", стадия: " + (r.stage || "—") +
    ", агенты: " + (r.agents.join(" → ") || "нет") +
    (r.subtaskId ? ", подзадача: " + r.subtaskId : "") +
    (r.errors.length ? ", ОШИБКИ: " + r.errors.join("; ") : "") +
    (r.dead ? ", ВЕТКА УМЕРЛА" : ""));
  return out;
}

async function scenario(title, script) {
  const bot = conversation({ taskId: ++taskId });
  const lines = [];
  for (const step of script) {
    const r = await bot.turn(step[0], step[1]);
    render(r, bot.turns.length - 1).forEach(l => lines.push(l));
  }
  lines.push("  ── витков: " + bot.turns.length + ", финал: " + (bot.state.stage || "—"));
  show(title, lines);
  return bot;
}

async function main() {
  await scenario("Самообслуживание: вывод чаевых курьера", [
    ["Здравствуйте! Курьер не может вывести чаевые, Тамбов-1", { unit: "Тамбов-1" }],
    ["Да, получилось, спасибо"]
  ]);

  await scenario("Неизвестная тема: телефон сотрудника — оператору", [
    ["Нужно изменить номер телефона у сотрудника, Тамбов-1", { unit: "Тамбов-1" }]
  ]);

  await scenario("Касса: утверждённый совет не помог", [
    ["Тамбов-1, на кассе ресторана ККМ не подключен", {
      unit: "Тамбов-1",
      answers: { posLocation: "касса ресторана", problemDetails: "ККМ не подключен" }
    }],
    ["Не помогло"]
  ]);

  await scenario("Сбор данных: юнит спрашивают отдельно", [
    ["Здравствуйте"],
    ["Не работает касса"],
    ["Тамбов-1", { unit: "Тамбов-1" }]
  ]);

  await scenario("Партнёр просит человека сразу", [
    ["Тамбов-1, соедините меня с живым человеком", { unit: "Тамбов-1", intent: "operator" }]
  ]);

  await scenario("Партнёр просит человека посреди вопросов статьи", [
    ["Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" }],
    ["Хватит вопросов, позовите оператора"]
  ]);

  await scenario("Партнёр говорит не по делу, потом ещё раз", [
    ["Тамбов-1, касса не печатает чек", { unit: "Тамбов-1" }],
    ["а это вообще долго делается?"],
    ["ну так что там по срокам"]
  ]);

  await scenario("Партнёр переспрашивает про совет", [
    ["Тамбов-1, на кассе ресторана ККМ не подключен", {
      unit: "Тамбов-1",
      answers: { posLocation: "касса ресторана", problemDetails: "ККМ не подключен" }
    }],
    ["А где проверить этот кабель?"],
    ["а это точно нужный кабель?"],
    ["всё равно непонятно"]
  ]);

  await scenario("Благодарность в закрытый чат", [
    ["Здравствуйте! Курьер не может вывести чаевые, Тамбов-1", { unit: "Тамбов-1" }],
    ["Да, получилось"],
    ["Спасибо большое!"]
  ]);

  await scenario("Новый вопрос в закрытый чат — к человеку", [
    ["Здравствуйте! Курьер не может вывести чаевые, Тамбов-1", { unit: "Тамбов-1" }],
    ["Да, получилось"],
    ["Спасибо! А ещё касса не печатает чек"]
  ]);

  await scenario("Неизвестное обращение на другом языке — оператору", [
    ["Hello! Tambov-1. The internet is down, nothing opens", { unit: "Тамбов-1" }]
  ]);

  await scenario("Вложение без текста", [
    ["Тамбов-1, не работает касса", { unit: "Тамбов-1" }],
    [null, { attachments: [{ id: 1, name: "screen.png" }] }]
  ]);
}

main().catch(e => { console.error(e); process.exit(1); });
