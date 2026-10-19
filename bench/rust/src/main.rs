// Native benchmark driver. Usage (from bench/rust):
//   cargo run --release -- [S1|S2|S3|all] [--warmup 200] [--steps 2000] [--fields 10] [--modes seq,2p1,2pmt]
// Modes: seq  = faithful sequential loop, 1 thread (apples-to-apples with JS)
//        2p1  = two-phase loop, 1 thread (shows the cost of the Jacobi buffer alone)
//        2pmt = two-phase loop, MULTITHREADED on all logical cores (std::thread::scope pool; --threads N to change;
//               with --features rayon it uses rayon instead, RAYON_NUM_THREADS to change)
// Writes ../results/rust_native.json
use riot_bench::{field_checksum, Sim};
use std::fmt::Write as _;
use std::time::Instant;

fn pct(sorted: &[f64], p: f64) -> f64 {
    sorted[((p / 100.0 * sorted.len() as f64) as usize).min(sorted.len() - 1)]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opt = |k: &str, d: &str| -> String {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| d.to_string())
    };
    let which = args.iter().find(|a| a.starts_with('S') || a.as_str() == "all").cloned().unwrap_or_else(|| "all".into());
    let names: Vec<String> = if which == "all" { vec!["S1".into(), "S2".into(), "S3".into()] } else { vec![which] };
    let warmup: usize = opt("--warmup", "200").parse().unwrap();
    let steps: usize = opt("--steps", "2000").parse().unwrap();
    let fields: usize = opt("--fields", "10").parse().unwrap();
    let modes: Vec<String> = opt("--modes", "seq,2p1,2pmt").split(',').map(String::from).collect();
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    #[cfg(feature = "rayon")]
    let (threads, pool) = (rayon::current_num_threads(), "rayon");
    #[cfg(not(feature = "rayon"))]
    let (threads, pool) = (
        opt("--threads", "0").parse::<usize>().ok().filter(|&t| t > 0).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)),
        "std::thread::scope",
    );

    let mut json = String::new();
    write!(json, "{{\"runner\":\"rust-native\",\"threads\":{threads},\"pool\":\"{pool}\",\"target\":\"{}\",\"results\":[", format!("{}-{}-{}", std::env::consts::ARCH, std::env::consts::OS, if cfg!(target_env = "gnu") { "gnu" } else if cfg!(target_env = "msvc") { "msvc" } else { "other" })).unwrap();
    let mut first = true;
    for name in &names {
        let bytes = std::fs::read(here.join("fixtures").join(format!("{name}.bin"))).expect("fixture missing: run node bench/make_fixture.mjs");
        for mode in &modes {
            let mut sim = Sim::from_fixture(&bytes);
            let fcs = field_checksum(&sim.goal);
            for _ in 0..2 {
                sim.bench_field();
            }
            let t0 = Instant::now();
            for _ in 0..fields {
                std::hint::black_box(sim.bench_field());
            }
            let field_ms = t0.elapsed().as_secs_f64() * 1000.0 / fields as f64;
            let step = |sim: &mut Sim| match mode.as_str() {
                "seq" => sim.step_seq(0.12),
                "2p1" => sim.step_two_phase(0.12, 1),
                _ => sim.step_two_phase(0.12, threads),
            };
            for _ in 0..warmup {
                step(&mut sim);
            }
            let mut t = Vec::with_capacity(steps);
            for _ in 0..steps {
                let a = Instant::now();
                step(&mut sim);
                t.push(a.elapsed().as_secs_f64() * 1000.0);
            }
            let mean = t.iter().sum::<f64>() / steps as f64;
            let mut s = t.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let (sum, fnv) = sim.checksum();
            let a = sim.aggregate();
            let counts: Vec<String> = sim.leaders.iter().map(|l| l.count.to_string()).collect();
            println!(
                "{name} N={} [{mode}{}]: field {field_ms:.2} ms | step mean {mean:.3} p50 {:.3} p95 {:.3} ms | checksum {sum:.3} {fnv:08x} | followers {}",
                sim.n_initial,
                if mode == "2pmt" { format!(", {threads} threads, {pool}") } else { String::new() },
                pct(&s, 50.0), pct(&s, 95.0), counts.join("/")
            );
            let leaders: Vec<String> = sim
                .leaders
                .iter()
                .map(|l| format!("{{\"count\":{},\"x\":{:.2},\"y\":{:.2},\"prog\":{:.1},\"energy\":{:.3},\"arrived\":{}}}", l.count, l.x, l.y, l.prog, l.energy, l.arrived))
                .collect();
            if !first {
                json.push(',');
            }
            first = false;
            write!(
                json,
                "{{\"scenario\":\"{name}\",\"mode\":\"{mode}\",\"N\":{},\"warmup\":{warmup},\"steps\":{steps},\"fieldMs\":{field_ms},\"fieldChecksum\":\"{fcs:08x}\",\
                 \"stepMs\":{{\"mean\":{mean},\"p50\":{},\"p95\":{},\"min\":{},\"max\":{}}},\"checksum\":{{\"sum\":{sum},\"fnv\":\"{fnv:08x}\"}},\
                 \"aggregate\":{{\"NA\":{},\"attached\":{},\"idle\":{},\"fleeing\":{},\"gone\":{},\"meanAdvanceAll\":{},\"meanAdvanceFollowers\":{},\"meanSpeed\":{},\"leaders\":[{}]}}}}",
                sim.n_initial, pct(&s, 50.0), pct(&s, 95.0), s[0], s[steps - 1],
                a.na, a.attached, a.idle, a.fleeing, a.gone, a.mean_advance_all, a.mean_advance_followers, a.mean_speed, leaders.join(",")
            )
            .unwrap();
        }
    }
    json.push_str("]}");
    let out = here.join("results").join("rust_native.json");
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    std::fs::write(&out, json).unwrap();
    println!("wrote {}", out.display());
}
