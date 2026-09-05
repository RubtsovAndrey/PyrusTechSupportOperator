// Private fixed KB inputs stay outside Git. This script consumes previously extracted
// comparisons, not credentials, live searches or Pyrus webhook payloads.
const fs = require("fs");
const crypto = require("crypto");
function makeBundle(success, empty) {
  const cases = {};
  function add(id, source, filter, requirePhoto) {
    const request = source.request;
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
  return { version: 1, cases };
}
if (require.main === module) {
  const [success, empty, out] = process.argv.slice(2);
  if (!success || !empty || !out || process.argv.length !== 5) {
    console.error("Usage: node tools/build-selector-eval-cases.js success.json empty.json /tmp/selector_eval_cases.json");
    process.exitCode = 1;
  } else {
    const bundle = makeBundle(JSON.parse(fs.readFileSync(success)), JSON.parse(fs.readFileSync(empty)));
    fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
    console.log("Prepared " + Object.keys(bundle.cases).length + " cases in " + out);
  }
}
module.exports = { makeBundle };
