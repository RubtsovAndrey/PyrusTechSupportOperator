const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const taskId = Context.get({ key: "taskId" });
const apiUrl = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = Context.get({ key: "token" });

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  Log.warn({ message: "closeTask: error reading dialogState: " + e });
}

const unitFieldId = Context.get({ key: "unitFieldId" });
const componentFieldId = Context.get({ key: "componentFieldId" });
const unitValue = dialogState.unitFullName || dialogState.unit || null;
const componentValue = dialogState.componentName || null;

if (!unitValue || !componentValue) {
  Log.warn({ message: "closeTask: missing unit or component, escalating" });
  const escBody = {
    text: "Передача на оператора (бот не смог закрыть задачу: не проставлены юнит и/или компонент).",
    approval_choice: "approved"
  };
  const escFields = [];
  if (unitFieldId && unitValue) escFields.push({ id: Number(unitFieldId), value: { item_name: String(unitValue) } });
  if (escFields.length > 0) escBody.field_updates = escFields;
  try {
    await Http.post({
      url: apiUrl + "tasks/" + taskId + "/comments",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: escBody
    });
  } catch (e2) {
    Log.warn({ message: "closeTask: escalation error: " + e2 });
  }
  dialogState.stage = "escalated";
  dialogState.updatedAt = Date.now();
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });
  return { closed: false, escalated: true };
}

const fieldUpdates = [];
if (unitFieldId) fieldUpdates.push({ id: Number(unitFieldId), value: { item_name: String(unitValue) } });
if (componentFieldId) fieldUpdates.push({ id: Number(componentFieldId), value: { item_name: String(componentValue) } });

const body = {
  text: dialogState.closeComment || "Обращение обработано ботом.",
  action: "finished"
};
if (fieldUpdates.length > 0) body.field_updates = fieldUpdates;

try {
  await Http.post({
    url: apiUrl + "tasks/" + taskId + "/comments",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: body
  });
  return { closed: true };
} catch (e) {
  Log.info({ message: "closeTask error: " + e });
  return { closed: false, error: String(e) };
}
