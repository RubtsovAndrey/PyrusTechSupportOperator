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
    "Context", "AgentContext", "Db", "Log", "Http", ...names,
    "return (async function(){\n" + src + "\n})();"
  );
  return (env, args) => factory(
    env.Context, env.AgentContext, env.Db, env.Log, env.Http, ...(args || [])
  );
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// "value.data.email" -> walks into the document and assigns. Mirrors the dotted-path
// form the platform requires: the payload lives under the root key `value`.
function setPath(root, dotted, value) {
  const parts = String(dotted).split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// options: { payload, prev, db, contextValues, onGet, failPost, failInternalPost }
function makeEnv(options) {
  const o = options || {};
  const db = clone(o.db) || {};
  const notes = [];
  const values = clone(o.contextValues) || {};
  const posts = [];
  const gets = [];
  const updates = [];

  const env = {
    db, notes, values, posts, gets, updates,
    prev: clone(o.prev) || {},
    Context: {
      getMessageContent: () => ({ payload: o.payload }),
      getLastFunctionResult: () => env.prev
    },
    AgentContext: {
      clearContext: () => {},
      addNote: a => notes.push(a.text),
      putValue: a => { values[a.key] = a.value; },
      getValue: a => values[a.key]
    },
    // Db.get returns a copy: a function must not be able to mutate stored state by
    // reference, or a test would pass while production corrupts the document.
    Db: {
      get: a => (db[a.documentKey] === undefined ? null : { value: clone(db[a.documentKey]) }),
      put: a => { db[a.documentKey] = clone(a.value); },
      delete: a => { delete db[a.documentKey]; },
      // Only $set with dotted paths is modelled, which is all the code uses. Two
      // platform properties are reproduced deliberately, because the code has to cope
      // with both: there is no upsert (a missing document is simply not found), and
      // the result says nothing about how many documents matched.
      updateByFilters: a => {
        updates.push(a);
        const key = a.filters && a.filters.documentKey;
        if (key === undefined || db[key] === undefined) return {};
        const doc = { documentKey: key, value: clone(db[key]) };
        const $set = (a.operator && a.operator.$set) || {};
        Object.keys($set).forEach(p => setPath(doc, p, clone($set[p])));
        db[key] = doc.value;
        return {};
      }
    },
    Log: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
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
