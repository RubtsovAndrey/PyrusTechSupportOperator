// Восстановление живого разговора из выгрузки трасс Agent Platform.
//
// Обычный отчёт:
//   node tools/read-trace.js <папка-или-json> [--prompt]
//
// Проверка сохранённого сценария и запись отчёта без перенаправления stdout:
//   node tools/read-trace.js <папка-или-json> --scenario unknown-courier-avatar --out result_report.txt
const fs = require("fs");
const path = require("path");

const DEFAULT_SCENARIOS = path.join(__dirname, "..", "tests", "live", "scenarios.json");

function nodes(root, out) {
  out.push(root);
  (root.children || []).forEach(c => nodes(c, out));
  return out;
}

function cut(s, n) {
  const one = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

// Pyrus accepts HTML in `formatted_text` for outbound channel comments. The trace reader
// used to inspect only `text`, so a perfectly delivered answer with a hidden hyperlink
// appeared as an empty `БОТ:` line. Keep the visible wording, not the markup.
function visibleText(body) {
  if (!body) return "";
  if (body.text != null && String(body.text)) return String(body.text);
  return String(body.formatted_text || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

const data = span => (span.relatedEvent && span.relatedEvent.data) || null;

function taskFromPost(span) {
  const output = span && span.outputData;
  if (output && output.body && output.body.task) return output.body.task;
  const eventOutput = span && span.relatedEvent && span.relatedEvent.outputData;
  if (eventOutput && eventOutput.body && eventOutput.body.task) return eventOutput.body.task;
  return null;
}

function postedCommentIndex(comments, body) {
  const wantedText = visibleText(body);
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i] || {};
    if (wantedText && visibleText(comment) !== wantedText) continue;
    if (body.action != null && String(comment.action || "") !== String(body.action)) continue;
    if (body.approval_choice != null &&
        String(comment.approval_choice || "") !== String(body.approval_choice)) continue;
    return i;
  }
  return -1;
}

function taskStateFromPost(span, body) {
  const task = taskFromPost(span);
  if (!task) return null;
  const comments = Array.isArray(task.comments) ? task.comments : [];
  const postedAt = postedCommentIndex(comments, body || {});
  const later = postedAt >= 0 ? comments.slice(postedAt + 1) : [];
  const laterComments = later.map(comment => ({
    id: comment.id || null,
    text: visibleText(comment),
    action: comment.action || null,
    approval: comment.approval_choice || null,
    author: (comment.author &&
      (comment.author.name || comment.author.last_name || comment.author.first_name || comment.author.id)) || "?"
  }));
  return {
    isClosed: typeof task.is_closed === "boolean" ? task.is_closed : null,
    currentStep: task.current_step == null ? null : Number(task.current_step),
    postedCommentId: postedAt >= 0 ? (comments[postedAt].id || null) : null,
    lastAction: comments.reduce((value, comment) => comment && comment.action ? comment.action : value, null),
    reopenedAfterReply: laterComments.some(comment => comment.action === "reopened"),
    laterComments
  };
}

function findWebhook(obj, depth) {
  if (!obj || typeof obj !== "object" || (depth || 0) > 10) return null;
  if (obj.task_id && obj.task) return obj;
  for (const k of Object.keys(obj)) {
    const hit = findWebhook(obj[k], (depth || 0) + 1);
    if (hit) return hit;
  }
  return null;
}

function traceRoots(root) {
  if (root && root.type === "trace") return [root];
  return (root && root.children || []).filter(child => child.type === "trace");
}

function turnsOf(file) {
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { turns: [], errors: [`Ошибка чтения файла ${file}: ${e.message}`] };
  }

  const roots = Array.isArray(tree) ? tree : [tree];
  const turns = [];

  roots.forEach(root => traceRoots(root).forEach(trace => {
    const all = nodes(trace, []);
    const turn = {
      at: trace.startTime || trace.traceStartTime || "",
      partner: null, taskId: null,
      replies: [], internal: [], calls: [], outcome: null,
      path: [], logs: [], prompts: [], llmReplies: [], errors: [], taskState: null
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
      // Some Agent Platform failures mark only the enclosing span (`hasError`) while the
      // related event still says `isError: false`. Looking at the event alone hid exactly
      // the red parseSummaryForSubtask block visible in the UI. De-duplicate the parent
      // block and its failed function child, which normally carry the same message.
      const error = e.isError
        ? (e.message || label)
        : (span.hasError ? (span.errorMessage || (span.outputData && span.outputData.errorMessage)) : null);
      if (error) {
        const shortError = cut(error, 200);
        if (turn.errors.indexOf(shortError) < 0) turn.errors.push(shortError);
      }

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
          text: visibleText(body) || null,
          action: body.action || null,
          approval: body.approval_choice || null,
          fields: (body.field_updates || []).length
        };
        if (body.channel) turn.replies.push(entry);
        else turn.internal.push(entry);
        const taskState = taskStateFromPost(span, body);
        if (taskState) turn.taskState = taskState;
      }

      if (/Пользовательская функция/.test(label) && d) {
        const name = String(label).split(": ")[1] || label;
        const args = d.args || (d.file ? null : d);
        if (/applyOutcome/.test(name) && d.args) {
          const output = span.outputData || {};
          // A safety guard may replace a requested clarify/close with a handover. The
          // trace report must show what actually happened, not merely the input request.
          turn.outcome = output.kind || (output.result && output.result.kind) ||
            d.args.outcome || null;
        }
        if (args && Object.keys(args).length) turn.calls.push(name + "(" + cut(JSON.stringify(args), 200) + ")");
      }

      if (/LLM/i.test(label) && d && d.body && Array.isArray(d.body.messages)) {
        turn.prompts.push(d.body.messages.map(m => m.role + ": " + cut(m.content, 900)).join("\n    "));
        try {
          if (span.outputData && span.outputData.body && span.outputData.body.choices) {
            const llmContent = span.outputData.body.choices[0].message.content;
            if (llmContent) turn.llmReplies.push(cut(llmContent, 900));
          }
        } catch (err) {
          // Некоторые версии экспорта не содержат ответ модели.
        }
      }
    });

    turns.push(turn);
  }));
  return { turns, errors: [] };
}

