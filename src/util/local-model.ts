import { totalmem } from "node:os";

/** Suggest a local model size from installed memory. Models are configurable in settings.yaml. */
export function suggestLocalModel(bytes = totalmem()): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 48) return "qwen3:30b";
  if (gb >= 24) return "qwen3:14b";
  if (gb >= 16) return "qwen3:8b";
  return "qwen3:4b";
}
