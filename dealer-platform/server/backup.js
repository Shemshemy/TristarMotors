import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  linkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_RETENTION = 7;

function digestFile(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function listFiles(directory, prefix = "") {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(path, relative)
      : entry.isFile() ? [relative] : [];
  });
}

function snapshotUploads(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      snapshotUploads(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      // Upload names are immutable; hard links keep snapshots space-efficient
      // while preserving the file if it is later removed from the live folder.
      linkSync(sourcePath, destinationPath);
    }
  }
}

function pruneBackups(backupDirectory) {
  const backups = readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(BACKUP_RETENTION)) {
    rmSync(join(backupDirectory, oldBackup), { recursive: true, force: true });
  }
}

export function createBackup({ database, dataDirectory }) {
  const backupDirectory = join(dataDirectory, "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const destination = join(backupDirectory, timestamp);
  const staging = join(backupDirectory, `.staging-${timestamp}`);
  mkdirSync(staging);

  try {
    const databasePath = join(staging, "inventory.sqlite");
    database.db.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
    const backupDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const integrity = backupDb.prepare("PRAGMA integrity_check").get().integrity_check;
      if (integrity !== "ok") throw new Error(`Backup database integrity check failed: ${integrity}`);
    } finally {
      backupDb.close();
    }

    const uploadDirectory = join(dataDirectory, "uploads");
    const uploadFiles = listFiles(uploadDirectory);
    if (uploadFiles.length) snapshotUploads(uploadDirectory, join(staging, "uploads"));
    const passwordPath = join(dataDirectory, "admin-password.json");
    if (existsSync(passwordPath)) copyFileSync(passwordPath, join(staging, "admin-password.json"));

    const files = ["inventory.sqlite", ...(existsSync(join(staging, "admin-password.json")) ? ["admin-password.json"] : []), ...uploadFiles.map((file) => `uploads/${file}`)];
    const manifest = {
      createdAt: new Date().toISOString(),
      files: Object.fromEntries(files.map((file) => [file, digestFile(join(staging, file))])),
    };
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    rmSync(destination, { recursive: true, force: true });
    // Publish a complete snapshot only after all files and checks are done.
    writeFileSync(join(staging, ".complete"), "ok\n", { mode: 0o600 });
    renameSync(staging, destination);
    pruneBackups(backupDirectory);
    return destination;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function restoreLatestBackup({ dataDirectory }) {
  const liveDatabase = join(dataDirectory, "inventory.sqlite");
  if (existsSync(liveDatabase)) return null;
  const backupDirectory = join(dataDirectory, "backups");
  if (!existsSync(backupDirectory)) return null;
  const snapshots = readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name) && existsSync(join(backupDirectory, entry.name, ".complete")))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const snapshot of snapshots) {
    const snapshotDirectory = join(backupDirectory, snapshot);
    try {
      const manifest = JSON.parse(readFileSync(join(snapshotDirectory, "manifest.json"), "utf8"));
      const files = Object.entries(manifest.files || {});
      if (!files.length || files.some(([file, digest]) => !existsSync(join(snapshotDirectory, file)) || digestFile(join(snapshotDirectory, file)) !== digest)) continue;
      copyFileSync(join(snapshotDirectory, "inventory.sqlite"), liveDatabase);
      const snapshotUploads = join(snapshotDirectory, "uploads");
      if (existsSync(snapshotUploads)) cpSync(snapshotUploads, join(dataDirectory, "uploads"), { recursive: true, force: false });
      const snapshotPassword = join(snapshotDirectory, "admin-password.json");
      const livePassword = join(dataDirectory, "admin-password.json");
      if (existsSync(snapshotPassword) && !existsSync(livePassword)) copyFileSync(snapshotPassword, livePassword);
      return snapshotDirectory;
    } catch {
      // Skip incomplete or unreadable snapshots and try the next one.
    }
  }
  return null;
}

export function scheduleBackups(options, { onError = (error) => console.error("Inventory backup failed:", error) } = {}) {
  const run = () => {
    try {
      const path = createBackup(options);
      console.log(`Inventory backup created: ${path}`);
    } catch (error) {
      onError(error);
    }
  };
  run();
  const timer = setInterval(run, BACKUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
