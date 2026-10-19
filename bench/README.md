# Crowd sim benchmark: JS vs Rust (native, multithreaded, WASM)

Same algorithm, constants and input data in every runner. The sim is ported from `src/sim.js` (snapshot of
2026-10-17 21:18). `index3d.html` no longer contains the sim; it imports `src/sim.js`.

## How to run

```sh
node bench/make_fixture.mjs        # builds bench/fixtures/S1.bin, S2.bin, S3.bin from data/paris-small.js
node bench/sim_js.mjs [S1|S2|S3|all]                     # JS (Node)      -> results/js.json
cd bench/rust && cargo run --release --bin bench -- all  # Rust native    -> results/rust_native.json
cd bench/rust && cargo build --release --lib --target wasm32-unknown-unknown
node bench/sim_wasm.mjs all                              # Rust WASM      -> results/rust_wasm.json
node bench/compare.mjs                                   # table + agreement check
node bench/run_all.mjs                                   # all of the above
```

Options: `--warmup 200 --steps 2000 --fields 10` for all runners, plus `--threads N` and `--modes seq,2p1,2pmt`
for native. Cargo features: `rayon` uses rayon for the MT loop instead of the built-in `std::thread::scope`
pool (needs MSVC `link.exe` because rayon's deps have build scripts). `crt-exp` uses the C runtime `exp()`
instead of the built-in fdlibm port (see notes).

**No MSVC linker / no rustup?** (This machine: Rust MSI install, Build Tools without the C++ workload.)
`node bench/setup_rust_nomsvc.mjs <dir>` downloads three official components that match your rustc
(SHA-256 checked) into a private sysroot: wasm32 std, x86_64-pc-windows-gnu std, and rust-mingw. Then
`BENCH_RUST_SYSROOT=<dir> node bench/run_all.mjs` builds native as `x86_64-pc-windows-gnu`, linked by the
bundled `rust-lld`, and WASM against that sysroot. Nothing is installed system-wide. That's how the numbers
below were produced.

## What is measured

- **Fixture** (`make_fixture.mjs`): 1087×811 nav grid of 3 m cells, rasterised without a canvas (even-odd
  scanline fill at cell centres, round-capped thick lines). Same draw order, bridge blocking,
  connected-component pass and clearance BFS as `buildNav()`. 200,448 walkable cells (the right bank; bridges
  are unwalkable in the game too). 3 leaders at the first 3 spawn points, all ordered to march on the
  Élysée. Half the agents start as followers (50/30/20 split, `spawnAround`), half are bystanders. There's a
  static tear-gas cloud (peak 0.35, below the 0.4 panic threshold) between leaders 0 and 1. Per-agent
  xorshift32 RNG state is seeded in the fixture. `navgrid.pgm` is a preview image.
- **step()** = `buildHash` + `updateLeaders` + `stepAgents`, dt = 0.12 s. 200 warm-up steps, then 2,000
  timed steps; mean, p50 and p95 reported. Police and gas diffusion are dropped. The per-agent gas sample,
  gradient and steering still run.
- **Flow field**: `computeField(goal)`, Dial's algorithm on the full grid, average of 10 runs.
- **Math.random**: replaced in every port by a per-agent xorshift32 (`rnd(i)` only advances agent i's
  state), so results don't depend on loop order or thread count.
- **Rust variants**: `seq` is the faithful loop, where agent i sees already-updated agents j < i, like the
  JS. `2-phase` computes every agent from the step-start snapshot, then writes back. That makes it
  order-independent, so it can run on threads (`2p1` = 1 thread, `2pmt` = all 16 logical cores).
- **WASM**: plain `cargo build --target wasm32-unknown-unknown` (59 KB, no wasm-bindgen) with manual
  `WebAssembly.instantiate` in Node, single-threaded. Each timed step includes **copying px/py out of WASM
  memory into JS Float32Arrays**. That copy costs 0.003 to 0.02 ms, so a zero-copy view (just the step
  time, in `results/rust_wasm.json` as `stepOnlyMs`) changes nothing.

## Results

Machine: Intel Core i5-12600KF (6P+4E cores, 16 threads), 32 GB, Windows 11 Pro 10.0.26200, Node v24.19.0,
rustc 1.99.1 (LLVM 23.1.1; MSI install, host x86_64-pc-windows-msvc; native bench built for
x86_64-pc-windows-gnu via rust-lld). Normal desktop with a browser and game launchers running, so expect
about 10 to 15% run-to-run noise. Interleaved repeat runs gave JS S3 = 23.5 to 29.5 ms and WASM S3 =
25.9 to 28.3 ms.

ms per step, mean (p50, p95), speedup vs JS on the mean:

| Scenario | JS (Node) | Rust native, 1 thread (faithful) | Rust native 2-phase, 1 thread | Rust native 2-phase, **multithreaded, 16 threads** | Rust → WASM (Node, incl. copy) |
|---|---|---|---|---|---|
| S1, 3,000 agents | 2.04 (1.87, 3.27) | 1.50 (1.45, 1.75) **1.36×** | 1.75 (1.42, 2.94) 1.17× | 0.95 (0.93, 1.07) **2.15×** | 2.10 (1.92, 3.35) **0.97×** |
| S2, 10,000 agents | 9.11 (8.23, 14.55) | 6.13 (5.26, 10.69) **1.49×** | 6.25 (5.39, 10.79) 1.46× | 1.66 (1.63, 2.04) **5.49×** | 8.36 (7.58, 13.10) **1.09×** |
| S3, 30,000 agents | 29.49 (28.13, 41.51) | 19.23 (17.85, 29.43) **1.53×** | 21.21 (19.68, 32.60) 1.39× | 3.20 (3.20, 3.63) **9.23×** | 25.99 (24.71, 36.82) **1.13×** |
| Flow field (Dial), ms | 11.90 | 9.02 **1.32×** | | | 9.34 **1.27×** |

The full output is in `results/compare.txt` and the raw numbers in `results/*.json`.

### Agreement check

- **JS vs Rust native (1 thread) and Rust WASM: bit-identical.** Same flow-field checksum, the same
  FNV hash of every agent's final f32 position after 2,200 steps, and the same follower counts in all three
  scenarios (S3: 7608/4487/3053, 15,148 attached, mean advance of followers 111.97 m in both). So the ports
  are exact, and the timing compares exactly the same work. That holds because the Rust port uses an
  fdlibm `exp` that matches V8's `Math.exp` bit for bit (verified on 7M inputs).
- **2-phase (multithreaded) vs JS: the behaviour changes, beyond float noise.** Follower counts stay within
  0.5%, but crowds move noticeably slower: mean advance toward the goal is −4% (S1), −20% (S2) and −39%
  (S3), and mean speed is 30 to 50% lower. With the sequential update the agents ahead have already moved
  when the ones behind look at them; with snapshot (Jacobi) updates dense crowds jam more. The 1-thread and
  16-thread 2-phase runs are bit-identical to each other. A parallel port therefore needs re-tuning (for
  example TAU, SF_A or the ahead/behind speed rules), not just a rewrite.

### Notes on fairness

- MinGW's CRT `exp()` measured 32 ns per call here, against 7 ns for V8's `Math.exp`. With it, native Rust only
  tied with JS (1.69 vs 1.68 ms on S1). The crate therefore ships the fdlibm `exp` V8 uses. With MSVC,
  `--features crt-exp` uses the MSVC CRT `exp`. I didn't measure that here; it should be faster than
  MinGW's but won't be bit-identical to JS.
- Rust uses safe indexing (bounds checks) and no `target-cpu=native`. V8's JIT does use the host's CPU
  features. Hand-tuning (`get_unchecked`, SIMD) could add more but wasn't attempted; the goal was a
  faithful port.
- The MT pool spawns 16 scoped threads every step, and the hash build and write-back stay serial, which is why S1 only reaches
  2.15×. A persistent pool or rayon would help small N.

## What this means for the game

At 15× time scale and 60 fps the game needs about 2 sim steps of 0.12 s per frame. Agent counts that fit,
interpolated from the table:

| Option | 2 steps in 16 ms (whole frame) | 2 steps in 8 ms (half the frame, rest for three.js) | Available in the browser? |
|---|---|---|---|
| JS, main thread | ~9,000 | ~5,000 | yes (today) |
| Rust → WASM, 1 thread | ~9,500 | ~5,000 | yes |
| Rust native, 1 thread | ~13,000 | ~6,800 | no |
| Rust native, 16 threads (2-phase) | ~90,000 (extrapolated) | ~40,000 | no (WASM threads would be needed) |

Today the game runs about **1,600 agents** on the small map (1,070 followers + ~535 bystanders; about
2,900 on the full map) with `MAXA = 16000`. That's roughly 1 ms per step in JS, so 2 to 3 ms per frame.

**Is a Rust/WASM port worth it now? No.** Single-threaded WASM is within noise of V8 (0.97× to 1.13×).
Even native Rust is only 1.4 to 1.5× faster. V8 already handles this typed-array code well, and the hot
loop is dominated by `exp` and random hash lookups, not by language overhead. The big win only comes
from parallelism (5 to 9× at 10k to 30k agents), and that is independent of Rust. It needs the 2-phase
update (with re-tuning) plus shared memory between threads.

Alternatives, in the order I'd try them:
1. **JS Web Worker**: move `step()` into a worker and post positions back (transferable or
   SharedArrayBuffer). There's no port and no behaviour change; the main thread keeps its whole frame
   budget for rendering, so the sim gets the ~9,000-agent "whole frame" row. The 12 ms flow-field compute
   on each order also stops hitching the UI.
2. **Several JS workers over a SharedArrayBuffer** with the 2-phase loop, if 10k+ agents are wanted. This
   needs cross-origin isolation (COOP/COEP headers) and the re-tune above. Rust/WASM threads need the same
   headers plus a nightly `build-std` atomics build, so they only make sense if the single-thread speedup
   matters on top.
3. **WebGPU compute** for 50k+ agents: GPU counting-sort hash plus a force pass. This is a real rewrite.
   The branchy attachment/vote logic and the readback for game logic are the awkward parts, so it's
   overkill at today's counts.