function filesOf(source) {
  if (!fs.existsSync(source)) return { files: [], error: `Путь '${source}' не найден.` };
  const stat = fs.statSync(source);
  if (stat.isFile()) {
    if (!source.toLowerCase().endsWith(".json")) {
      return { files: [], error: `Файл '${source}' не является JSON.` };
    }
    return { files: [source], error: null };
  }
  if (!stat.isDirectory()) return { files: [], error: `Путь '${source}' не является файлом или папкой.` };
  return {
    files: fs.readdirSync(source)
      .filter(f => f.toLowerCase().endsWith(".json"))
      .map(f => path.join(source, f)),
    error: null
  };
}

function readSource(source) {
  const found = filesOf(source);
  const result = { source, files: found.files, turns: [], errors: [] };
  if (found.error) result.errors.push(found.error);
  found.files.forEach(file => {
    const parsed = turnsOf(file);
    result.turns = result.turns.concat(parsed.turns);
    result.errors = result.errors.concat(parsed.errors);
  });
  result.turns.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return result;
}

function renderDocument(document, withPrompt) {
  const lines = [
    "",
    "========================================================",
    "📁 ДОКУМЕНТ: " + document.source,
    "========================================================"
  ];

  document.errors.forEach(e => lines.push("  [!] " + e));
  if (!document.files.length && !document.errors.length) lines.push("  (JSON-файлы не найдены)");

  document.turns.forEach((t, i) => {
    lines.push("", "──── виток " + (i + 1) + "  " + t.at + "  задача " + (t.taskId || "?"));
    if (t.partner) {
      lines.push("  ПАРТНЁР (" + t.partner.author + (t.partner.channel ? ", канал" : ", БЕЗ канала") +
        (t.partner.attachments ? ", вложений " + t.partner.attachments : "") + "): " + cut(t.partner.text, 400));
    }

    if (withPrompt) t.prompts.forEach((p, k) => lines.push("  --- промпт " + (k + 1) + " ---\n    " + p));
    t.llmReplies.forEach(r => lines.push("  LLM (ответ): " + cut(r, 500)));
    t.calls.forEach(c => lines.push("  вызов: " + c));
    const operation = r => (r.action ? " [action: " + r.action + "]" : "") +
      (r.approval ? " [approval: " + r.approval + "]" : "") +
      (r.fields ? " [полей: " + r.fields + "]" : "");
    t.replies.forEach(r => lines.push("  БОТ: " + cut(r.text, 500) + operation(r)));
    t.internal.forEach(r => lines.push("  ОПЕРАТОРУ: " + cut(r.text, 500) + operation(r)));

    if (t.taskState) {
      const closed = t.taskState.isClosed == null ? "не указан" : (t.taskState.isClosed ? "да" : "нет");
      lines.push("  PYRUS В ИТОГЕ: закрыта = " + closed +
        ", этап = " + (t.taskState.currentStep == null ? "—" : t.taskState.currentStep) +
        ", последнее действие = " + (t.taskState.lastAction || "—"));
      t.taskState.laterComments.forEach(comment => lines.push(
        "  ПОСЛЕ ОТВЕТА БОТА: " + cut(comment.text, 300) +
        (comment.action ? " [action: " + comment.action + "]" : "") +
        " [автор: " + comment.author + "]"));
    }

    if (!t.replies.length && !t.internal.length) lines.push("  (в Pyrus ничего не ушло)");
    lines.push("  исход: " + (t.outcome || "—"));
    t.logs.forEach(l => lines.push("  лог: " + cut(l, 300)));
    t.errors.forEach(l => lines.push("  ОШИБКА: " + l));
    lines.push("  путь: " + t.path.filter(n => n !== "Pyrus Webhook").join(" → "));
  });

  lines.push("", "Всего витков в документе '" + document.source + "': " + document.turns.length);
  return lines;
}

