if (Context.getProjectShortName() !== expectedProject || Context.isTestChannel() !== true) {
  throw new Error("Dev test routing requires the registered dev project and the Test menu.");
}
// Test-widget messages can still enter through the setup trigger. Recognize only
// explicit evaluation commands before any diagnostic or model calls.
const command = String((Context.getMessageContent() || {}).text || "").trim().toLowerCase();
return { selectorEval: ["success-full", "empty-full", "empty-single", "noise-only",
  "client-avatar-full", "client-avatar-noise"].indexOf(command) >= 0 };
