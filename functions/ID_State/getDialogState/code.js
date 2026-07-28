const DB_ID = "REPLACE_WITH_YOUR_DB_KEY";

const key = "state:" + taskId;

let record = null;
try {
  record = Db.get({ dbIntegration: DB_ID, documentKey: key });
} catch (e) {
  record = null;
}

if (record && record.value) return record.value;

return {
  stage: "face_control",
  unit: null,
  problemSummary: null,
  solverKey: null,
  email: null,
  gatherAttempts: 0,
  confirmationAttempts: 0,
  error: null,
  closeComment: null,
  updatedAt: Date.now()
};
