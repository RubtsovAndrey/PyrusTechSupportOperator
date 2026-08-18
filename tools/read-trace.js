// Запуск: node tools/read-trace.js <папка1,папка2> [--prompt]
const fs = require("fs");
const path = require("path");

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
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`  [!] Ошибка чтения файла ${file}: ${e.message}`);
    return [];
  }

  const roots = Array.isArray(tree) ? tree : [tree];
  const turns = [];

  roots.forEach(root => (root.children || []).forEach(trace => {
    if (trace.type !== "trace") return;
    const all = nodes(trace, []);
    const turn = {
      at: trace.startTime || trace.traceStartTime || "",
      partner: null, taskId: null,
      replies: [], internal: [], calls: [], outcome: null,
      path: [], logs: [], prompts: [], llmReplies: [], errors: []
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

      if (/Пользовательская функция/.test(label) && d) {
        const name = String(label).split(": ")[1] || label;
        const args = d.args || (d.file ? null : d);
        if (/applyOutcome/.test(name) && d.args) turn.outcome = d.args.outcome || null;
        if (args && Object.keys(args).length) turn.calls.push(name + "(" + cut(JSON.stringify(args), 200) + ")");
      }

      if (/LLM/i.test(label) && d && d.body && Array.isArray(d.body.messages)) {
        // Запрос к LLM (промпт)
        turn.prompts.push(d.body.messages.map(m => m.role + ": " + cut(m.content, 900)).join("\n    "));

        // Ответ от LLM (результат из outputData)
        try {
          if (span.outputData && span.outputData.body && span.outputData.body.choices) {
            const llmContent = span.outputData.body.choices[0].message.content;
            if (llmContent) turn.llmReplies.push(cut(llmContent, 900));
          }
        } catch (err) {
          // Игнорируем, если структура ответа неожиданно другая или LLM не ответила
        }
      }
    });

    turns.push(turn);
  }));
  return turns;
}

// Парсинг аргументов командной строки
const args = process.argv.slice(2);
const withPrompt = args.indexOf("--prompt") >= 0;
// Собираем все аргументы, кроме флага --prompt, и объединяем их через запятую
// (на случай если пользователь ввёл `dir1 dir2` или `dir1,dir2`)
const dirsArg = args.filter(a => a !== "--prompt").join(",");

if (!dirsArg) {
  console.log("Использование: node tools/read-trace.js <папка1,папка2> [--prompt]");
  process.exit(1);
}

// Разбиваем по запятым, убираем пробелы и пустые строки
const dirs = dirsArg.split(",").map(d => d.trim()).filter(Boolean);

// Обработка каждой папки как отдельного документа
dirs.forEach(dir => {
  console.log("\n========================================================");
  console.log("📁 ДОКУМЕНТ: " + dir);
  console.log("========================================================");

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.log(`  [!] Путь '${dir}' не найден или не является папкой.\n`);
    return;
  }

  // Собираем все JSON-файлы в папке
  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".json"))
    .map(f => path.join(dir, f));

  if (!files.length) {
    console.log("  (В папке нет JSON-файлов)\n");
    return;
  }

  let allTurns = [];
  files.forEach(f => {
    allTurns = allTurns.concat(turnsOf(f));
  });

  // Сортируем все витки из всех файлов этой папки хронологически
  allTurns.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  allTurns.forEach((t, i) => {
    console.log("\n──── виток " + (i + 1) + "  " + t.at + "  задача " + (t.taskId || "?"));
    if (t.partner) {
      console.log("  ПАРТНЁР (" + t.partner.author + (t.partner.channel ? ", канал" : ", БЕЗ канала") +
        (t.partner.attachments ? ", вложений " + t.partner.attachments : "") + "): " + cut(t.partner.text, 400));
    }

    if (withPrompt) t.prompts.forEach((p, k) => console.log("  --- промпт " + (k + 1) + " ---\n    " + p));
    t.llmReplies.forEach(r => console.log("  LLM (ответ): " + cut(r, 500)));

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
  });

  console.log("\nВсего витков в документе '" + dir + "': " + allTurns.length);
});
