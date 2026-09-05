// Test-menu diagnostics only. No Db writes, Pyrus calls, or replay of webhook payloads.
if (Context.getProjectShortName() !== expectedProject || Context.isTestChannel() !== true) {
  throw new Error("Dev setup check requires the registered dev project and the Test menu.");
}
const checks = {};
let config = null;
let catalog = null;
try {
  const doc = Db.get({ dbIntegration: dbIntegration, documentKey: "config" });
  config = doc && doc.value;
  const forms = config && config.forms;
  const valid = forms && Object.keys(forms).sort().join() === "2430464,2454249" &&
    forms["2430464"] && forms["2430464"].role === "chat" &&
    forms["2454249"] && forms["2454249"].role === "ticket" &&
    Object.keys(forms).every(id => forms[id].environment === "test" && forms[id].knowledgeExecution === "handover_only") &&
    config.subtaskFormId === 2454249;
  checks.config = valid ? "ok" : (config ? "review_required" : "missing");
} catch (e) { checks.config = "unavailable"; }
try {
  const doc = Db.get({ dbIntegration: dbIntegration, documentKey: "knowledge_catalog" });
  catalog = doc && doc.value;
  checks.catalog = catalog && Array.isArray(catalog.topics) && catalog.topics.length > 0 ? "present" : "missing";
} catch (e) { checks.catalog = "unavailable"; }

let token = null;
try {
  const credential = await Credentials.get({ credentialKey: kbCredential });
  token = credential && credential.token ? String(credential.token).trim() : null;
  checks.kbCredential = token ? "present" : "missing";
} catch (e) { checks.kbCredential = "unavailable"; }
checks.kbToolDiscovery = "skipped";
if (token) {
  try {
    const response = await Http.post({
      url: "https://knowledgebase.dodois.io/mcp",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: "dev-setup", method: "tools/list", params: {} }
    });
    let body = response && response.body;
    if (typeof body === "string") {
      const text = body.trim();
      if (text.charAt(0) === "{") body = JSON.parse(text);
      else {
        const frames = text.split(/\r?\n\r?\n/);
        body = null;
        for (let i = 0; i < frames.length; i++) {
          const data = frames[i].split(/\r?\n/).filter(line => line.indexOf("data:") === 0)
            .map(line => line.slice(5).trim()).join("\n");
          if (data) { const parsed = JSON.parse(data); if (parsed.id === "dev-setup") body = parsed; }
        }
      }
    }
    const names = body && !body.error && body.result && Array.isArray(body.result.tools)
      ? body.result.tools.map(tool => tool.name) : [];
    checks.kbToolDiscovery = response && response.status >= 200 && response.status < 300 &&
      names.indexOf("search_content") >= 0 && names.indexOf("get_content") >= 0 ? "ok" : "failed";
  } catch (e) { checks.kbToolDiscovery = "failed"; }
}
for (const entry of [{ label: "defaultModel", key: defaultModel }, { label: "selectorModel", key: selectorModel }]) {
  try {
    const response = await Llm.sendRequest({ llmModelKey: entry.key,
      messages: [{ role: "user", text: 'Return only this JSON: {"ok":true}' }], tools: [], maxCompletionTokens: 512 });
    const parsed = response && typeof response.text === "string" ? JSON.parse(response.text) : null;
    checks[entry.label] = parsed && parsed.ok === true &&
      (!Array.isArray(response.toolCalls) || response.toolCalls.length === 0) ? "ok" : "unexpected_response";
  } catch (e) { checks[entry.label] = "failed"; }
}
const result = { kind: "dev_setup_check", checks: checks,
  topicCount: catalog && Array.isArray(catalog.topics) ? catalog.topics.length : 0,
  note: "Readiness observations only. Does not verify article access, catalog version, bot identity or publication." };
// Do not include exceptions: adapters may embed request headers or bodies in them.
Log.info({ message: "inspectDevSetup: " + JSON.stringify(result) });
return result;
