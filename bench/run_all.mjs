// Runs every available benchmark runner, then prints the comparison table.
// Usage: node bench/run_all.mjs [S1|S2|S3|all]
// 1. builds the fixtures if missing   2. JS bench   3. Rust native bench (seq / 2-phase 1 thread / 2-phase MT)
// 4. Rust -> WASM build + bench        5. node compare.mjs
// Rust builds use the host toolchain (needs MSVC link.exe), or, if BENCH_RUST_SYSROOT is set (see
// setup_rust_nomsvc.mjs), the x86_64-pc-windows-gnu target linked by rust-lld plus that sysroot's wasm32 std.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUST = path.join(HERE, 'rust');
const which = process.argv[2] || 'all';
// cargo may not be on PATH right after install: try the rustup location and the standalone MSI location too
const extra = [path.join(os.homedir(), '.cargo', 'bin')];
for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
  try { for (const d of fs.readdirSync(base)) if (/^Rust /.test(d)) extra.push(path.join(base, d, 'bin')); } catch {}
}
const env = { ...process.env, PATH: [...extra, process.env.PATH].join(path.delimiter) };
const SYS = process.env.BENCH_RUST_SYSROOT;
let nativeTarget = '';
if (SYS) {
  nativeTarget = '--target x86_64-pc-windows-gnu';
  env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS = `--sysroot ${SYS} -C linker=rust-lld -C linker-flavor=ld.lld -C link-self-contained=yes`;
  env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS = `--sysroot ${SYS}`;
}
const run = (cmd, cwd = HERE) => { console.log('\n$ ' + cmd); execSync(cmd, { stdio: 'inherit', cwd, env }); };
const ok = cmd => spawnSync(cmd, { shell: true, env, cwd: RUST }).status === 0;

if (!['S1', 'S2', 'S3'].every(s => fs.existsSync(path.join(HERE, 'fixtures', s + '.bin')))) run('node make_fixture.mjs');
run(`node sim_js.mjs ${which}`);

if (!ok('cargo --version')) {
  console.log('\n[skip] Rust: cargo not found (see README.md "Toolchain").');
} else {
  try { run(`cargo run --release ${nativeTarget} --bin bench -- ${which}`, RUST); }
  catch { console.log('\n[fail] Rust native build/run failed. No MSVC link.exe? Use setup_rust_nomsvc.mjs + BENCH_RUST_SYSROOT (README.md).'); }
  try {
    run('cargo build --release --lib --target wasm32-unknown-unknown', RUST);
    run(`node sim_wasm.mjs ${which}`);
  } catch { console.log('\n[fail] WASM build/run failed. wasm32 target missing? rustup target add wasm32-unknown-unknown, or BENCH_RUST_SYSROOT.'); }
}
run('node compare.mjs');
