const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";

const key = "state:" + taskId;

let current = null;
try {
  const record = Db.get({ dbIntegration: DB_ID, documentKey: key });
  current = (record && record.value) ? record.value : null;
} catch (e) {
  current = null;
}

const base = current || {
  stage: "face_control",
  unit: null,
  problemSummary: null,
  solverKey: null,
  email: null,
  gatherAttempts: 0,
  confirmationAttempts: 0,
  error: null,
  closeComment: null
};

let patchObj = patch;
if (typeof patch === "string") {
  try { patchObj = JSON.parse(patch); } catch (e) { patchObj = {}; }
}

const updated = Object.assign({}, base, patchObj, { updatedAt: Date.now() });

Db.put({ dbIntegration: DB_ID, documentKey: key, value: updated });

return updated;
