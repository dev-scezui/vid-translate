import { spawn } from "node:child_process";

/** Run a command without a shell; resolves with stdout, rejects with stderr on non-zero exit. */
export function run(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") err.message = `"${cmd}" not found - is it installed and on PATH?`;
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`${cmd} failed (${signal ?? `exit ${code}`}): ${tail}`));
    });
  });
}
