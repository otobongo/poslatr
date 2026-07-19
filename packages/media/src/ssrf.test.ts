import { describe, expect, it } from 'vitest';
import { assertUrlSafe, isBlockedAddress, SsrfBlockedError } from './ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.5.5.5',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    'not-an-ip',
  ])('blocks %s', (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:2800:220:1::1'])(
    'allows public address %s',
    (addr) => {
      expect(isBlockedAddress(addr)).toBe(false);
    },
  );

  it('blocks the boundary just inside 172.16/12 and allows just outside', () => {
    expect(isBlockedAddress('172.15.255.255')).toBe(false);
    expect(isBlockedAddress('172.16.0.0')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('172.32.0.0')).toBe(false);
  });
});

describe('assertUrlSafe', () => {
  const publicDns = () => Promise.resolve(['93.184.216.34']);

  it('rejects a non-http protocol', async () => {
    await expect(assertUrlSafe('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlSafe('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects a non-standard port', async () => {
    await expect(
      assertUrlSafe('http://example.com:9000/x', { resolve: publicDns }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows standard ports', async () => {
    await expect(
      assertUrlSafe('http://example.com:80/x', { resolve: publicDns }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertUrlSafe('https://example.com:443/x', { resolve: publicDns }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('blocks localhost by name (PRD ISS-006 test case 4)', async () => {
    await expect(assertUrlSafe('http://localhost:9000/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlSafe('http://localhost/')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks the cloud metadata IP directly (PRD ISS-006 test case 4)', async () => {
    await expect(assertUrlSafe('http://169.254.169.254/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('blocks metadata.google.internal by name', async () => {
    await expect(assertUrlSafe('http://metadata.google.internal/')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('blocks a public NAME that resolves to a private IP (DNS rebinding)', async () => {
    await expect(
      assertUrlSafe('http://evil.example.com/', { resolve: () => Promise.resolve(['10.0.0.5']) }),
    ).rejects.toThrow(/resolves to blocked address/);
  });

  it('blocks when ANY resolved address is private, even if others are public', async () => {
    await expect(
      assertUrlSafe('http://mixed.example.com/', {
        resolve: () => Promise.resolve(['93.184.216.34', '127.0.0.1']),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a public host with only public addresses', async () => {
    await expect(
      assertUrlSafe('https://example.com/image.png', { resolve: publicDns }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('rejects a hostname that fails to resolve', async () => {
    await expect(
      assertUrlSafe('https://nope.invalid/', {
        resolve: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toThrow(/could not resolve/);
  });

  it('rejects a garbage URL', async () => {
    await expect(assertUrlSafe('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
