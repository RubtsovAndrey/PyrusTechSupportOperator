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

// Models drop the JSON wrapper from time to time and answer in plain prose. Whether
// that is recoverable depends on what the stage produces:
//   intake / solver     -> the payload IS text for the partner, so the prose is usable
//                          and sending it beats escalating a healthy dialog.
//   routing / confirmation -> the payload is a control decision (route, status) that
//                          prose cannot supply; guessing it would send the dialog down
//                          an arbitrary branch, so fail and let a human take over.
const PROSE_FALLBACK = {
  intake: text => ({ action: "clarify", clarifyingQuestion: text }),
  solver: text => ({ replyText: text })
};

if (!parsed || typeof parsed !== "object") {
  const recover = PROSE_FALLBACK[String(stage || "")];
  if (recover && cleaned) {
    Log.warn({ message: "parseAgentJson(" + stage + "): answer was not JSON, using it as plain text" });
    parsed = recover(cleaned);
  } else {
    throw new Error("parseAgentJson(" + stage + "): agent answer is not JSON: " + cleaned.slice(0, 300));
  }
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
    // The facts this stage just resolved are republished as a note so the agents that
    // run later in the same pass (routing, solver) can see the unit and the topic.
    // A labelled note is followed far more reliably by a small model than the nested
    // JSON the platform builds out of the putValue keys.
    AgentContext.putValue({ key: "dialog", value: Object.assign({}, dialog, data) });
    AgentContext.addNote({
      text: [
        "Уточнённые данные по обращению:",
        "- Юнит: " + (data.unitFullName || "не определён"),
        "- Проблема: " + (data.problemSummary || "не описана"),
        "- Email: " + (data.email || "не указан"),
        "- Тематика: " + (data.topicKey || "не определена")
      ].join("\n")
    });
  } catch (e) {
    Log.warn({ message: "parseAgentJson: state write failed: " + e });
  }
}

parsed.taskId = taskId;
parsed.agentStage = String(stage || "");
return parsed;
