// Backward-compatible command name. The catalog and the RAG documents now have one
// generator because producing either one without the other recreates the drift this
// project has already seen in production.
//
// Prefer: node tools/build-knowledge.js

const { main } = require("./build-knowledge");

try {
  console.log("build-rag.js is now an alias of build-knowledge.js.");
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error("ERROR: " + e.message);
  process.exitCode = 1;
}
