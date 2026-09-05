// Local tools/tests resolve public integration IDs from the checked project profile.
// Runtime functions keep the concrete IDs that Agent Platform rewrites on import.
const fs = require("fs");
const path = require("path");
function projectBindings(root = path.resolve(__dirname, "..")) {
  const manifest = fs.readFileSync(path.join(root, "manifest.yml"), "utf8");
  const match = /^project-key:\s*([^\r\n]+)/m.exec(manifest);
  const key = match && match[1].trim();
  const profiles = ["dev", "prod"].map(name => JSON.parse(fs.readFileSync(path.join(root, "tools/environments", name + ".json"), "utf8")));
  const matches = profiles.filter(p => p.projectKey && p.projectKey === key);
  if (matches.length !== 1) throw new Error("Project identity must match exactly one registered environment profile.");
  return matches[0];
}
module.exports = { projectBindings };
