// Bounded boundary for the tool-less Knowledge Query Planner. The model may only add two
// semantic search formulations. The original partner problem and handover reason are
// copied from code-owned context, never from its JSON.

function lastJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = String(value || "").replace(/```json/gi, "").replace(/```/g, "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(source.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed);
        } catch (e) {
          // A later complete object may still be valid.
        }
        start = -1;
      }
    }
  }
  return objects.length ? objects[objects.length - 1] : null;
}

function clean(value) {
  const query = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return query.length > 180 ? query.slice(0, 180).trim() : query;
}

function key(value) {
  return String(value || "").toLowerCase().replace(/ё/g, "е")
    .replace(/[^0-9a-zа-я]+/g, " ").replace(/\s+/g, " ").trim();
}

const seed = AgentContext.getValue({ key: "operatorSearchSeed" }) || {};
const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = seed.taskId || dialog.taskId || null;
const original = clean(seed.query || dialog.problemSummary || dialog.incomingText || "");
const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : raw);
const parsed = lastJsonObject(text);
const proposed = parsed && parsed.kind === "search_queries" && Array.isArray(parsed.queries)
  ? parsed.queries : [];
const queries = [];
const seen = {};

function add(value) {
  if (/https?:\/\//i.test(String(value || ""))) return;
  const query = clean(value);
  const normalized = key(query);
  if (!normalized || normalized.length < 3 || seen[normalized]) return;
  seen[normalized] = true;
  queries.push(query);
}

add(original);
for (let i = 0; i < proposed.length && queries.length < 3; i++) add(proposed[i]);

const result = {
  taskId: taskId,
  reason: seed.reason || "подходящей утверждённой тематики нет",
  originalQuery: original || null,
  searchQueries: queries
};
AgentContext.putValue({ key: "operatorSearchQueries", value: result });

if (queries.length > 1) {
  Log.info({ message: "parseOperatorQueries: accepted " + (queries.length - 1) +
    " semantic search variants for task " + String(taskId || "?") });
} else if (original) {
  Log.warn({ message: "parseOperatorQueries: planner supplied no usable variant; using the original query" });
}

return result;