function lower(value) {
  return String(value == null ? "" : value).toLocaleLowerCase("ru-RU");
}

function hasText(haystack, needle) {
  return lower(haystack).indexOf(lower(needle)) >= 0;
}

function validateScenario(turns, scenario) {
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail: detail || "" });
  const expect = scenario.expect || {};

  if (expect.turnCount != null) {
    add("число витков = " + expect.turnCount, turns.length === expect.turnCount,
      "получено " + turns.length);
  }

  (expect.turns || []).forEach((wanted, index) => {
    const turn = turns[index];
    const prefix = "виток " + (index + 1) + ": ";
    if (!turn) {
      add(prefix + "присутствует", false, "виток отсутствует");
      return;
    }
    add(prefix + "присутствует", true);

    const textChecks = (label, actual, spec) => {
      if (!spec) return;
      (spec.includes || []).forEach(part => add(prefix + label + " содержит «" + part + "»",
        hasText(actual, part), "фактически: " + cut(actual, 220)));
      (spec.excludes || []).forEach(part => add(prefix + label + " не содержит «" + part + "»",
        !hasText(actual, part), "фактически: " + cut(actual, 220)));
    };

    textChecks("сообщение партнёра", turn.partner && turn.partner.text, wanted.partner);
    if (wanted.outcome != null) add(prefix + "исход = " + wanted.outcome,
      turn.outcome === wanted.outcome, "фактически: " + (turn.outcome || "—"));

    const replies = turn.replies.map(r => r.text || "").join("\n");
    if (wanted.replies && wanted.replies.count != null) add(prefix + "ответов партнёру = " + wanted.replies.count,
      turn.replies.length === wanted.replies.count, "получено " + turn.replies.length);
    textChecks("ответ партнёру", replies, wanted.replies);
    if (wanted.replies) {
      const first = turn.replies[0] || {};
      if (wanted.replies.action !== undefined) add(prefix + "action ответа = " + String(wanted.replies.action),
        first.action === wanted.replies.action, "фактически: " + (first.action || "—"));
      if (wanted.replies.approval !== undefined) add(prefix + "approval ответа = " + String(wanted.replies.approval),
        first.approval === wanted.replies.approval, "фактически: " + (first.approval || "—"));
      if (wanted.replies.fields !== undefined) add(prefix + "полей в ответе = " + wanted.replies.fields,
        first.fields === wanted.replies.fields, "фактически: " + Number(first.fields || 0));
    }

    const internal = turn.internal.map(r => r.text || "").join("\n");
    if (wanted.internal && wanted.internal.count != null) add(prefix + "внутренних сообщений = " + wanted.internal.count,
      turn.internal.length === wanted.internal.count, "получено " + turn.internal.length);
    textChecks("внутреннее сообщение", internal, wanted.internal);

    textChecks("логи", turn.logs.join("\n"), wanted.logs);
    textChecks("путь", turn.path.join(" → "), wanted.path);
    textChecks("вызовы", turn.calls.join("\n"), wanted.calls);

    if (wanted.task) {
      const actual = turn.taskState;
      if (wanted.task.isClosed !== undefined) add(prefix + "задача в итоге закрыта = " + wanted.task.isClosed,
        !!actual && actual.isClosed === wanted.task.isClosed,
        "фактически: " + (!actual ? "ответ Pyrus не найден" : String(actual.isClosed)));
      if (wanted.task.currentStep !== undefined) add(prefix + "итоговый этап = " + wanted.task.currentStep,
        !!actual && actual.currentStep === wanted.task.currentStep,
        "фактически: " + (!actual ? "ответ Pyrus не найден" : String(actual.currentStep)));
      if (wanted.task.reopenedAfterReply !== undefined) add(prefix +
        "после ответа бота задача переоткрыта = " + wanted.task.reopenedAfterReply,
        !!actual && actual.reopenedAfterReply === wanted.task.reopenedAfterReply,
        "фактически: " + (!actual ? "ответ Pyrus не найден" : String(actual.reopenedAfterReply)));
      const laterText = actual ? actual.laterComments.map(comment => comment.text || "").join("\n") : "";
      textChecks("сообщения после ответа бота", laterText, wanted.task.laterComments);
    }

    if (wanted.noErrors) add(prefix + "нет ошибок платформы", turn.errors.length === 0,
      turn.errors.join("; "));
  });

  return checks;
}

