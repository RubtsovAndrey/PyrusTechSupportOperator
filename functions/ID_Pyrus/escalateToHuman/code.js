const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const taskId = Context.get({ key: "taskId" });
const apiUrl = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = Context.get({ key: "token" });

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  Log.warn({ message: "escalateToHuman: error reading dialogState: " + e });
}

const summaryLines = [
  "Передача на оператора.",
  dialogState.unitFullName ? "Юнит: " + dialogState.unitFullName : (dialogState.unit ? "Юнит: " + dialogState.unit : null),
  dialogState.problemSummary ? "Проблема: " + dialogState.problemSummary : null,
  dialogState.componentName ? "Компонент: " + dialogState.componentName : null,
  dialogState.email ? "Email: " + dialogState.email : null,
  dialogState.error ? "Ошибка бота: " + dialogState.error : null
].filter(Boolean);
const summaryText = summaryLines.join("\n");

const unitFieldId = Context.get({ key: "unitFieldId" });
const componentFieldId = Context.get({ key: "componentFieldId" });
const fieldUpdates = [];
if (unitFieldId && (dialogState.unitFullName || dialogState.unit)) {
  fieldUpdates.push({ id: Number(unitFieldId), value: { item_name: String(dialogState.unitFullName || dialogState.unit) } });
}
if (componentFieldId && dialogState.componentName) {
  fieldUpdates.push({ id: Number(componentFieldId), value: { item_name: String(dialogState.componentName) } });
}

const body = {
  text: summaryText,
  approval_choice: "approved"
};
if (fieldUpdates.length > 0) body.field_updates = fieldUpdates;

let escalated = false;
try {
  await Http.post({
    url: apiUrl + "tasks/" + taskId + "/comments",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body
  });
  escalated = true;
} catch (e) {
  Log.warn({ message: "escalateToHuman error: " + e });
  dialogState.error = String(e);
}

dialogState.stage = escalated ? "escalated" : "escalating";
dialogState.updatedAt = Date.now();
Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });

return { escalated: escalated, error: dialogState.error || null };
