const DB_ID = "1000299722-pyrus_bot_database-hul";

// Facts each agent is allowed to contribute to the task document.
const PERSISTED = ["unitFullName", "componentName", "problemSummary", "email", "topicKey"];

function normalize(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

// The agent is told to copy fullName from matchUnit, but a wrong unit written into
// Pyrus is worse than no unit: accept the value only if the catalog really has it.
function validateUnit(candidate) {
  if (!candidate) return null;
  const wanted = normalize(candidate);
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "unitCatalog" });
    const raw = doc && doc.value ? (Array.isArray(doc.value) ? doc.value : doc.value.items) : null;
    if (!Array.isArray(raw)) {
      Log.warn({ message: "parseAgentJson: unitCatalog missing, cannot validate unit" });
      return null;
    }
    const hit = raw.find(item => normalize(item) === wanted);
    return hit ? String(hit).trim() : null;
  } catch (e) {
    Log.warn({ message: "parseAgentJson: unitCatalog read failed: " + e });
    return null;
  }
}

const raw = Context.getLastFunctionResult();
const text = typeof raw === "string" ? raw : (raw && raw.content ? raw.content : String(raw || ""));
const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();

let parsed = null;
try {
  parsed = JSON.parse(cleaned);
} catch (e) {
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      parsed = JSON.parse(match[0]);
    } catch (e2) {
      parsed = null;
    }
  }
}

// Failing loudly routes the node through its error edge to the operator handover,
// which is safer than inventing a decision the agent never made.
if (!parsed || typeof parsed !== "object") {
  throw new Error("parseAgentJson(" + stage + "): agent answer is not JSON: " + cleaned.slice(0, 300));
}

const dialog = AgentContext.getValue({ key: "dialog" }) || {};
const taskId = dialog.taskId || null;

if (parsed.unitFullName) parsed.unitFullName = validateUnit(parsed.unitFullName);

if (taskId) {
  try {
    const doc = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    const state = (doc && doc.value) || {};
    const data = Object.assign({}, state.data);
    PERSISTED.forEach(key => {
      if (parsed[key]) data[key] = parsed[key];
    });
    Db.put({
      dbIntegration: DB_ID,
      documentKey: "state:" + taskId,
      value: Object.assign({}, state, { data: data, updatedAt: Date.now() })
    });
    // Keep the LLM-visible snapshot consistent with what was just stored.
    AgentContext.putValue({ key: "dialog", value: Object.assign({}, dialog, data) });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: state write failed: " + e });
  }
}

parsed.taskId = taskId;
parsed.agentStage = String(stage || "");
return parsed;
