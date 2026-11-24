import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { restoreLatestBackup } from "./backup-core.js";

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export { restoreLatestBackup };

export function createBackup(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL("./backup-worker.js", import.meta.url)), { workerData: options });
    worker.once("message", (result) => {
      if (result.error) {
        const error = new Error(result.error.message);
        error.stack = result.error.stack;
        reject(error);
      } else {
        resolve(result.path);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Backup worker exited with code ${code}`));
    });
  });
}

export function scheduleBackups(options, { onError = (error) => console.error("Inventory backup failed:", error) } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const path = await createBackup(options);
      console.log(`Inventory backup created: ${path}`);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), BACKUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
