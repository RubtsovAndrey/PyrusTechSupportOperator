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
            return { action: 'escalate', reason: 'Failed to parse LLM response' };
        }
    } else {
        return { action: 'escalate', reason: 'No JSON found in LLM response' };
    }
}

// Persist useful fields to AgentContext for downstream functions
if (parsed.unitFullName) AgentContext.putValue({ key: "unitFullName", value: parsed.unitFullName });
if (parsed.componentName) AgentContext.putValue({ key: "componentName", value: parsed.componentName });
if (parsed.unit) AgentContext.putValue({ key: "unit", value: parsed.unit });
if (parsed.business) AgentContext.putValue({ key: "business", value: parsed.business });
if (parsed.problemSummary) AgentContext.putValue({ key: "problemSummary", value: parsed.problemSummary });
if (parsed.topicKey) AgentContext.putValue({ key: "topicKey", value: parsed.topicKey });
if (parsed.replyText) AgentContext.putValue({ key: "replyText", value: parsed.replyText });

return parsed;
