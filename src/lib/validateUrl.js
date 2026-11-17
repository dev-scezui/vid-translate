import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/**
 * Accept only public http(s) URLs. The URL is handed to yt-dlp, so this blocks
 * the server from being used to fetch internal hosts (SSRF).
 */
export async function validateVideoUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(new Error("Only http(s) URLs are allowed"), { status: 400 });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw Object.assign(new Error("Could not resolve host"), { status: 400 });
  if (addrs.some(isPrivateIp)) throw Object.assign(new Error("Private or local addresses are not allowed"), { status: 400 });
  return url.toString();
}
