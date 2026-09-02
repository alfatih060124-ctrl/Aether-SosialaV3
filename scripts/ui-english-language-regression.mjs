import fs from 'node:fs';
import path from 'node:path';

const roots = ['public', 'web'];
const blockedIndonesian = /\b(?:tidak|untuk|dengan|pengguna|dompet|akun|pasar|harus|sudah|belum|silakan|masuk|keluar|daftar|pengaturan|perdagangan|penarikan|setoran|ikuti|salin|temukan|mulai|lanjutkan|kembali|berhasil|gagal|memuat|verifikasi|terverifikasi|bantuan|keamanan|risiko|pilih|buat|batal|simpan|kirim|hapus|ubah|alamat|kata\s+sandi|frasa\s+pemulihan|kunci\s+pribadi)\b/giu;
const htmlLangEnglish = /<html\b[^>]*\blang=["']en(?:-[A-Za-z0-9]+)?["'][^>]*>/i;

function htmlFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => path.join(root, entry.name));
}

const files = roots.flatMap(htmlFiles);
const failures = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  if (!htmlLangEnglish.test(source)) {
    failures.push(`${file}: missing explicit <html lang="en">`);
  }

  blockedIndonesian.lastIndex = 0;
  const matches = [...source.matchAll(blockedIndonesian)].map((match) => match[0]);
  if (matches.length) {
    failures.push(`${file}: Indonesian UI term(s) found: ${[...new Set(matches.map((value) => value.toLowerCase()))].join(', ')}`);
  }
}

if (files.length === 0) failures.push('No user-facing HTML files were found under public/ or web/.');

if (failures.length) {
  console.error('AETHER English-only UI regression: FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`AETHER English-only UI regression: PASS (${files.length} HTML surfaces checked)`);
