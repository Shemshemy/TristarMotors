import { parentPort, workerData } from "node:worker_threads";
import { createBackupSnapshot } from "./backup-core.js";

try {
  parentPort.postMessage({ path: createBackupSnapshot(workerData) });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
}
parentPort.close();
