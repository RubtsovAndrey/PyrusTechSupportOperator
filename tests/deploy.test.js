const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { ROOT, suite } = require("./harness");
const { checkEnvironment } = require("../tools/check-environment");

async function main() {
  const t = suite("environment isolation and deployment branches");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pyrus-deploy-test-"));
  const repo = path.join(tmp, "working");
  const remote = path.join(tmp, "remote.git");
  const git = (...args) => cp.execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (rel, text) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const copy = rel => write(rel, fs.readFileSync(path.join(ROOT, rel)));
  const deploy = (...args) => cp.spawnSync("pwsh", ["-NoProfile", "-File", "tools/deploy.ps1", ...args], { cwd: repo, encoding: "utf8", timeout: 60000 });
  const commit = msg => { git("add", "."); git("commit", "-m", msg); };
  try {
    fs.mkdirSync(repo);
    for (const rel of ["tools/deploy.ps1", "tools/check-environment.js", "tools/environments/dev.json", "tools/environments/prod.json",
      "docs/environments/dev-config.json", "docs/environments/prod-config.json", "tests/graph.js", "tests/harness.js",
      "integrations/databases/1000299722-pyrus_bot_database-hul.yml", "credentials/custom/1000299722-pyrustoken-lef.yml"]) copy(rel);
    const profile = JSON.parse(fs.readFileSync(path.join(repo, "tools/environments/prod.json")));
    write("manifest.yml", "schema-version: 1.0\nproject-key: " + profile.projectKey + "\n");
    const hookRel = "nodes/triggers/webhook/trigger_webhook_pyrus.yml";
    const hook = "id: trigger_webhook_pyrus\nparameters:\n  url: " + profile.webhookUrl + "\n";
    write(hookRel, hook);
    write("tests/run.js", 'console.log("fixture checks passed");\n');
    write("docs/preserved.md", "local docs\n");
    git("init", "-b", "main"); git("config", "user.name", "Deployment test"); git("config", "user.email", "test@example.invalid");
    commit("initial");
    git("init", "--bare", remote); git("remote", "add", "origin", remote); git("push", "origin", "main");
    const initial = git("rev-parse", "HEAD");
    t.check("existing test project matches the future-prod profile", checkEnvironment(repo, "prod", "main").length === 0);
    t.check("main cannot be deployed as dev", checkEnvironment(repo, "dev", "main").length > 0);
    t.check("dev is blocked until new bindings are registered", checkEnvironment(repo, "dev", "dev").length > 0);
    t.check("bootstrap cannot reuse the current webhook", checkEnvironment(repo, "dev", "dev", true).length > 0);
    write("manifest.yml", "project-key: foreign-project\n");
    t.check("a foreign project identity is rejected", checkEnvironment(repo, "prod", "main").some(e => /manifest/.test(e)));
    git("restore", "manifest.yml");
    write("integrations/databases/1000299722-pyrus_bot_database-hul.yml", "key: " + profile.databaseKey + "\nscope: ACCOUNT\n");
    t.check("account-wide state storage is rejected", checkEnvironment(repo, "prod", "main").some(e => /PROJECT/.test(e)));
    git("restore", "integrations");
    let r = deploy();
    t.check("no target is a non-interactive failure", r.status !== 0 && /specify -Environment/.test(r.stdout), r.stderr || r.stdout);
    r = deploy("-Environment", "dev");
    t.check("wrong branch stops before push", r.status !== 0 && /requires branch dev/.test(r.stdout) && git("rev-parse", "origin/main") === initial, r.stdout);
    r = deploy("-Environment", "prod");
    t.check("no-op on the right target leaves Git unchanged", r.status === 0 && /Nothing to push/.test(r.stdout), r.stderr || r.stdout);

    git("switch", "-c", "dev"); write(hookRel, hook.replace(profile.webhookUrl, "null")); commit("bootstrap dev");
    r = deploy("-Environment", "dev", "-BootstrapDev");
    t.check("explicit bootstrap creates only dev and leaves main intact", r.status === 0 && git("rev-parse", "origin/dev") === git("rev-parse", "HEAD") && git("rev-parse", "origin/main") === initial, r.stderr || r.stdout);
    r = deploy("-Environment", "dev", "-BootstrapDev");
    t.check("bootstrap cannot overwrite an existing remote dev branch", r.status !== 0 && /already exists/.test(r.stdout), r.stdout);
    r = deploy("-Environment", "dev");
    t.check("bootstrap success does not unlock ordinary dev deployment", r.status !== 0 && /not registered/.test(r.stderr + r.stdout), r.stderr || r.stdout);

    // Platform exports erase directories unknown to the platform. Exercise the real merge.
    git("switch", "main");
    const other = path.join(tmp, "platform");
    cp.execFileSync("git", ["clone", "-b", "main", remote, other], { stdio: "pipe" });
    const platformGit = (...args) => cp.execFileSync("git", ["-C", other, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    platformGit("config", "user.name", "Platform test"); platformGit("config", "user.email", "platform@example.invalid");
    platformGit("rm", "-r", "docs", "tests", "tools"); platformGit("commit", "-m", "platform export"); platformGit("push", "origin", "main");
    write("docs/preserved.md", "new local docs\n"); commit("local docs update");
    r = deploy("-Environment", "prod");
    t.check("merge restores protected profiles, tools and docs before validation", r.status === 0 && fs.readFileSync(path.join(repo, "docs/preserved.md"), "utf8") === "new local docs\n" && git("rev-parse", "origin/main") === git("rev-parse", "HEAD"), r.stderr || r.stdout);

    platformGit("pull", "--ff-only", "origin", "main");
    fs.writeFileSync(path.join(other, "manifest.yml"), "project-key: foreign-project\n");
    platformGit("add", "manifest.yml"); platformGit("commit", "-m", "foreign binding"); platformGit("push", "origin", "main");
    const before = git("rev-parse", "HEAD");
    r = deploy("-Environment", "prod");
    t.check("incoming export cannot silently change the deployment project", r.status !== 0 && /different project/.test(r.stdout + r.stderr) && git("rev-parse", "HEAD") === before, r.stderr || r.stdout);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return t.report();
}
module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
