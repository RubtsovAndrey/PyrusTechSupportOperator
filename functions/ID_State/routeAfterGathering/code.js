const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";

let dialogState = state;
if (typeof state === "string") {
  try { dialogState = JSON.parse(state); } catch (e) { dialogState = {}; }
}

if (!dialogState || (typeof dialogState === "object" && Object.keys(dialogState).length === 0)) {
  try {
    const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
    if (record && record.value) dialogState = record.value;
    else dialogState = {};
  } catch (e) {
    Log.warn({ message: "routeAfterGathering: error reading DB: " + e });
    dialogState = {};
  }
}

const unitKnown = !!dialogState.unitKnown;
const problemKnown = !!dialogState.problemKnown;
const prevUnitKnown = !!dialogState.prevUnitKnown;
const gatherAttempts = (dialogState.gatherAttempts || 0) + 1;
const effectiveAttempts = (unitKnown && !prevUnitKnown) ? 1 : gatherAttempts;

if (unitKnown && problemKnown) {
  const updated = Object.assign({}, dialogState, { stage: "routing", gatherAttempts: 0, updatedAt: Date.now() });
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: updated });
  return { action: "proceed", replyText: null };
}

if (effectiveAttempts >= 5) {
  const updated = Object.assign({}, dialogState, { stage: "escalating", gatherAttempts: 0, updatedAt: Date.now() });
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: updated });
  return {
    action: "ask",
    replyText: "К сожалению, так и не удалось собрать нужную информацию. Перевожу диалог на специалиста технической поддержки.",
    newStage: "escalating"
  };
}

let replyText = dialogState.clarifyingQuestion;
if (!replyText) {
  replyText = !unitKnown
    ? "Уточните, из какого юнита вы пишете (например: Москва 1-1)?"
    : "Расскажите подробнее, с чем именно возникла проблема?";
}

const updated = Object.assign({}, dialogState, { stage: "gathering", gatherAttempts: effectiveAttempts, prevUnitKnown: unitKnown, updatedAt: Date.now() });
Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: updated });

return { action: "ask", replyText: replyText, newStage: "gathering" };
