const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";
const taskId = Context.get({ key: "taskId" });
const apiUrl = Context.get({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
const token = Context.get({ key: "token" });
const incomingText = Context.get({ key: "incomingText" }) || "";

function parseBody(resp) {
  if (!resp) return {};
  return resp.body !== undefined ? resp.body : resp;
}

function flattenFields(fields, out = []) {
  if (!Array.isArray(fields)) return out;
  fields.forEach(f => {
    out.push(f);
    if (f.value && Array.isArray(f.value.fields)) flattenFields(f.value.fields, out);
    else if (Array.isArray(f.fields)) flattenFields(f.fields, out);
  });
  return out;
}

function extractEmail(text) {
  const m = String(text || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

let dialogState = {};
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: "state:" + taskId });
  if (record && record.value) dialogState = record.value;
} catch (e) {
  dialogState = {};
}

const providedEmail = extractEmail(incomingText);
if (providedEmail) dialogState.email = providedEmail;

const SUBTASK_FORM_ID = String(dialogState.subtaskFormId || "REPLACE_WITH_SUBTASK_FORM_ID");

if (!dialogState.email) {
  dialogState.stage = "awaiting_email";
  dialogState.updatedAt = Date.now();
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });
  return {
    replyText: "Пожалуйста, укажите ваш email, чтобы ответственная команда могла связаться с вами.",
    newStage: "awaiting_email"
  };
}

if (!dialogState.unitFullName || !dialogState.componentName) {
  return {
    replyText: "Не удалось создать подзадачу: не указан юнит или компонент. Перевожу на оператора.",
    newStage: "escalating"
  };
}

async function loadFormFields() {
  const cacheKey = "form_fields:" + SUBTASK_FORM_ID;
  const now = Date.now();
  let cached = null;
  try {
    const rec = Db.get({ dbIntegration: DB_ID, documentKey: cacheKey });
    if (rec && rec.value && (now - rec.value.ts) < 60 * 60 * 1000) cached = rec.value;
  } catch (e) {
    Log.warn({ message: "createSubtask: form fields cache error: " + e });
  }
  if (cached && cached.formFields) return cached.formFields;

  const formResp = await Http.get({
    url: apiUrl + "forms/" + SUBTASK_FORM_ID,
    headers: { "Authorization": "Bearer " + token }
  });
  const form = parseBody(formResp);
  const formFields = flattenFields(form.fields || []);
  try {
    Db.put({ dbIntegration: DB_ID, documentKey: cacheKey, value: { formFields: formFields, ts: now } });
  } catch (e) {
    Log.warn({ message: "createSubtask: form fields cache save error: " + e });
  }
  return formFields;
}

async function createSubtaskImpl() {
  const formFields = await loadFormFields();
  const findField = (...names) => formFields.find(f => names.includes(f.name));
  const unitField = findField("Юнит");
  const componentField = findField("Компонент");
  const emailField = findField("Email", "E-mail", "Почта", "email", "E-Mail");
  const descField = findField("Описание", "Комментарий", "Текст обращения", "Описание проблемы");

  if (!unitField || !componentField || !emailField) {
    throw new Error("Форма подзадачи не содержит обязательных полей: Юнит, Компонент, Email");
  }

  const fields = [];
  fields.push({ id: Number(unitField.id), value: { item_name: String(dialogState.unitFullName) } });
  fields.push({ id: Number(componentField.id), value: { item_name: String(dialogState.componentName) } });
  fields.push({ id: Number(emailField.id), value: String(dialogState.email) });
  if (descField && dialogState.problemSummary) {
    fields.push({ id: Number(descField.id), value: String(dialogState.problemSummary) });
  }

  const createResp = await Http.post({
    url: apiUrl + "tasks",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: {
      form_id: Number(SUBTASK_FORM_ID),
      parent_task_id: Number(taskId),
      fields: fields
    }
  });

  const created = parseBody(createResp);
  if (!created || !created.task || !created.task.id) {
    throw new Error("Pyrus create task response did not contain task.id: " + JSON.stringify(created));
  }
  return Number(created.task.id);
}

let subtaskId;
try {
  subtaskId = await createSubtaskImpl();
} catch (e) {
  Log.info({ message: "createSubtask error: " + e });
  dialogState.error = String(e);
  dialogState.stage = "escalating";
  dialogState.updatedAt = Date.now();
  Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });
  return {
    replyText: "Не удалось создать подзадачу прямо сейчас. Перевожу на оператора.",
    newStage: "escalating"
  };
}

dialogState.subtaskId = subtaskId;
dialogState.stage = "closed";
dialogState.closeComment = "Подзадача №" + subtaskId + " создана. Email: " + dialogState.email + ". Проблема: " + (dialogState.problemSummary || "не указана") + ".";
dialogState.updatedAt = Date.now();
Db.put({ dbIntegration: DB_ID, documentKey: "state:" + taskId, value: dialogState });

return {
  replyText: "Вопрос передан в ответственную команду. Подзадача №" + subtaskId + ". С вами свяжутся по " + dialogState.email + ". Спасибо!",
  newStage: "closed",
  subtaskId: subtaskId
};
