import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InventoryDatabase } from "./inventory.js";
import { ObjectStorage } from "./object-storage.js";
import { createInventoryApi } from "./api.js";

const production = process.env.NODE_ENV === "production";
if (!production) {
  try { process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (production && (!process.env.TRISTAR_ADMIN_PASSWORD || process.env.TRISTAR_ADMIN_PASSWORD.length < 12)) {
  throw new Error("Set TRISTAR_ADMIN_PASSWORD to a secret of at least 12 characters in the production environment.");
}
if (production && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
if (production && ["S3_ENDPOINT_URL", "S3_BUCKET_NAME", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PUBLIC_BASE_URL"].some((key) => !process.env[key])) {
  throw new Error("Configure S3_ENDPOINT_URL, S3_BUCKET_NAME, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_PUBLIC_BASE_URL in production.");
}
if (production && !process.env.S3_PUBLIC_BASE_URL.startsWith("https://")) throw new Error("S3_PUBLIC_BASE_URL must use HTTPS in production.");
const database = await InventoryDatabase.open({
  databaseUrl: process.env.DATABASE_URL,
  filename: process.env.DATABASE_URL ? undefined : fileURLToPath(new URL("../data/inventory.sqlite", import.meta.url)),
});
const objectStorage = new ObjectStorage();
const port = Number(production ? (process.env.PORT || 10000) : (process.env.API_PORT || 4174));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The configured server port must be an integer between 1 and 65535.");
const server = createInventoryApi(database, {
  adminPassword: process.env.TRISTAR_ADMIN_PASSWORD,
  staticDirectory: production ? fileURLToPath(new URL("../../public-site-dist", import.meta.url))
    : process.env.TRISTAR_PUBLIC_DIRECTORY ? resolve(process.env.TRISTAR_PUBLIC_DIRECTORY) : undefined,
  objectStorage,
  allowRemote: production,
});
server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Inventory database: ${process.env.DATABASE_URL ? "PostgreSQL" : "local SQLite"}`);
  console.log(`Tristar ${production ? "production server" : "local inventory API"} listening on ${production ? "0.0.0.0" : "127.0.0.1"}:${port}`);
});
async function shutdown() {
  server.close(async () => { await database.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
