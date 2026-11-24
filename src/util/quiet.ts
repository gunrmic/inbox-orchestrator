// Node 22 marks node:sqlite as experimental and prints a warning on first use.
// Replace Node's default warning printer with one that skips only that warning.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.warn(`(node) ${w.name}: ${w.message}`);
});
export {};
