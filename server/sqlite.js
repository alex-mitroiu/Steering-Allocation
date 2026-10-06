// Node's built-in SQLite (node:sqlite) prints an ExperimentalWarning on first use. It is stable
// enough for this app (Node >= 22.13 ships it without a flag); silence just that one warning.
const original = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === "string" ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return original.call(process, warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");
export { DatabaseSync };
