#!/usr/bin/env node
/**
 * Generates a new RSA key pair for the gateway.
 *
 *   npm run keygen                  # writes keys/private.pem + keys/public.pem
 *   npm run keygen -- --out mykeys  # other output folder
 *   npm run keygen -- --bits 4096   # bigger key (slower decrypt)
 *   npm run keygen -- --force       # overwrite existing files
 *
 * Prints what to put in .env / your hosting dashboard, and the public key
 * in every format the client apps need.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = path.resolve(opt('out', 'keys'));
const bits = parseInt(opt('bits', '2048'), 10);
const force = args.includes('--force');

if (![2048, 3072, 4096].includes(bits)) {
  console.error('--bits must be 2048, 3072 or 4096');
  process.exit(1);
}

const privatePath = path.join(outDir, 'private.pem');
const publicPath = path.join(outDir, 'public.pem');
if (!force && (fs.existsSync(privatePath) || fs.existsSync(publicPath))) {
  console.error(`Key files already exist in ${outDir}. Use --force to overwrite.`);
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: bits,
});
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
// Same derivation as the server (src/encryption/encryption.service.ts keyIdOf)
const sha256 = crypto.createHash('sha256').update(spkiDer).digest('hex');
const keyId = sha256.slice(0, 16);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPath, publicPem);

const rel = (p) => {
  const r = path.relative(process.cwd(), p);
  return !r || r.startsWith('..') ? p : r;
};
const line = '─'.repeat(72);
console.log(`
✅ RSA-${bits} key pair created
   ${rel(privatePath)}  (RAHASIA — jangan di-commit / dibagikan)
   ${rel(publicPath)}   (boleh dibagikan ke tim client)

${line}
SERVER — pilih SATU cara:

 a) File (VPS / Docker volume), di .env:
    RSA_PRIVATE_KEY_PATH=${rel(privatePath)}

 b) Environment variable (Railway / Render / Fly.io / dll.), satu baris:
    RSA_PRIVATE_KEY=${Buffer.from(privatePem).toString('base64')}

${line}
CLIENT — tanam di aplikasi (juga tersedia di GET /public-key):

 KeyId                   : ${keyId}
 Web / Flutter / Android : isi file ${rel(publicPath)} (PEM)
 iOS (PKCS#1 base64)     : ${publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64')}

 SHA-256 fingerprint     : ${sha256}
${line}
ROTASI KEY: letakkan key baru di DEPAN, key lama di belakang (dipisah koma):
    RSA_PRIVATE_KEY=<key baru>,<key lama>
 Aplikasi lama tetap jalan; hapus key lama setelah semua user update.
${line}
`);
