var raw = Context.getLastFunctionResult();
var text = typeof raw === 'string' ? raw : (raw && raw.content ? raw.content : String(raw || ''));

var cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

var parsed;
try {
    parsed = JSON.parse(cleaned);
} catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            parsed = JSON.parse(match[0]);
        } catch (e2) {
            return { action: 'escalate', reason: 'Failed to parse LLM response', taskId: AgentContext.getValue({ key: "taskId" }) };
        }
    } else {
        return { action: 'escalate', reason: 'No JSON found in LLM response', taskId: AgentContext.getValue({ key: "taskId" }) };
    }
}

// Persist useful fields to AgentContext for downstream functions
if (parsed.componentName) AgentContext.putValue({ key: "componentName", value: parsed.componentName });
if (parsed.unit) AgentContext.putValue({ key: "unit", value: parsed.unit });
if (parsed.business) AgentContext.putValue({ key: "business", value: parsed.business });
if (parsed.problemSummary) AgentContext.putValue({ key: "problemSummary", value: parsed.problemSummary });
if (parsed.topicKey) AgentContext.putValue({ key: "topicKey", value: parsed.topicKey });
if (parsed.replyText) AgentContext.putValue({ key: "replyText", value: parsed.replyText });
if (parsed.email) AgentContext.putValue({ key: "email", value: parsed.email });

// Resolve exact unitFullName from catalog — don't trust LLM to copy it correctly
if (parsed.unit || parsed.unitFullName) {
    var resolvedUnit = null;
    try {
        var r = Db.get({ dbIntegration: "1000299722-pyrus_bot_database-hul", documentKey: "unitCatalog" });
        if (r && r.value) {
            var items = Array.isArray(r.value) ? r.value : (r.value.items || r.value);
            if (Array.isArray(items)) {
                var searchTerm = String(parsed.unit || parsed.unitFullName).toLowerCase()
                    .replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").trim();
                var searchTokens = searchTerm.split(/[\s-]+/).filter(Boolean);
                var bestItem = null, bestScore = 0;
                for (var i = 0; i < items.length; i++) {
                    var itemLower = String(items[i]).toLowerCase()
                        .replace(/ё/g, "е").replace(/[.,«»'"()\[\]]/g, " ").trim();
                    var itemTokens = itemLower.split(/[\s-]+/).filter(Boolean);
                    var overlap = 0;
                    for (var j = 0; j < searchTokens.length; j++) {
                        if (itemTokens.indexOf(searchTokens[j]) >= 0) overlap++;
                    }
                    var score = overlap / searchTokens.length;
                    if (score > bestScore) { bestScore = score; bestItem = items[i]; }
                }
                if (bestItem && bestScore >= 0.8) {
                    resolvedUnit = String(bestItem).trim();
                }
            }
        }
    } catch (e) {
        Log.info({ message: "parseLlmJson: unit catalog lookup error: " + e });
    }
    parsed.unitFullName = resolvedUnit || parsed.unitFullName;
    AgentContext.putValue({ key: "unitFullName", value: parsed.unitFullName });
}

// Inject taskId from AgentContext so downstream functions get it via Context.getLastFunctionResult()
parsed.taskId = AgentContext.getValue({ key: "taskId" });

return parsed;
