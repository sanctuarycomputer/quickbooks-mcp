// Sanctuary Computer (quickbooks-mcp-286): a self-signed certificate made at test time (T13's loopback TLS cases), so no
// certificate or key sits in the tree. A P-256 key, and an X.509 v3 certificate written in DER here and signed with it:
// a CA (so it can be its own trust anchor), valid from a day ago to a day ahead, naming one subjectAltName.
import crypto from 'crypto';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups: number[] = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(out));
}
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** The subjectAltName the certificate names: an IP address (`ip`) or a DNS name (`dns`). */
export type AltName = { ip: string } | { dns: string };

/** A fresh key and a self-signed certificate for `alt`, both PEM, made now. */
export function selfSigned(alt: AltName): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;
  const general = 'ip' in alt ? tlv(0x87, Buffer.from(alt.ip.split('.').map(Number))) : tlv(0x82, Buffer.from(alt.dns));
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(general)));
  const basic = seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff])))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name('quickbooks-mcp loopback test'),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name('quickbooks-mcp loopback test'),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(san, basic)),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: new crypto.X509Certificate(der).toString() };
}
