// Читает выгрузку трасс с платформы и печатает то, ради чего её и открывают: что сказал
// партнёр, что ответил бот, какие инструменты вызывались с какими параметрами, какой исход
// выбран и что написано в логе.
//
// Выгрузка — дерево спанов на несколько мегабайт, где реплика партнёра лежит в теле
// вебхука, ответ бота — в теле POST в Pyrus, а решение витка — в аргументах applyOutcome.
// Глазами это не читается, а восстанавливать разговор по логам приходится каждый раз,
// когда бот повёл себя не так.
//
// Чего в выгрузке НЕТ: ответа модели. Логируется только запрос к LLM, поэтому реплику
// агента видно лишь на следующем запросе того же блока (роль assistant) — последний ответ
// агента не виден вовсе. Судить о нём приходится по действиям, которые он вызвал.
//
// Запуск: node tools/read-trace.js <файл.json> [ещё файлы] [--prompt]
const fs = require("fs");

function nodes(root, out) {
  out.push(root);
  (root.children || []).forEach(c => nodes(c, out));
  return out;
}

function cut(s, n) {
  const one = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

const data = span => (span.relatedEvent && span.relatedEvent.data) || null;

// Тело вебхука лежит где-то внутри события триггера, и его форма зависит от версии
// платформы. Ищется по признаку, а не по пути: `task_id` + `task` есть только у него.
function findWebhook(obj, depth) {
  if (!obj || typeof obj !== "object" || (depth || 0) > 10) return null;
  if (obj.task_id && obj.task) return obj;
  for (const k of Object.keys(obj)) {
    const hit = findWebhook(obj[k], (depth || 0) + 1);
    if (hit) return hit;
  }
  return null;
}

function turnsOf(file) {
  const tree = JSON.parse(fs.readFileSync(file, "utf8"));
  const roots = Array.isArray(tree) ? tree : [tree];
  const turns = [];
  roots.forEach(root => (root.children || []).forEach(trace => {
    if (trace.type !== "trace") return;
    const all = nodes(trace, []);
    const turn = {
      at: trace.startTime || trace.traceStartTime || "",
      partner: null, taskId: null,
      replies: [], internal: [], calls: [], outcome: null,
      path: [], logs: [], prompts: [], errors: []
    };

    all.forEach(span => {
      const label = String(span.label || "");
      const e = span.relatedEvent || {};
      const d = data(span);

      const move = /^Переход: «(.+?)» → «(.+?)»/.exec(label);
      if (move) {
        if (!turn.path.length) turn.path.push(move[1]);
        turn.path.push(move[2]);
      }
      // `label` обрезан платформой на полусотне символов, а вся диагностика — в хвосте:
      // строка «маршрут …» именно там называет счета, отрыв и режим подбора. Целая строка
      // лежит в `userLog`.
      if (/^Лог: /.test(label)) turn.logs.push(e.userLog || label.slice(5));
      if (e.isError) turn.errors.push(cut(e.message || label, 200));

      if (/Триггер/.test(label) && !turn.partner) {
        const body = findWebhook(e);
        if (body) {
          turn.taskId = body.task_id;
          const comments = (body.task && body.task.comments) || [];
          const last = comments[comments.length - 1] || null;
          if (last) {
            turn.partner = {
              text: last.text || "",
              author: (last.author && (last.author.name || last.author.id)) || "?",
              channel: !!last.channel,
              attachments: (last.attachments || []).length
            };
          }
        }
      }

      // Всё, что бот сказал в Pyrus. С каналом — партнёру, без канала — во внутреннюю
      // переписку: это единственное различие между ними и в самом Pyrus.
      if (/Http\.post/.test(label) && d && /\/comments$/.test(String(d.url || ""))) {
        const body = d.body || {};
        const entry = {
          text: body.text || null,
          action: body.action || null,
          approval: body.approval_choice || null,
          fields: (body.field_updates || []).length
        };
        if (body.channel) turn.replies.push(entry);
        else turn.internal.push(entry);
      }

      // Инструменты и функции с аргументами: по ним видно, ЧТО модель передала.
      if (/Пользовательская функция/.test(label) && d) {
        const name = String(label).split(": ")[1] || label;
        const args = d.args || (d.file ? null : d);
        if (/applyOutcome/.test(name) && d.args) turn.outcome = d.args.outcome || null;
        if (args && Object.keys(args).length) turn.calls.push(name + "(" + cut(JSON.stringify(args), 200) + ")");
      }

      if (/LLM/i.test(label) && d && d.body && Array.isArray(d.body.messages)) {
        turn.prompts.push(d.body.messages.map(m => m.role + ": " + cut(m.content, 900)).join("\n    "));
      }
    });

    turns.push(turn);
  }));
  return turns;
}

const args = process.argv.slice(2);
const withPrompt = args.indexOf("--prompt") >= 0;
const files = args.filter(a => a !== "--prompt");
if (!files.length) {
  console.log("Использование: node tools/read-trace.js <файл.json> [ещё файлы] [--prompt]");
  process.exit(1);
}

let all = [];
files.forEach(f => { all = all.concat(turnsOf(f)); });
all.sort((a, b) => String(a.at).localeCompare(String(b.at)));

all.forEach((t, i) => {
  console.log("\n──── виток " + (i + 1) + "  " + t.at + "  задача " + (t.taskId || "?"));
  if (t.partner) {
    console.log("  ПАРТНЁР (" + t.partner.author + (t.partner.channel ? ", канал" : ", БЕЗ канала") +
      (t.partner.attachments ? ", вложений " + t.partner.attachments : "") + "): " + cut(t.partner.text, 400));
  }
  t.calls.forEach(c => console.log("  вызов: " + c));
  t.replies.forEach(r => console.log("  БОТ: " + cut(r.text, 500) +
    (r.action ? " [action: " + r.action + "]" : "") + (r.fields ? " [полей: " + r.fields + "]" : "")));
  t.internal.forEach(r => console.log("  ОПЕРАТОРУ: " + cut(r.text, 500) +
    (r.approval ? " [approval: " + r.approval + "]" : "")));
  if (!t.replies.length && !t.internal.length) console.log("  (в Pyrus ничего не ушло)");
  console.log("  исход: " + (t.outcome || "—"));
  t.logs.forEach(l => console.log("  лог: " + cut(l, 300)));
  t.errors.forEach(l => console.log("  ОШИБКА: " + l));
  console.log("  путь: " + t.path.filter(n => n !== "Pyrus Webhook").join(" → "));
  if (withPrompt) t.prompts.forEach((p, k) => console.log("  --- промпт " + (k + 1) + " ---\n    " + p));
});

console.log("\nвсего витков: " + all.length);
