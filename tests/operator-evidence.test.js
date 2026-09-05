// Contract tests use explicit selections, never a mock of semantic relevance.
const { loadFunction, makeEnv, suite } = require("./harness");
const { conversation } = require("./dialog");
const parse = loadFunction("functions/ID_Tools/parseOperatorEvidence/code.js");
const quote = "В карточке сотрудника загрузите квадратную фотографию 300×300.";
const request = {
  id: "request-17-22", taskId: "17", incomingCommentId: "22",
  query: "Как поменять аватарку у курьера?",
  candidates: [
    { id: "c0", articleId: "photo", spaceId: "support", title: "Карточка сотрудника",
      url: "https://kb.example/photo", passages: [{ id: "p0", text: quote }] },
    { id: "c1", articleId: "noise", spaceId: "support", title: "Посторонняя статья",
      url: "https://kb.example/noise", passages: [{ id: "p0", text: "SECRET_DISCARDED_ARTICLE" }] }
  ]
};
const choice = { candidateId: "c0", passageId: "p0", quote };
async function run(frame, override) {
  const env = makeEnv({ prev: frame,
    db: { "state:17": { runtime: { incomingCommentId: "22" } } },
    contextValues: { dialog: { taskId: "17", problemSummary: "OLD_DIALOG" },
      policy: "OLD_POLICY", operatorEvidenceRequest: Object.assign({}, request, override || {}) }
  });
  env.notes.push("OLD_NOTE");
  env.AgentContext.clearContext = () => {
    env.notes.length = 0;
    Object.keys(env.values).forEach(key => delete env.values[key]);
  };
  return { result: await parse(env), env };
}
function frame(selected) { return { kind: "operator_evidence", requestId: request.id, selected }; }

async function main() {
  const t = suite("operator evidence provenance and handover");
  let r = await run(frame([Object.assign({}, choice, { url: "https://invented", action: "solve" })]));
  t.check("only verified source metadata and exact quotes survive",
    r.result.selectionStatus === "selected" && r.result.operatorKnowledge.articles.length === 1 &&
    r.result.operatorKnowledge.articles[0].url === request.candidates[0].url &&
    r.result.operatorKnowledge.articles[0].evidence[0].quote === quote &&
    !JSON.stringify(r.result).includes("solve"), r.result);
  t.check("composer context loses rejected candidates, old dialog, notes and policy",
    !/SECRET_DISCARDED|OLD_|operatorEvidenceRequest/.test(JSON.stringify(r.env.values)) &&
    r.env.notes.length === 0 && Object.keys(r.env.values).sort().join() === "dialog,operatorSupport",
    r.env.values);
  r = await run(frame([]));
  t.check("an explicit empty selection is a valid no-evidence result",
    r.result.selectionStatus === "no_evidence" && !r.result.operatorKnowledge.articles.length, r.result);
  r = await run(frame([Object.assign({}, choice, { quote: quote.replace(/ /g, "\n") })]));
  t.check("whitespace normalization keeps the same quoted words",
    r.result.operatorKnowledge.articles[0].evidence[0].quote === quote, r.result);
  const corruptions = [
    "broken json", Object.assign(frame([choice]), { requestId: "old" }),
    Object.assign(frame([choice]), { kind: "answer" }),
    frame([Object.assign({}, choice, { candidateId: "invented" })]),
    frame([Object.assign({}, choice, { passageId: "invented" })]),
    frame([Object.assign({}, choice, { quote: quote + " Фото появится в приложении." })]),
    frame([Object.assign({}, choice, { quote: "Загрузите фотографию." })]),
    frame([choice, Object.assign({}, choice, { quote: "НЕПОДТВЕРЖДЁННАЯ ВТОРАЯ ЦИТАТА, которой нет в статье." })]),
    frame([choice, choice]), frame([choice, choice, choice, choice]), frame([null]), frame(null)
  ];
  for (let i = 0; i < corruptions.length; i++) {
    r = await run(corruptions[i]);
    t.check("invalid selection fails closed as a whole: " + i,
      r.result.selectionStatus === "invalid" && r.result.operatorKnowledge.articles.length === 0 &&
      r.result.taskId === "17", r.result);
  }
  for (const override of [{ taskId: "18" }, { incomingCommentId: "21" }, { id: "" }, { id: null }]) {
    r = await run(frame([choice]), override);
    t.check("task, turn and request binding reject stale context: " + JSON.stringify(override),
      r.result.selectionStatus === "invalid" && r.result.selectionId === null &&
      r.result.operatorKnowledge.articles.length === 0, r.result);
  }

  function bot() {
    return conversation({ catalog: { topics: [] }, credentials: { [require("../tools/project-bindings").projectBindings().kbCredentialKey]: "fake" },
      onMcp: a => {
        const name = a.body.params.name;
        const payload = name === "search_content" ? { results: [
          { articleId: "photo", articleTitle: "Карточка сотрудника", spaceId: "support",
            canReadFully: true, excerpt: "SEARCH_TEASER_NOT_EVIDENCE", status: "published" },
          { articleId: "noise", articleTitle: "Посторонняя статья", spaceId: "support",
            canReadFully: true, excerpt: "SECRET_DISCARDED_ARTICLE", status: "published" }
        ] } : name === "get_content" ? { id: a.body.params.arguments.request.id,
          content: a.body.params.arguments.request.id === "photo" ? quote : "SECRET_DISCARDED_ARTICLE" }
          : { ArticleUrlTemplate: "https://kb.example/{spaceId}/{articleId}" };
        return { status: 200, body: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } };
      }
    });
  }
  for (const mode of ["selected", "empty", "invalid", "transport_error"]) {
    const c = bot();
    const turn = await c.turn("Тамбов-1, как поменять аватарку у курьера?", { unit: "Тамбов-1",
      operatorEvidenceError: mode === "transport_error",
      operatorEvidenceSelections: mode === "empty" ? [] : [Object.assign({}, choice,
        mode === "invalid" ? { quote: quote + " В приложении." } : {})]
    });
    t.check("unknown topic still hands over with " + mode + " evidence",
      turn.kind === "escalated" && turn.stage === "escalated", turn);
    t.check("selected sources and draft never enter the partner reply: " + mode,
      !/300×300|kb.example|SECRET_DISCARDED/.test(turn.replies.join(" ")), turn.replies);
    t.check("composer runs only after a nonempty valid selection: " + mode,
      turn.agents.includes("agent_operator_assist") === (mode === "selected"), turn.agents);
    t.check("the selector runs as an explicit function and never as an agent: " + mode,
      turn.trace.some(s => s.id === "func_select_operator_evidence" && s.kind === "function") &&
      !turn.agents.includes("agent_operator_evidence_selector"), turn.trace.map(s => s.id));
    const notes = c.env.posts.filter(p => /comments$/.test(p.url) && !p.body.channel)
      .map(p => p.body.text || p.body.formatted_text || "").join(" ");
    t.check("operator sees the selected quote and no rejected teaser: " + mode,
      (notes.includes(quote) === (mode === "selected")) &&
      !/SECRET_DISCARDED|SEARCH_TEASER_NOT_EVIDENCE|Посторонняя статья/.test(notes), notes);
  }
  return t.report();
}
module.exports = main;
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
