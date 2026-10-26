import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Fixed project output only: never accept a browser-supplied filesystem path. */
export function readDriftReport(configPath: string): { markdown: string; updatedAt: string } {
  const fd = openSync(join(dirname(configPath), "drift-report.md"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error("The drift report must be a regular project file owned by you, no larger than 2 MB.");
    return { markdown: readFileSync(fd, "utf8"), updatedAt: stat.mtime.toISOString() };
  } finally { closeSync(fd); }
}
