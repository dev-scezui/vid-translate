import { spawn } from "node:child_process";

/**
 * Run a command without a shell; resolves with stdout, rejects with stderr on non-zero exit.
 * Aborting `signal` kills the process.
 */
export function run(cmd, args, { timeoutMs = 15 * 60 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.name === "AbortError") return reject(signal?.reason ?? err);
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
