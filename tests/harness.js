// Test harness for platform functions.
//
// Functions in functions/**/code.js are not modules: the platform wraps each file in an
// async function and injects the platform API (Context, Db, Log, Http, AgentContext) plus
// the parameters declared in schema.yml. That is why top-level `return` and `await` are
// legal there and why plain `node --check` rejects these files. The harness reproduces
// the same wrapper, so tests run the real production source with no edits to it.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// paramNames must match the `parameters` of the function's schema.yml, in order.
function loadFunction(relPath, paramNames) {
  const src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const names = paramNames || [];
  const factory = new Function(
    "Context", "AgentContext", "Db", "Log", "Http", "Rag", "Credentials", ...names,
    "return (async function(){\n" + src + "\n})();"
  );
  return (env, args) => factory(
    env.Context, env.AgentContext, env.Db, env.Log, env.Http, env.Rag, env.Credentials,
    ...(args || [])
  );
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// "data.email" -> walks into the payload and assigns. Mirrors the dotted-path form the
// platform requires: paths are relative to `value`, so they carry no `value.` prefix.
function setPath(root, dotted, value) {
  const parts = String(dotted).split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function getPath(root, dotted) {
  return String(dotted).split(".").reduce((n, p) => (n == null ? n : n[p]), root);
}

// options: { payload, prev, db, contextValues, onGet, failPost, failInternalPost }
function makeEnv(options) {
  const o = options || {};
  const db = clone(o.db) || {};

  // Every stored key whose payload satisfies the filter. Filters are matched against the
  // contents of `value`, which is what the platform does — so a filter naming `key` or
  // prefixing `value.` matches nothing here either.
  const matching = filters => {
    const f = filters || {};
    const names = Object.keys(f);
    if (!names.length) return [];
    return Object.keys(db).filter(k =>
      names.every(n => JSON.stringify(getPath(db[k], n)) === JSON.stringify(f[n])));
  };
  const notes = [];
  const values = clone(o.contextValues) || {};
  const posts = [];
  const gets = [];
  const updates = [];
  // Whole-document writes are recorded separately: they are the fallback path, and a test
  // must be able to tell a point write that worked from one that missed and was rescued.
  const puts = [];
  // Каждый запрос к RAG, чтобы тест мог проверить и то, что его НЕ делали.
  const rags = [];
  // Ключи, по которым код спрашивал секреты: порядок обращения — часть поведения.
  const creds = [];

  const env = {
    db, notes, values, posts, gets, updates, puts, rags, creds,
    prev: clone(o.prev) || {},
    Context: {
      getMessageContent: () => ({ payload: o.payload }),
      getLastFunctionResult: () => env.prev
    },
    AgentContext: {
      clearContext: () => {},
      addNote: a => notes.push(a.text),
      // The platform returns the notes as ONE string, newline-separated by time of
      // addition — not as a list (.agent/system-functions/AgentContext/getNotes.json:
      // output type is `string`). Modelled that way so code reading them cannot pass a
      // test on a shape the platform never produces.
      getNotes: () => notes.join("\n"),
      putValue: a => { values[a.key] = a.value; },
      getValue: a => values[a.key]
    },
    // Db.get returns a copy: a function must not be able to mutate stored state by
    // reference, or a test would pass while production corrupts the document.
    Db: {
      // The stored document is { key, value, createdAt, updatedAt } — `documentKey` is only
      // the name of the argument. This stub used to accept `documentKey` in a filter, which
      // is exactly why the tests were green while every write in production matched nothing.
      get: a => (db[a.documentKey] === undefined
        ? null
        : { key: a.documentKey, value: clone(db[a.documentKey]) }),
      put: a => { puts.push(a); db[a.documentKey] = clone(a.value); },
      delete: a => { delete db[a.documentKey]; },
      // Filters address fields **inside `value`**, proven on the live platform: a filter on
      // `key` or on `value.<field>` finds nothing, while `{ botHasReplied: true }` returned
      // four documents. The document key is therefore not filterable at all, which is why
      // every point write kept missing. Modelled here so a test cannot pass on addressing
      // the platform does not support.
      findByFilters: a => matching(a.filters).map(k => ({ key: k, value: clone(db[k]) })),
      // Only $set with dotted paths is modelled, which is all the code uses. Three platform
      // properties are reproduced deliberately: there is no upsert; the result reports how
      // many documents matched, so a filter that hits nothing is detectable; and the paths
      // are relative to `value`, exactly like the filters. The last one was measured on the
      // live platform: `$set: { plain: 1 }` landed in `value.plain`, while
      // `$set: { "value.prefixed": 1 }` built a nested `value.value.prefixed`.
      updateByFilters: a => {
        updates.push(a);
        const $set = (a.operator && a.operator.$set) || {};
        // MongoDB error 40: one update cannot write a path and one of its descendants at
        // the same time (`data` together with `data.handoverReason`). The live adapter
        // validates this even when the filter would match no document, so do it before
        // matching here as well. Without this rule the first webhook looked green locally
        // and produced an avoidable error plus a whole-document rescue on the platform.
        const paths = Object.keys($set);
        paths.forEach((p, i) => paths.slice(i + 1).forEach(q => {
          if (p.indexOf(q + ".") === 0 || q.indexOf(p + ".") === 0) {
            throw new Error("db 40: conflicting update paths " + p + " and " + q);
          }
        }));
        // An array as a $set value makes the live adapter answer 500 while converting it
        // into a BSON document. Thrown here so no test can rely on a write the platform
        // refuses to perform.
        //
        // At every depth, not just at the top. Checking only the top level is how this stub
        // was milder than the platform: `$set: { pendingOutcome: { fieldUpdates: [...] } }`
        // was recorded here as a successful point write while the platform answers 500 —
        // green tests over a write that never lands, the same class of false pass as the
        // `documentKey` filter above.
        const deepArray = v => Array.isArray(v) ||
          (!!v && typeof v === "object" && Object.keys(v).some(k => deepArray(v[k])));
        Object.keys($set).forEach(p => {
          if (deepArray($set[p])) {
            throw new Error("db 500: cannot convert ArrayNode to org.bson.Document for " + p);
          }
        });
        const keys = matching(a.filters);
        if (!keys.length) return { count: 0 };
        keys.forEach(k => {
          const value = clone(db[k]);
          Object.keys($set).forEach(p => setPath(value, p, clone($set[p])));
          db[k] = value;
        });
        return { count: keys.length };
      }
    },
    Log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    // Хранилище секретов платформы. `noCredentials: true` убирает неймспейс целиком: код,
    // который читает токен, обязан отличать «неймспейса нет» от «токен пустой», иначе
    // отсутствие доступа выглядит как «ничего не нашлось».
    Credentials: o.noCredentials ? undefined : {
      get: a => {
        creds.push(a.credentialKey);
        const token = (o.credentials || {})[a.credentialKey];
        return token === undefined ? undefined : { key: a.credentialKey, token: token };
      }
    },
    // Chunks come back sorted by descending score, each with `content` and a `source` whose
    // `path` is the name of the document in the knowledge base — the platform names a source
    // after the file it was uploaded from, which is what carries the topic key.
    Rag: {
      retrieveChunks: async a => { rags.push(a); return o.onRag ? o.onRag(a) : { chunks: [] }; }
    },
    Http: {
      get: async a => { gets.push(a); return o.onGet ? o.onGet(a) : { body: {} }; },
      post: async a => {
        posts.push(a);
        const isInternal = a.body && a.body.text && !a.body.channel;
        if (o.failPostWhen && o.failPostWhen(a)) throw new Error("pyrus 400 (rejected by test)");
        if (o.failInternalPost && isInternal) throw new Error("pyrus 500 (internal note)");
        if (o.failPost && !isInternal) throw new Error("pyrus 500");
        return o.onPost ? o.onPost(a) : { body: {} };
      }
    }
  };
  return env;
}

function suite(name) {
  const rows = [];
  return {
    check(label, cond, extra) { rows.push([label, !!cond, extra]); },
    report() {
      const failed = rows.filter(r => !r[1]).length;
      console.log("\n" + name);
      rows.forEach(([label, ok, extra]) => {
        console.log("  " + (ok ? "PASS  " : "FAIL  ") + label +
          (ok ? "" : "\n        got: " + JSON.stringify(extra)));
      });
      console.log("  " + (rows.length - failed) + "/" + rows.length + " passed");
      return { total: rows.length, failed: failed };
    }
  };
}

module.exports = { loadFunction, makeEnv, suite, ROOT };
