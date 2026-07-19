import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// The single shared SSRF guard (SECURITY.md 2.9, PRD ISS-006). Every
// server-side fetch of a caller-influenced URL routes through here. It rejects
// anything but http/https on ports 80/443, and any host that resolves into a
// private, loopback, link-local, or cloud-metadata range, including after DNS
// resolution so a name pointing at a private IP (rebinding) is caught too.

export class SsrfBlockedError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`Blocked potentially unsafe URL: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.url = url;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// http/https default plus the explicit standard ports only.
const ALLOWED_PORTS = new Set(['', '80', '443']);

// Hostnames that must never resolve, independent of what DNS says.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inRange(ip: number, cidrBase: string, bits: number): boolean {
  const base = ipv4ToInt(cidrBase);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/** True when an IPv4 or IPv6 literal is loopback/private/link-local/metadata. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);

  if (kind === 4) {
    const ip = ipv4ToInt(address);
    if (ip === null) return true; // unparseable => treat as unsafe
    return (
      inRange(ip, '0.0.0.0', 8) || // "this" network
      inRange(ip, '10.0.0.0', 8) ||
      inRange(ip, '127.0.0.0', 8) || // loopback
      inRange(ip, '169.254.0.0', 16) || // link-local (incl. 169.254.169.254)
      inRange(ip, '172.16.0.0', 12) ||
      inRange(ip, '192.168.0.0', 16) ||
      inRange(ip, '100.64.0.0', 10) || // carrier-grade NAT
      inRange(ip, '192.0.0.0', 24) ||
      inRange(ip, '198.18.0.0', 15) || // benchmarking
      inRange(ip, '224.0.0.0', 4) || // multicast
      inRange(ip, '240.0.0.0', 4) // reserved
    );
  }

  if (kind === 6) {
    const normalized = address.toLowerCase();
    // Map IPv4-mapped / -compatible IPv6 back to the v4 check.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return (
      normalized === '::1' || // loopback
      normalized === '::' ||
      normalized.startsWith('fe80:') || // link-local
      normalized.startsWith('fc') || // unique-local fc00::/7
      normalized.startsWith('fd') ||
      normalized.startsWith('ff') // multicast
    );
  }

  return true; // not a valid IP literal => unsafe
}

export interface SsrfCheckOptions {
  /** Inject DNS resolution for tests. Defaults to the real resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/**
 * Validates a URL for server-side fetching. Throws SsrfBlockedError on any
 * violation; returns the parsed URL when safe. DNS is resolved and every
 * returned address is checked, so a hostname pointing at a private IP is
 * rejected even though the string looks public.
 */
export async function assertUrlSafe(
  rawUrl: string,
  options: SsrfCheckOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, 'not a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(rawUrl, `protocol ${url.protocol} not allowed`);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SsrfBlockedError(rawUrl, `port ${url.port} not allowed`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockedError(rawUrl, `hostname ${hostname} is blocked`);
  }

  // A literal IP is checked directly; a name is resolved and every A/AAAA
  // record is checked (DNS-rebinding protection).
  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfBlockedError(rawUrl, `address ${hostname} is in a blocked range`);
    }
    return url;
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SsrfBlockedError(rawUrl, `could not resolve ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(rawUrl, `no addresses for ${hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(rawUrl, `${hostname} resolves to blocked address ${address}`);
    }
  }
  return url;
}

/**
 * Fetches a URL only after it passes the SSRF guard, with redirects disabled
 * so a 3xx cannot bounce to a private address after the check. Callers needing
 * redirects must re-run assertUrlSafe on each hop.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SsrfCheckOptions = {},
): Promise<Response> {
  await assertUrlSafe(rawUrl, options);
  return fetch(rawUrl, { ...init, redirect: 'error' });
}
