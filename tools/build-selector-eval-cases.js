// Private fixed KB inputs stay outside Git. This script consumes previously extracted
// comparisons, not credentials, live searches or Pyrus webhook payloads.
const fs = require("fs");
const crypto = require("crypto");
function extractRequest(source) {
  if (source && source.request) return source.request;
  const requests = new Map();
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const data = node.relatedEvent && node.relatedEvent.data;
    if (node.label === "Системная функция: AgentContext.putValue" && data &&
        data.key === "operatorEvidenceRequest" && data.value && data.value.candidates) {
      const request = data.value;
      requests.set(JSON.stringify({ query: request.query, candidates: request.candidates }), request);
    }
    (node.children || []).forEach(visit);
  }
  visit(source);
  if (requests.size !== 1) throw new Error("Expected exactly one distinct Selector input in the trace.");
  return [...requests.values()][0];
}
function makeBundle(success, empty, clientAvatar) {
  const cases = {};
  function add(id, source, filter, requirePhoto) {
    const request = extractRequest(source);
    if (!request || typeof request.query !== "string" || !Array.isArray(request.candidates)) throw new Error("Missing selector request.");
    const candidates = JSON.parse(JSON.stringify(request.candidates.filter(filter)));
    const requiredEvidence = requirePhoto ? [{ candidateId: "c1", passageId: "p1", contains: ["300×300"] }] : [];
    if (requirePhoto && !candidates.some(c => c.id === "c1" && c.passages.some(p => p.id === "p1" && p.text.includes("300×300")))) {
      throw new Error("Expected photo passage is not present in " + id);
    }
    const data = { query: request.query, candidates };
    cases[id] = { ...data, requiredEvidence,
      inputSha256: crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex") };
  }
  add("success-full", success, () => true, true);
  add("empty-full", empty, () => true, true);
  add("empty-single", empty, c => c.id === "c1", true);
  add("noise-only", empty, c => c.id !== "c1", false);
  if (clientAvatar) {
    const request = extractRequest(clientAvatar);
    if (!request.candidates.some(c => c.id === "c0" && c.passages.some(p =>
      p.id === "p20" && p.text.includes("ClientUUId") && p.text.includes("клиент")))) {
      throw new Error("Expected client-avatar distractor c0/p20 is missing.");
    }
    add("client-avatar-full", clientAvatar, () => true, true);
    add("client-avatar-noise", clientAvatar, c => c.id !== "c1", false);
  }
  return { version: 1, cases };
}
if (require.main === module) {
  const [success, empty, out, clientAvatar] = process.argv.slice(2);
  if (!success || !empty || !out || ![5, 6].includes(process.argv.length)) {
    console.error("Usage: node tools/build-selector-eval-cases.js success.json empty.json /tmp/selector_eval_cases.json [client-avatar.json]");
    process.exitCode = 1;
  } else {
    const bundle = makeBundle(JSON.parse(fs.readFileSync(success)), JSON.parse(fs.readFileSync(empty)),
      clientAvatar ? JSON.parse(fs.readFileSync(clientAvatar)) : undefined);
    fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
    console.log("Prepared " + Object.keys(bundle.cases).length + " cases in " + out);
  }
}
module.exports = { makeBundle, extractRequest };
