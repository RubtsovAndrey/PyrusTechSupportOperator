// Read-only deployment gate. Profiles contain public identifiers, never secrets.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { parseYaml } = require("../tests/graph");

function checkEnvironment(root, environment, branch, bootstrap = false) {
  const errors = [];
  if (!["dev", "prod"].includes(environment)) return ["Select dev or prod explicitly."];
  const profile = JSON.parse(fs.readFileSync(path.join(root, "tools/environments", environment + ".json"), "utf8"));
  const read = rel => parseYaml(fs.readFileSync(path.join(root, rel), "utf8"));
  if (profile.environment !== environment) errors.push("Profile environment does not match its filename.");
  const expectedBranch = environment === "dev" ? "dev" : "main";
  if (profile.branch !== expectedBranch || branch !== expectedBranch) {
    errors.push("Environment " + environment + " requires branch " + expectedBranch + "; current branch: " + branch);
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, profile.configTemplate), "utf8"));
  // Both environments are still test-only. Enabling real forms is a separate migration.
  if (Object.keys(config.forms || {}).sort().join() !== "2430464,2454249" ||
      config.subtaskFormId !== 2454249 || config.forms["2430464"].role !== "chat" ||
      config.forms["2454249"].role !== "ticket" ||
      Object.values(config.forms).some(f => f.environment !== "test" || f.knowledgeExecution !== "handover_only")) {
    errors.push("The migration config template must remain test-only and handover_only.");
  }
  const manifest = read("manifest.yml");
  const webhook = read("nodes/triggers/webhook/" + profile.webhookNodeId + ".yml");
  if (bootstrap) {
    if (environment !== "dev" || profile.lifecycle !== "awaiting-project") errors.push("Bootstrap is only for an unregistered dev project.");
    if (webhook.parameters.url != null) errors.push("Bootstrap must not carry the current project's webhook URL.");
    if (profile.projectKey || profile.databaseKey || profile.webhookUrl) errors.push("Bootstrap profile must not claim verified project bindings.");
    return errors;
  }
  if (!["preproduction", "test"].includes(profile.lifecycle)) {
    errors.push("Project bindings are not registered for this environment; import/publication is not ready.");
    return errors;
  }
  for (const key of ["projectKey", "webhookUrl", "databaseKey"]) {
    if (typeof profile[key] !== "string" || !profile[key]) errors.push("Missing binding: " + key);
  }
  if (errors.length) return errors;
  if (manifest["project-key"] !== profile.projectKey) errors.push("manifest.yml identifies a different project.");
  if (webhook.id !== profile.webhookNodeId || webhook.parameters.url !== profile.webhookUrl) errors.push("Pyrus webhook does not match this environment.");
  const db = read("integrations/databases/" + profile.databaseKey + ".yml");
  if (db.key !== profile.databaseKey || db.scope !== "PROJECT") errors.push("State database must be the registered PROJECT-scoped integration.");
  if (environment === "dev") {
    const prod = JSON.parse(fs.readFileSync(path.join(root, "tools/environments/prod.json"), "utf8"));
    if (prod.projectKey === profile.projectKey || prod.webhookUrl === profile.webhookUrl) errors.push("Dev must have its own project identity and webhook.");
  }
  return errors;
}

if (require.main === module) {
  try {
    const [environment, ...flags] = process.argv.slice(2);
    if (flags.some(f => f !== "--bootstrap")) throw new Error("Unknown argument.");
    const root = cp.execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const branch = cp.execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
    const errors = checkEnvironment(root, environment, branch, flags.includes("--bootstrap"));
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Environment files verified: " + environment + " / " + branch +
      (flags.includes("--bootstrap") ? " (IMPORT SEED ONLY; do not publish)" : " (runtime DB values and publication not verified)"));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { checkEnvironment };
