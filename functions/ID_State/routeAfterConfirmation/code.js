const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const taskId = Context.get({ key: "taskId" });

const lastResult = Context.getLastFunctionResult() || {};
const status = lastResult.status || "unclear";

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  Log.warn({ message: "routeAfterConfirmation: error reading dialogState: " + e });
}

let replyText = null;
let confirmationAttempts = dialogState.confirmationAttempts || 0;
const confirmationType = dialogState.confirmationType || "solution_check";

if (confirmationType === "more_help") {
  if (status === "resolved") {
    dialogState.stage = "closed";
    dialogState.confirmationAttempts = 0;
    dialogState.confirmationType = null;
    replyText = "Рад был помочь! Если появятся новые вопросы, обращайтесь. Отличного дня!";
  } else if (status === "more_questions") {
    dialogState.stage = "gathering";
    dialogState.confirmationAttempts = 0;
    dialogState.confirmationType = null;
    dialogState.problemSummary = null;
    dialogState.problemKnown = false;
    dialogState.solverKey = null;
    dialogState.routingTopicKey = null;
    dialogState.componentName = null;
    dialogState.unitCandidates = null;
    replyText = "Внимательно слушаю. Опишите, пожалуйста, ваш новый вопрос или проблему.";
  } else if (status === "failed") {
    dialogState.stage = "escalating";
    dialogState.confirmationAttempts = 0;
    dialogState.confirmationType = null;
    replyText = "Понял вас. Перевожу диалог на специалиста технической поддержки, он скоро подключится и поможет разобраться.";
  } else {
    confirmationAttempts += 1;
    if (confirmationAttempts >= 2) {
      dialogState.stage = "escalating";
      dialogState.confirmationAttempts = 0;
      dialogState.confirmationType = null;
      replyText = "Не удалось понять ваш ответ. Перевожу диалог на специалиста технической поддержки.";
    } else {
      dialogState.stage = "awaiting_confirmation";
      dialogState.confirmationAttempts = confirmationAttempts;
      replyText = "Извините, не совсем понял. Подскажите, нужна ли вам ещё помощь по этому вопросу? (Да / Нет)";
    }
  }
} else if (status === "resolved") {
  dialogState.stage = "awaiting_confirmation";
  dialogState.confirmationType = "more_help";
  dialogState.confirmationAttempts = 0;
  replyText = "Рад был помочь! Подскажите, нужна ли вам ещё помощь по какому-либо вопросу? (Да / Нет)";
} else if (status === "failed") {
  dialogState.stage = "escalating";
  dialogState.confirmationAttempts = 0;
  replyText = "Понял вас. Перевожу диалог на специалиста технической поддержки, он скоро подключится и поможет разобраться.";
} else if (status === "more_questions") {
  dialogState.stage = "gathering";
  dialogState.confirmationAttempts = 0;
  dialogState.problemSummary = null;
  dialogState.problemKnown = false;
  dialogState.solverKey = null;
  dialogState.routingTopicKey = null;
  dialogState.componentName = null;
  dialogState.unitCandidates = null;
  replyText = "Внимательно слушаю. Опишите, пожалуйста, ваш новый вопрос или проблему.";
} else {
  confirmationAttempts += 1;
  if (confirmationAttempts >= 2) {
    dialogState.stage = "escalating";
    dialogState.confirmationAttempts = 0;
    replyText = "Не удалось понять ваш ответ. Перевожу диалог на специалиста технической поддержки.";
  } else {
    dialogState.stage = "awaiting_confirmation";
    dialogState.confirmationAttempts = confirmationAttempts;
    replyText = "Извините, не совсем понял. Подскажите, предложенная инструкция помогла решить проблему? (Да / Нет)";
  }
}

dialogState.updatedAt = Date.now();
Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });

return { action: "reply", replyText: replyText, newStage: dialogState.stage };