function loadScenario(file, id) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new Error("не удалось прочитать сценарии " + file + ": " + e.message); }
  const scenarios = Array.isArray(doc) ? doc : doc.scenarios;
  if (!Array.isArray(scenarios)) throw new Error("в " + file + " нет массива scenarios");
  const scenario = scenarios.find(s => s && s.id === id);
  if (!scenario) throw new Error("сценарий '" + id + "' не найден в " + file);
  return scenario;
}

function renderChecks(scenario, checks) {
  const passed = checks.filter(c => c.ok).length;
  const lines = ["", "========================================================",
    "ПРОВЕРКА СЦЕНАРИЯ: " + scenario.id + " — " + scenario.title,
    "========================================================"];
  checks.forEach(c => lines.push("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.label +
    (!c.ok && c.detail ? "\n        " + c.detail : "")));
  lines.push("", "ИТОГ: " + (passed === checks.length ? "PASS" : "FAIL") +
    " (" + passed + "/" + checks.length + ")");
  return lines;
}

function parseArgs(argv) {
  const options = {
    sources: [], withPrompt: false, scenarioId: null,
    scenariosFile: DEFAULT_SCENARIOS, outFile: null, listScenarios: false
  };
  const valueAfter = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("после " + flag + " требуется значение");
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt") options.withPrompt = true;
    else if (arg === "--scenario") options.scenarioId = valueAfter(arg, i++);
    else if (arg === "--scenarios") options.scenariosFile = path.resolve(valueAfter(arg, i++));
    else if (arg === "--out") options.outFile = path.resolve(valueAfter(arg, i++));
    else if (arg === "--list-scenarios") options.listScenarios = true;
    else if (arg.startsWith("--")) throw new Error("неизвестный флаг " + arg);
    else options.sources = options.sources.concat(arg.split(",").map(s => s.trim()).filter(Boolean));
  }
  return options;
}

function usage() {
  return [
    "Использование:",
    "  node tools/read-trace.js <папка-или-json> [ещё-путь] [--prompt]",
    "  node tools/read-trace.js <путь> --scenario <id> [--out result_report.txt]",
    "  node tools/read-trace.js --list-scenarios"
  ].join("\n");
}

function listScenarios(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return (doc.scenarios || []).map(s => s.id + " — " + s.title).join("\n");
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (e) { process.stderr.write("Ошибка: " + e.message + "\n" + usage() + "\n"); return 1; }

  if (options.listScenarios) {
    try { process.stdout.write(listScenarios(options.scenariosFile) + "\n"); return 0; }
    catch (e) { process.stderr.write("Ошибка: " + e.message + "\n"); return 1; }
  }
  if (!options.sources.length) {
    process.stderr.write(usage() + "\n");
    return 1;
  }

  const documents = options.sources.map(readSource);
  const lines = [];
  documents.forEach(document => lines.push(...renderDocument(document, options.withPrompt)));

  let failed = documents.some(document => document.errors.length > 0);
  if (options.scenarioId) {
    try {
      if (options.sources.length !== 1) {
        throw new Error("сценарий можно проверять только по одному источнику; " +
          "запустите отдельную команду для каждого чата");
      }
      const scenario = loadScenario(options.scenariosFile, options.scenarioId);
      const turns = documents.reduce((all, document) => all.concat(document.turns), [])
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const checks = validateScenario(turns, scenario);
      lines.push(...renderChecks(scenario, checks));
      if (!checks.length || checks.some(c => !c.ok)) failed = true;
    } catch (e) {
      lines.push("", "ОШИБКА ПРОВЕРКИ: " + e.message);
      failed = true;
    }
  }

  const output = lines.join("\n") + "\n";
  if (options.outFile) fs.writeFileSync(options.outFile, output, "utf8");
  else process.stdout.write(output);
  return failed ? 2 : 0;
}

module.exports = {
  cut, visibleText, findWebhook, taskFromPost, postedCommentIndex, taskStateFromPost,
  filesOf, turnsOf, readSource, renderDocument,
  validateScenario, loadScenario, renderChecks, parseArgs, main
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
