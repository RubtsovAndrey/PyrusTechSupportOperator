var params = arguments[0] || {};
var API_URL = AgentContext.getValue({ key: "apiUrl" }) || "https://api.pyrus.com/v4/";
var TOKEN = AgentContext.getValue({ key: "token" });
var ctxTaskId = AgentContext.getValue({ key: "taskId" });

var effectiveParentId = params.parentTaskId || params["parent-task-id"] || ctxTaskId;
var FORM_ID = String(params.subtaskFormId || params["subtask-form-id"] || "1096731");
var unitFullName = params.unitFullName || params["unit-full-name"] || AgentContext.getValue({ key: "unitFullName" });
var componentName = params.componentName || params["component-name"] || AgentContext.getValue({ key: "componentName" });
var email = params.email || AgentContext.getValue({ key: "email" });
var problemSummary = params.problemSummary || params["problem-summary"] || AgentContext.getValue({ key: "problemSummary" });

if (!effectiveParentId || !unitFullName || !componentName || !email) {
  return { success: false, reason: "missing required fields" };
}

const UNIT_FIELD_ID = 97, COMPONENT_FIELD_ID = 36, EMAIL_FIELD_ID = 5;

const fields = [
  { id: UNIT_FIELD_ID, value: { item_name: String(unitFullName) } },
  { id: COMPONENT_FIELD_ID, value: { item_name: String(componentName) } },
  { id: EMAIL_FIELD_ID, value: String(email) }
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
    "Юнит: " + unitFullName,
    "Компонент: " + componentName,
    problemSummary ? "Проблема: " + problemSummary : null,
    "Email партнёра: " + email,
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

  return { success: true, subtaskId: Number(subtaskId) };
} catch (e) {
  Log.warn({ message: "createSubtask error: " + e });
  return { success: false, reason: String(e) };
}
