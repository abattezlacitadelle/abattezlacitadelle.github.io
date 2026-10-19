// OPTIONAL helper for machines that have Rust (MSI or rustup, MSVC host) but NO MSVC linker and/or no wasm32
// target. Downloads three official Rust components matching your rustc version from static.rust-lang.org
// (SHA-256 checked) into a private sysroot, without touching the Rust install or needing admin:
//   rust-std  wasm32-unknown-unknown   (what `rustup target add wasm32-unknown-unknown` would add)
//   rust-std  x86_64-pc-windows-gnu    (native builds via the GNU ABI, linked with the bundled rust-lld)
//   rust-mingw x86_64-pc-windows-gnu   (MinGW import libs + CRT objects for that link)
// and junctions the host's lib/rustlib/x86_64-pc-windows-msvc (for rust-lld) into it.
// Usage: node bench/setup_rust_nomsvc.mjs [sysrootDir]     (default: bench/.toolchain/sysroot)
// Then:  set BENCH_RUST_SYSROOT=<sysrootDir> and run node bench/run_all.mjs
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sys = path.resolve(process.argv[2] || path.join(HERE, '.toolchain', 'sysroot'));
const vv = execSync('rustc -vV').toString();
const ver = /release: (\S+)/.exec(vv)[1], host = /host: (\S+)/.exec(vv)[1];
const hostSys = execSync('rustc --print sysroot').toString().trim();
const dl = path.join(path.dirname(sys), 'downloads');
fs.mkdirSync(path.join(sys, 'lib', 'rustlib'), { recursive: true });
fs.mkdirSync(dl, { recursive: true });

async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return Buffer.from(await r.arrayBuffer()); }
for (const [comp, target] of [['rust-std', 'wasm32-unknown-unknown'], ['rust-std', 'x86_64-pc-windows-gnu'], ['rust-mingw', 'x86_64-pc-windows-gnu']]) {
  const name = `${comp}-${ver}-${target}`, url = `https://static.rust-lang.org/dist/${name}.tar.gz`, file = path.join(dl, name + '.tar.gz');
  const want = (await fetchBuf(url + '.sha256')).toString().split(/\s+/)[0];
  if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) {
    console.log('downloading ' + url);
    const b = await fetchBuf(url);
    if (crypto.createHash('sha256').update(b).digest('hex') !== want) throw new Error('sha256 mismatch for ' + name);
    fs.writeFileSync(file, b);
  }
  const inner = comp === 'rust-std' ? `rust-std-${target}` : 'rust-mingw';
  // use Windows' bsdtar when present: Git Bash's GNU tar mangles "C:\..." paths
  const winTar = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'tar.exe');
  const tar = winTar && fs.existsSync(winTar) ? `"${winTar}"` : 'tar';
  execSync(`${tar} -xzf "${path.basename(file)}" --strip-components=2 -C "${sys}" ${name}/${inner}/lib`, { stdio: 'inherit', cwd: dl });
  console.log(`installed ${name} into ${sys}`);
}
const link = path.join(sys, 'lib', 'rustlib', host);
if (!fs.existsSync(link)) fs.symlinkSync(path.join(hostSys, 'lib', 'rustlib', host), link, 'junction');
console.log(`\nsysroot ready. Now:\n  PowerShell: $env:BENCH_RUST_SYSROOT="${sys}"\n  bash:       export BENCH_RUST_SYSROOT="${sys.replace(/\\/g, '/')}"\n  node bench/run_all.mjs`);
