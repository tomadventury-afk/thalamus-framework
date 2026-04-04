/**
 * Moltbook Outbound Filter
 * Prüft ausgehenden Text auf sensible Daten vor dem Senden.
 * Bei Treffer: return null (blockiert).
 */

const BLOCKED_NAMES = ["Tom", "Less", "Patricia", "Margot", "Martin", "Mike", "Mac"];
const BLOCKED_DOMAINS = ["chancenritter.de", "kastner.de", "adventury.de"];
const BLOCKED_IPS = ["46.224.155.83"];
const BLOCKED_PATHS = ["/root/", "/srv/", "/home/", "/opt/"];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+\d{1,3}[\s\-]?)?(\(?\d{1,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}[\s\-]?\d{0,4}/g;
const API_KEY_REGEX = /(sk-|api[_\-]?key|token|secret|password|passwd|pwd|bearer)[^\s"']{8,}/gi;
const WALLET_REGEX = /0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|[a-z0-9]{40,}/g;

export function filterOutbound(text: string): string | null {
  if (!text) return null;

  // Blocked names (whole word)
  for (const name of BLOCKED_NAMES) {
    const regex = new RegExp(`\\b${name}\\b`, "i");
    if (regex.test(text)) {
      console.error(`[outbound-filter] BLOCKED: enthält Namen "${name}"`);
      return null;
    }
  }

  // Blocked IPs
  for (const ip of BLOCKED_IPS) {
    if (text.includes(ip)) {
      console.error(`[outbound-filter] BLOCKED: enthält IP "${ip}"`);
      return null;
    }
  }

  // Blocked domains
  for (const domain of BLOCKED_DOMAINS) {
    if (text.toLowerCase().includes(domain)) {
      console.error(`[outbound-filter] BLOCKED: enthält Domain "${domain}"`);
      return null;
    }
  }

  // Blocked file paths
  for (const path of BLOCKED_PATHS) {
    if (text.includes(path)) {
      console.error(`[outbound-filter] BLOCKED: enthält Pfad "${path}"`);
      return null;
    }
  }

  // Email addresses
  if (EMAIL_REGEX.test(text)) {
    console.error(`[outbound-filter] BLOCKED: enthält E-Mail-Adresse`);
    return null;
  }

  // API keys / tokens
  if (API_KEY_REGEX.test(text)) {
    console.error(`[outbound-filter] BLOCKED: enthält API-Key/Token`);
    return null;
  }

  return text;
}
