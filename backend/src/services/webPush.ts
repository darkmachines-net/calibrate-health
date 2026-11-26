/** @file VAPID configuration, SSRF-hardened browser push endpoint validation, and bounded delivery handling. */

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import webpush, { type PushSubscription } from 'web-push';

export const WEB_PUSH_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_WEB_PUSH_ENDPOINT_LENGTH = 2048;
export const MAX_WEB_PUSH_KEY_LENGTH = 512;
export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20;

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.arpa'];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);

type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type WebPushConfigResult = {
  config: WebPushConfig | null;
  error?: string;
};

type WebPushEndpointValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

const isPublicIpv4 = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

/** Parse an IPv6 address (with optional `::` compression and embedded IPv4 suffix) into 8 16-bit groups. */
const parseIpv6Groups = (rawIp: string): number[] | null => {
  const ip = rawIp.split('%')[0].toLowerCase();
  const doubleColonParts = ip.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegment = (segment: string): number[] | null => {
    if (!segment) return [];
    const tokens = segment.split(':');
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1 || net.isIP(token) !== 4) return null;
        const octets = token.split('.').map(Number);
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
      }
    }
    return groups;
  };

  const left = parseSegment(doubleColonParts[0]);
  const right = doubleColonParts.length === 2 ? parseSegment(doubleColonParts[1]) : [];
  if (!left || !right) return null;

  if (doubleColonParts.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
};

const ipv4FromGroups = (high: number, low: number): string =>
  `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;

/**
 * Determine whether an IPv4 or IPv6 address is globally routable.
 * Rejects loopback, private, link-local/cloud-metadata, CGNAT, documentation, multicast,
 * and IPv4-mapped/NAT64/6to4 encodings of non-public IPv4 addresses.
 */
export function isPublicRoutableIpAddress(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, '');
  const version = net.isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version !== 6) return false;

  const groups = parseIpv6Groups(normalized);
  if (!groups) return false;

  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isUnspecified || isLoopback) return false;

  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isIpv4Compatible =
    groups.slice(0, 6).every((group) => group === 0);
  const isNat64WellKnown =
    groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (isIpv4Mapped || isIpv4Compatible || isNat64WellKnown) {
    return isPublicIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  if (groups[0] === 0x2002) {
    return isPublicIpv4(ipv4FromGroups(groups[1], groups[2]));
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local
  if ((groups[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return false; // 0100::/64 discard
  return true;
}

/**
 * Validate a browser Web Push endpoint URL before storing or dispatching notifications.
 * Enforces HTTPS on the default port, bounded length, no embedded credentials, and a public
 * multi-label domain name (blocking IP literals, localhost, and internal/link-local suffixes).
 */
export function validateWebPushEndpoint(rawEndpoint: string): WebPushEndpointValidationResult {
  const endpoint = rawEndpoint.trim();
  if (!endpoint || endpoint.length > MAX_WEB_PUSH_ENDPOINT_LENGTH) {
    return { ok: false, error: 'Push subscription endpoint must be a valid HTTPS URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: 'Push subscription endpoint must be a valid HTTPS URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Push subscription endpoint must use HTTPS.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Push subscription endpoint must not include credentials.' };
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return { ok: false, error: 'Push subscription endpoint must use the standard HTTPS port.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const unwrappedHost = hostname.replace(/^\[|\]$/g, '');
  if (!unwrappedHost || net.isIP(unwrappedHost) !== 0) {
    return { ok: false, error: 'Push subscription endpoint must use a public hostname.' };
  }
  if (
    !unwrappedHost.includes('.') ||
    BLOCKED_HOSTNAMES.has(unwrappedHost) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => unwrappedHost.endsWith(suffix))
  ) {
    return { ok: false, error: 'Push subscription endpoint hostname is not allowed.' };
  }

  return { ok: true, url: parsed };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

type LookupFunction = (
  hostname: string,
  options: dns.LookupAllOptions | dns.LookupOneOptions,
  callback: LookupCallback
) => void;

/**
 * Create a DNS lookup hook for outbound Web Push sockets that rejects any hostname resolving
 * to loopback, private, link-local, metadata, or otherwise non-public IP addresses.
 */
export function createSafeWebPushLookup(
  lookupAll: (hostname: string, options: { all: true; verbatim: true }) => Promise<dns.LookupAddress[]> = (
    hostname,
    options
  ) => dns.promises.lookup(hostname, options)
): LookupFunction {
  return (hostname, options, callback) => {
    void lookupAll(hostname, { all: true, verbatim: true })
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((entry) => !isPublicRoutableIpAddress(entry.address))) {
          const error = new Error('Push subscription endpoint resolved to a non-public IP address.') as NodeJS.ErrnoException;
          error.code = 'ERR_WEB_PUSH_BLOCKED_HOST';
          callback(error, '');
          return;
        }
        if (options && 'all' in options && options.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error: unknown) => {
        callback(error as NodeJS.ErrnoException, '');
      });
  };
}

const safeWebPushAgent = new https.Agent({
  keepAlive: false,
  lookup: createSafeWebPushLookup()
});

/**
 * Resolve VAPID configuration from the environment with actionable error messaging.
 */
export function resolveWebPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfigResult {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();

  const missing: string[] = [];
  if (!publicKey) missing.push('WEB_PUSH_PUBLIC_KEY');
  if (!privateKey) missing.push('WEB_PUSH_PRIVATE_KEY');
  if (!subject) missing.push('WEB_PUSH_SUBJECT');

  if (!publicKey || !privateKey || !subject) {
    return {
      config: null,
      error: `Web push is disabled: missing ${missing.join(
        ', '
      )}. Set these environment variables to enable push notifications.`
    };
  }

  return {
    config: {
      publicKey,
      privateKey,
      subject
    }
  };
}

/**
 * Ensure web-push has been configured with VAPID details before sending.
 */
export function ensureWebPushConfigured(env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string } {
  const { config, error } = resolveWebPushConfig(env);
  if (!config) {
    return { ok: false, error };
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return { ok: true };
}

/**
 * Return the public VAPID key for frontend subscription registration.
 */
export function getWebPushPublicKey(env: NodeJS.ProcessEnv = process.env): { publicKey: string | null; error?: string } {
  const { config, error } = resolveWebPushConfig(env);
  return { publicKey: config?.publicKey ?? null, error };
}

/**
 * Send a push payload to a stored subscription with SSRF destination validation and a hard request timeout.
 */
export async function sendWebPushNotification(
  subscription: PushSubscription,
  payload: string,
  options: { timeoutMs?: number; agent?: https.Agent } = {}
): Promise<webpush.SendResult> {
  const validation = validateWebPushEndpoint(subscription.endpoint);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const configured = ensureWebPushConfigured();
  if (!configured.ok) {
    throw new Error(configured.error ?? 'Web push configuration is missing.');
  }

  const timeoutMs = options.timeoutMs ?? WEB_PUSH_REQUEST_TIMEOUT_MS;
  const agent = options.agent ?? safeWebPushAgent;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      webpush.sendNotification(subscription, payload, { timeout: timeoutMs, agent }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const timeoutError = new Error(`Web push request timed out after ${timeoutMs}ms.`) as NodeJS.ErrnoException;
          timeoutError.code = 'ETIMEDOUT';
          reject(timeoutError);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
