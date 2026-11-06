import { constants, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InventoryDatabase } from "./inventory.js";
import { createInventoryApi } from "./api.js";

const production = process.env.NODE_ENV === "production";
if (!production) {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

if (production && (!process.env.TRISTAR_ADMIN_PASSWORD || process.env.TRISTAR_ADMIN_PASSWORD.length < 12)) {
  throw new Error("Set TRISTAR_ADMIN_PASSWORD to a secret of at least 12 characters in the production environment.");
}

const dataDirectory = process.env.TRISTAR_DATA_DIR ||
  fileURLToPath(new URL("../data", import.meta.url));
const uploadDirectory = join(dataDirectory, "uploads");
const bundledUploadDirectory = production
  ? fileURLToPath(new URL("../dist/images/cars/uploads", import.meta.url))
  : fileURLToPath(new URL("../public/images/cars/uploads", import.meta.url));
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(uploadDirectory, { recursive: true });
try {
  for (const entry of readdirSync(bundledUploadDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      copyFileSync(join(bundledUploadDirectory, entry.name), join(uploadDirectory, entry.name), constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const database = new InventoryDatabase(join(dataDirectory, "inventory.sqlite"));
const port = Number(production ? (process.env.PORT || 10000) : (process.env.API_PORT || 4174));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("The configured server port must be an integer between 1 and 65535.");
}
const server = createInventoryApi(database, {
  adminPassword: process.env.TRISTAR_ADMIN_PASSWORD,
  uploadDirectory,
  staticDirectory: production
    ? fileURLToPath(new URL("../../public-site-dist", import.meta.url))
    : process.env.TRISTAR_PUBLIC_DIRECTORY
      ? resolve(process.env.TRISTAR_PUBLIC_DIRECTORY)
      : undefined,
  allowRemote: production,
});

server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () => {
  const host = production ? "0.0.0.0" : "127.0.0.1";
  console.log(`Tristar ${production ? "production server" : "local inventory API"} listening on ${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
