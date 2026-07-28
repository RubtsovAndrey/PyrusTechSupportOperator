var API_URL = AgentContext.getValue({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
var TOKEN = AgentContext.getValue({ key: "token" });
var ctxTaskId = AgentContext.getValue({ key: "taskId" });
var parentUnitFieldId = AgentContext.getValue({ key: "unitFieldId" });
var parentComponentFieldId = AgentContext.getValue({ key: "componentFieldId" });

var effectiveParentId = parentTaskId || ctxTaskId;
var FORM_ID = String(subtaskFormId || "1096731");
var resolvedUnitFullName = unitFullName || AgentContext.getValue({ key: "unitFullName" });
var resolvedComponentName = componentName || AgentContext.getValue({ key: "componentName" });
var resolvedEmail = email || AgentContext.getValue({ key: "email" });
var resolvedProblemSummary = problemSummary || AgentContext.getValue({ key: "problemSummary" });

if (!effectiveParentId || !resolvedUnitFullName || !resolvedComponentName || !resolvedEmail) {
  var missing = [];
  if (!resolvedEmail) missing.push("email партнёра");
  if (!resolvedUnitFullName) missing.push("юнит");
  if (!resolvedComponentName) missing.push("компонент");
  if (!effectiveParentId) missing.push("taskId");
  if (missing.length && resolvedUnitFullName && resolvedComponentName && effectiveParentId) {
    return {
      action: "clarify",
      clarifyingQuestion: "Укажите, пожалуйста, ваш email для создания обращения."
    };
  }
  return { success: false, reason: "missing required fields: " + missing.join(", ") };
}

const UNIT_FIELD_ID = 97, COMPONENT_FIELD_ID = 36, EMAIL_FIELD_ID = 5;

const fields = [
  { id: UNIT_FIELD_ID, value: { item_name: String(resolvedUnitFullName) } },
  { id: COMPONENT_FIELD_ID, value: { item_name: String(resolvedComponentName) } },
  { id: EMAIL_FIELD_ID, value: String(resolvedEmail) }
];

try {
  const resp = await Http.post({
    url: API_URL + "tasks",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: { form_id: Number(FORM_ID), parent_task_id: Number(effectiveParentId), fields }
  });
  const created = resp?.body ?? resp;
  const subtaskId = created?.task?.id;
  if (!subtaskId) throw new Error("No task.id in response");

  const summaryLines = [
    "[Внутренняя переписка]",
    "Подзадача создана ботом техподдержки.",
    "Юнит: " + resolvedUnitFullName,
    "Компонент: " + resolvedComponentName,
    resolvedProblemSummary ? "Проблема: " + resolvedProblemSummary : null,
    "Email партнёра: " + resolvedEmail,
    "Родительская задача: №" + effectiveParentId
  ].filter(Boolean);

  try {
    await Http.post({
      url: API_URL + "tasks/" + subtaskId + "/comments",
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: { text: summaryLines.join("\n") }
    });
  } catch (e) {
    Log.info({ message: "subtask summary comment error: " + e });
  }

  // Update parent task fields (unit, component)
  try {
    var parentFieldUpdates = [];
    if (parentUnitFieldId && resolvedUnitFullName) {
      parentFieldUpdates.push({ id: Number(parentUnitFieldId), value: { item_name: String(resolvedUnitFullName) } });
    }
    if (parentComponentFieldId && resolvedComponentName) {
      parentFieldUpdates.push({ id: Number(parentComponentFieldId), value: { item_name: String(resolvedComponentName) } });
    }
    if (parentFieldUpdates.length) {
      await Http.post({
        url: API_URL + "tasks/" + effectiveParentId + "/comments",
        headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: { field_updates: parentFieldUpdates }
      });
    }
  } catch (e) {
    Log.info({ message: "parent task field update error: " + e });
  }

  return { success: true, subtaskId: Number(subtaskId) };
} catch (e) {
  Log.warn({ message: "createSubtask error: " + e });
  return { success: false, reason: String(e) };
}
