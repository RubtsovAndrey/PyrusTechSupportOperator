// ── Обход графа так, как его обходит платформа ──
//
// Отдельные функции уже проверены поштучно, но «плавно ли идёт разговор» — свойство не
// функции, а их последовательности: какой узел выбрало условие, сколько витков стоил
// сценарий, что услышал партнёр. Проверить это можно было только живым ботом, то есть
// глазами и по логам, поэтому дефекты вида «уточняющий вопрос партнёра трактуется как
// „не помогло“» и находились у партнёра, а не в тестах.
//
// Здесь граф читается из тех же `nodes/**/*.yml`, которые уезжают на платформу: любое
// расхождение между тем, что проверено, и тем, что развёрнуто, снова сделало бы тесты
// зелёными над сломанным ботом.
//
// Своего YAML-разбора здесь ровно столько, сколько нужно графу: зависимостей у набора
// тестов нет намеренно (`node tests/run.js` без npm install), а формат этих файлов пишет
// платформа, а не человек, и он поэтому однообразен.
const fs = require("fs");
const path = require("path");
const { loadFunction, ROOT } = require("./harness");

function scalar(s) {
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "{}") return {};
  if (s === "[]") return [];
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.charAt(0) === '"') {
    try { return JSON.parse(s); } catch (e) { return s.slice(1).replace(/"$/, ""); }
  }
  if (s.charAt(0) === "'") return s.slice(1).replace(/'$/, "");
  return s;
}

// Подмножество YAML, которое пишет экспорт платформы: отображения, списки (в том числе
// списки отображений), блочные скаляры `|` и её собственный перенос длинных строк —
// обратный слэш в конце строки, продолжение со следующей.
function parseYaml(src) {
  const lines = [];
  const raw = src.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    if (/^---\s*$/.test(raw[i])) continue;
    let line = raw[i];
    // Перенос платформы: `"…текст\` + `  \ продолжение"`. Ведущий `\ ` на продолжении —
    // её способ сохранить значащий пробел, поэтому он снимается вместе с отступом.
    while (/\\$/.test(line) && i + 1 < raw.length) {
      line = line.slice(0, -1) + raw[++i].replace(/^\s+/, "").replace(/^\\ /, " ");
    }
    lines.push(line);
  }

  let pos = 0;
  const indentOf = l => /^(\s*)/.exec(l)[1].length;

  // Ближайшая значащая строка, не сдвигая курсор: нужна, чтобы отличить вложенное
  // отображение от списка, который в YAML разрешено писать на отступе САМОГО ключа.
  function peek() {
    for (let i = pos; i < lines.length; i++) {
      if (lines[i].trim() && !/^\s*#/.test(lines[i])) return lines[i];
    }
    return null;
  }

  // Одна пара «ключ: значение» в уже созданный объект. Вынесена, потому что нужна и
  // отображению, и элементу списка вида `- name: query`. `ind` — отступ самого ключа.
  function pair(target, text, ind) {
    const m = /^([^:]+):\s*(.*)$/.exec(text);
    if (!m) return;
    const key = m[1].trim();
    const rest = m[2];
    if (rest === "") {
      // `parameters:` со списком `- name: …` на нулевом отступе — так пишет схема функции,
      // и требование «строго глубже ключа» теряло весь список молча: у функции не
      // оказывалось ни одного параметра, а вызов получал undefined вместо значений.
      const ahead = peek();
      const sameLevelList = ahead && indentOf(ahead) === ind && /^-(\s|$)/.test(ahead.trim());
      target[key] = block(sameLevelList ? ind : ind + 1);
      return;
    }
    if (/^[|>][-+]?$/.test(rest)) {
      // Отступ блока задаёт его первая содержательная строка, а не догадка о ней:
      // в этих файлах блочные скаляры лежат и на двух пробелах глубже ключа, и на одном.
      const ahead = peek();
      const body = ahead && indentOf(ahead) > ind ? indentOf(ahead) : ind + 1;
      const buf = [];
      while (pos < lines.length && (lines[pos].trim() === "" || indentOf(lines[pos]) >= body)) {
        buf.push(lines[pos].slice(body));
        pos++;
      }
      target[key] = buf.join("\n").replace(/\n+$/, "");
      return;
    }
    target[key] = scalar(rest);
  }

  function block(indent) {
    let out = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (!line.trim() || /^\s*#/.test(line)) { pos++; continue; }
      const ind = indentOf(line);
      if (ind < indent) break;
      const text = line.trim();
      if (text.charAt(0) === "-" && (text.length === 1 || text.charAt(1) === " ")) {
        if (out === null) out = [];
        if (!Array.isArray(out)) break;
        const rest = text.slice(1).trim();
        pos++;
        if (/^[^:\s][^:]*:/.test(rest)) {
          const item = {};
          pair(item, rest, ind + 2);
          const more = block(ind + 2);
          // Элемент списка — отображение, чьи остальные ключи лежат на отступе «дефис + 2».
          if (more && !Array.isArray(more)) Object.assign(item, more);
          out.push(item);
        } else out.push(scalar(rest));
        continue;
      }
      if (out === null) out = {};
      if (Array.isArray(out)) break;
      pos++;
      pair(out, text, ind);
    }
    return out;
  }

  return block(0) || {};
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

// Порядок аргументов функции задаёт её schema.yml, а значения — узел графа. Раньше эти
// два списка сходились только в голове человека, писавшего тест: `loadFunction` получала
// имена параметров руками, и параметр, добавленный в схему, но не в тест, молча приезжал
// как undefined.
const schemaCache = {};
function paramNames(collection, fn) {
  const key = collection + "/" + fn;
  if (schemaCache[key]) return schemaCache[key];
  const file = path.join(ROOT, "functions", collection, fn, "schema.yml");
  const schema = parseYaml(fs.readFileSync(file, "utf8"));
  const names = (Array.isArray(schema.parameters) ? schema.parameters : []).map(p => p.name);
  schemaCache[key] = names;
  return names;
}

// Тип узла — по каталогу, в котором он лежит: сама платформа различает их так же
// (`nodes/agents`, `nodes/conditions`, `nodes/functions`, `nodes/triggers`).
function kindOf(rel) {
  if (rel.indexOf("nodes/agents/") === 0) return "agent";
  if (rel.indexOf("nodes/conditions/") === 0) return "condition";
  if (rel.indexOf("nodes/triggers/") === 0) return "trigger";
  return "function";
}

function loadGraph() {
  const nodes = {};
  walk(path.join(ROOT, "nodes"), []).filter(f => f.endsWith(".yml")).forEach(file => {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const y = parseYaml(fs.readFileSync(file, "utf8"));
    if (!y.id) return;
    const p = y.parameters || {};
    const node = {
      id: y.id,
      name: y.name || y.id,
      kind: kindOf(rel),
      file: rel,
      nextStep: y["next-step"] || null,
      nextErrorStep: y["next-error-step"] || null,
      falseStep: p["false-step"] || null,
      condition: p.condition || null,
      tools: Array.isArray(p.tools) ? p.tools : [],
      isTool: p["is-tool"] === true,
      collection: p.collection || null,
      fn: p["function"] || null,
      args: p.parameters && typeof p.parameters === "object" ? p.parameters : {}
    };
    if (node.kind === "function" && node.collection && node.fn) {
      node.names = paramNames(node.collection, node.fn);
      node.code = loadFunction("functions/" + node.collection + "/" + node.fn + "/code.js", node.names);
      // Значения, зашитые в узел (`outcome: clarify`). `filled-ai` заполняет модель, то
      // есть в вызове инструмента — здесь они приходят от подставного агента.
      node.values = node.names.map(n => {
        const a = node.args[n];
        return a && a.value !== undefined ? a.value : null;
      });
    }
    nodes[node.id] = node;
  });
  return nodes;
}

const conditionCache = {};
function evalCondition(expr, prev) {
  if (!conditionCache[expr]) {
    conditionCache[expr] = new Function("Context", "return (" + expr + ");");
  }
  return !!conditionCache[expr]({ getLastFunctionResult: () => prev });
}

// Один виток: от узла `start` до узла без продолжения. Платформа при падении узла уходит
// в его `next-error-step`, а при `null` тихо убивает ветку — партнёр остаётся без ответа
// вовсе, и это надо видеть в трассе, а не узнавать по тишине.
const MAX_STEPS = 200;

async function runTurn(graph, env, start, hooks) {
  const trace = [];
  let id = start;
  let steps = 0;
  while (id) {
    if (++steps > MAX_STEPS) throw new Error("граф не закончил виток за " + MAX_STEPS + " шагов, начиная с " + start);
    const node = graph[id];
    if (!node) throw new Error("узла " + id + " нет в графе");
    let next = null;
    if (node.kind === "condition") {
      const ok = evalCondition(node.condition, env.prev);
      trace.push({ id: id, name: node.name, kind: "condition", value: ok });
      next = ok ? node.nextStep : node.falseStep;
    } else {
      const entry = { id: id, name: node.name, kind: node.kind };
      trace.push(entry);
      try {
        if (node.kind === "trigger") next = node.nextStep;
        else if (node.kind === "agent") {
          env.prev = await hooks.agent(node, env);
          entry.value = env.prev;
          next = node.nextStep;
        } else {
          env.prev = await node.code(env, node.values);
          entry.value = env.prev;
          next = node.nextStep;
        }
      } catch (e) {
        entry.error = String(e && e.message ? e.message : e);
        next = node.nextErrorStep;
        if (!next) entry.dead = true;
      }
    }
    id = next;
  }
  return trace;
}

module.exports = { parseYaml, loadGraph, runTurn, evalCondition };
