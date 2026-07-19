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
    const bytes = expandIpv6(address);
    if (bytes === null) return true; // valid per isIP but unexpandable => unsafe

    // Loopback ::1 and unspecified :: are blocked outright (handle first so the
    // v4-compatible check below can't misclassify them).
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
    if (bytes.every((b) => b === 0)) return true;

    // Any IPv6 that embeds an IPv4 address must be checked as that IPv4,
    // regardless of textual notation (ISS-006-F1). Node's URL parser rewrites
    // ::ffff:127.0.0.1 into compressed hex (::ffff:7f00:1), so a text regex on
    // the dotted form is dead code on this path; inspect the bytes instead.
    const firstTenZero = bytes.slice(0, 10).every((b) => b === 0);
    const v4Mapped = firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;
    const v4Compatible = bytes.slice(0, 12).every((b) => b === 0); // ::a.b.c.d (deprecated)
    const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;

    if (v4Mapped || v4Compatible || nat64) {
      return isBlockedAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }

    const b0 = bytes[0] ?? 0;
    const b1 = bytes[1] ?? 0;
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (b0 === 0xff) return true; // ff00::/8 multicast
    return false;
  }

  return true; // not a valid IP literal => unsafe
}

/**
 * Expands any valid IPv6 literal (with :: compression and/or an embedded dotted
 * IPv4 tail) into its 16 bytes. Returns null if it cannot be parsed.
 */
export function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();

  // A trailing dotted-IPv4 (e.g. ::ffff:127.0.0.1) becomes two hextets.
  const v4Match = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4Match) {
    const octets = v4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const [a, b, c, d] = octets;
    const hi = (a << 8) | b;
    const lo = (c << 8) | d;
    text = text.slice(0, v4Match.index) + hi.toString(16) + ':' + lo.toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  let words: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    words = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const w of words) {
    bytes.push((w >> 8) & 0xff, w & 0xff);
  }
  return bytes;
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
