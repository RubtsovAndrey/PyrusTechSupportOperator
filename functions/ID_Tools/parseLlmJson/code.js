var raw = Context.getLastFunctionResult();
var text = typeof raw === 'string' ? raw : (raw && raw.content ? raw.content : String(raw || ''));

var cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

try {
    return JSON.parse(cleaned);
} catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            return JSON.parse(match[0]);
        } catch (e2) {
            return { action: 'escalate', reason: 'Failed to parse LLM response' };
        }
    }
    return { action: 'escalate', reason: 'No JSON found in LLM response' };
}
