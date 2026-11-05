import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const serverDirectory = fileURLToPath(new URL(".", import.meta.url));
const children = [
  spawn(process.execPath, [resolve(serverDirectory, "index.js")], { stdio: "inherit" }),
  spawn(process.execPath, [resolve(serverDirectory, "../node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], { stdio: "inherit" }),
];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1500).unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Could not start local development services:", error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      if (signal) console.error(`Development service exited after ${signal}`);
      stop(code || 0);
    }
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
