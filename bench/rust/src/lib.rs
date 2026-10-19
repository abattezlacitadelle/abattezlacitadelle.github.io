//! Rust port of the riot-sim crowd core, line-for-line with bench/sim_js.mjs (which mirrors src/sim.js).
//! Arithmetic is f64 like JS numbers; per-agent state is stored as f32 / i16 / u8 exactly like the JS typed
//! arrays, and every store-then-reload of a typed-array slot is emulated (`as f32 as f64`).
//!
//! Two agent-loop variants:
//! - `step_seq`: faithful sequential loop. Like the JS, agent i sees the already-updated state of agents j < i
//!   (Gauss-Seidel). This is the apples-to-apples comparison with JS.
//! - `step_two_phase(parallel)`: phase 1 computes every agent's new state from the step-start snapshot into a
//!   buffer, phase 2 writes it back (Jacobi). Order-independent, so it can run on rayon threads. Its results
//!   differ slightly from the sequential loop (different update scheme), not just by float noise.

#[cfg(feature = "rayon")]
use rayon::prelude::*;

/// Fill `outs[i] = me.agent(i)` on `threads` scoped std threads that grab blocks of 256 agents from an atomic
/// counter (dynamic load balancing: followers are clustered in index order, so static chunks would be uneven).
#[cfg(not(feature = "rayon"))]
fn par_agents(me: &Sim, outs: &mut [AgentOut], dt: f64, threads: usize) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    const BLK: usize = 256;
    struct P(*mut AgentOut);
    unsafe impl Sync for P {}
    impl P {
        fn get(&self) -> *mut AgentOut {
            self.0
        }
    }
    let n = outs.len();
    let next = AtomicUsize::new(0);
    let p = P(outs.as_mut_ptr());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let b = next.fetch_add(BLK, Ordering::Relaxed);
                if b >= n {
                    break;
                }
                for i in b..(b + BLK).min(n) {
                    // SAFETY: each index is claimed by exactly one thread via the atomic counter; i < n.
                    unsafe { *p.get().add(i) = me.agent(i, dt) };
                }
            });
        }
    });
}

pub const UNREACH: u16 = 65535;
const DXS: [i32; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
const DYS: [i32; 8] = [0, 0, 1, -1, 1, -1, 1, -1];
const DCOST: [u32; 8] = [10, 10, 10, 10, 14, 14, 14, 14];
const HC: f64 = 2.0;
const HSIZE: usize = 1 << 17;
const HMASK: i32 = (HSIZE - 1) as i32;
const SF_A: f64 = 2.2;
const SF_B: f64 = 0.28;
const SF_K: f64 = 18.0;
const RADS: f64 = 0.6;
const VISC: f64 = 1.2;
const TAU: f64 = 0.5;
const GO_HOME: f64 = 0.25;

/// exp(): fdlibm e_exp.c exactly as V8 implements Math.exp (src/base/ieee754.cc), so results match JS bit for
/// bit and do not depend on the C runtime (MinGW's CRT exp measured ~4x slower than V8's).
/// Build with `--features crt-exp` to use the platform's exp instead.
#[cfg(not(feature = "crt-exp"))]
#[inline]
pub fn exp(mut x: f64) -> f64 {
    const LN2_HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2_LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const HALF: [f64; 2] = [0.5, -0.5];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    let from_hi = |h: u32| f64::from_bits((h as u64) << 32);
    let mut hx = (x.to_bits() >> 32) as u32;
    let xsb = (hx >> 31) as usize;
    hx &= 0x7fffffff;
    let (hi, lo, k): (f64, f64, i32);
    if hx >= 0x40862E42 {
        if hx >= 0x7FF00000 {
            return if x.is_nan() { x + x } else if xsb == 0 { x } else { 0.0 };
        }
        if x > 7.09782712893383973096e+02 {
            return f64::INFINITY;
        }
        if x < -7.45133219101941108420e+02 {
            return TWOM1000 * TWOM1000;
        }
    }
    if hx > 0x3FD62E42 {
        if hx < 0x3FF0A2B2 {
            hi = x - LN2_HI[xsb];
            lo = LN2_LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + HALF[xsb]) as i32;
            let t = k as f64;
            hi = x - t * LN2_HI[0];
            lo = t * LN2_LO[0];
        }
        x = hi - lo;
    } else if hx < 0x3E300000 {
        return 1.0 + x;
    } else {
        k = 0;
        hi = 0.0;
        lo = 0.0;
    }
    let t = x * x;
    let twopk = if k >= -1021 { from_hi((0x3FF00000i32 + (k << 20)) as u32) } else { from_hi((0x3FF00000i32 + ((k + 1000) << 20)) as u32) };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * 8.98846567431157953865e+307;
        }
        return y * twopk;
    }
    y * twopk * TWOM1000
}
#[cfg(feature = "crt-exp")]
#[inline]
pub fn exp(x: f64) -> f64 {
    x.exp()
}

#[inline(always)]
fn hkey(cx: i32, cy: i32) -> usize {
    ((cx.wrapping_mul(92837111) ^ cy.wrapping_mul(689287499)) & HMASK) as usize
}
#[inline(always)]
fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a { a } else if v > b { b } else { v }
}
#[inline(always)]
fn f32r(v: f64) -> f64 {
    v as f32 as f64
}
/// per-agent xorshift32, same as rnd(i) in sim_js.mjs
#[inline(always)]
fn xorshift(s: &mut u32) -> f64 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    x as f64 / 4294967296.0
}

pub struct Field {
    pub dist: Vec<u16>,
    pub dir: Vec<u8>,
    pub tx: f64,
    pub ty: f64,
}

#[derive(Clone)]
pub struct Leader {
    pub x: f64,
    pub y: f64,
    pub prog: f64,
    pub arrived: bool,
    pub count: i32,
    pub energy: f64,
    pub speed: f64,
    pub has_field: bool,
}

#[derive(Clone, Copy, Default)]
pub struct AgentOut {
    px: f32,
    py: f32,
    vx: f32,
    vy: f32,
    panic_t: f32,
    flee_x: f32,
    flee_y: f32,
    rng: u32,
    lead: i16,
    counted: i16,
    gone: u8,
}

pub struct Aggregate {
    pub na: usize,
    pub attached: usize,
    pub idle: usize,
    pub fleeing: usize,
    pub gone: u32,
    pub mean_advance_all: f64,
    pub mean_advance_followers: f64,
    pub mean_speed: f64,
}

pub struct Sim {
    pub n_initial: usize,
    w: f64,
    h: f64,
    cell: f64,
    cols: i32,
    rows: i32,
    nc: usize,
    walk: Vec<u8>,
    clear: Vec<u8>,
    gc: f64,
    gcols: i32,
    grows: i32,
    gas: Vec<f32>,
    gwalk: Vec<u8>,
    doff: [i64; 8],
    dvx: [f64; 8],
    dvy: [f64; 8],
    buckets: Vec<Vec<u32>>,
    goal_xy: (f64, f64),
    pub goal: Field,
    pub na: usize,
    pub px: Vec<f32>,
    pub py: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    v0: Vec<f32>,
    panic_t: Vec<f32>,
    flee_x: Vec<f32>,
    flee_y: Vec<f32>,
    pub lead: Vec<i16>,
    gone: Vec<u8>,
    rng: Vec<u32>,
    h_start: Vec<i32>,
    h_cur: Vec<i32>,
    h_items: Vec<i32>,
    h_key: Vec<i32>,
    pub leaders: Vec<Leader>,
    pub dispersed: u32,
    dist0: Vec<f64>,
    outs: Vec<AgentOut>,
}

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}
impl<'a> Rd<'a> {
    fn u32_at(&self, o: usize) -> u32 {
        u32::from_le_bytes(self.b[o..o + 4].try_into().unwrap())
    }
    fn f64_at(&self, o: usize) -> f64 {
        f64::from_le_bytes(self.b[o..o + 8].try_into().unwrap())
    }
    fn f64(&mut self) -> f64 {
        let v = self.f64_at(self.o);
        self.o += 8;
        v
    }
    fn f32s(&mut self, n: usize) -> Vec<f32> {
        let v = (0..n).map(|k| f32::from_le_bytes(self.b[self.o + 4 * k..self.o + 4 * k + 4].try_into().unwrap())).collect();
        self.o += 4 * n;
        v
    }
    fn u32s(&mut self, n: usize) -> Vec<u32> {
        let v = (0..n).map(|k| self.u32_at(self.o + 4 * k)).collect();
        self.o += 4 * n;
        v
    }
    fn i32s(&mut self, n: usize) -> Vec<i32> {
        self.u32s(n).into_iter().map(|v| v as i32).collect()
    }
    fn u8s(&mut self, n: usize) -> Vec<u8> {
        let v = self.b[self.o..self.o + n].to_vec();
        self.o += n;
        v
    }
}

impl Sim {
    pub fn from_fixture(bytes: &[u8]) -> Sim {
        let mut r = Rd { b: bytes, o: 128 };
        assert_eq!(r.u32_at(0), 0x31425352, "bad fixture magic");
        let w = r.f64_at(8);
        let h = r.f64_at(16);
        let cell = r.u32_at(24) as f64;
        let cols = r.u32_at(28) as i32;
        let rows = r.u32_at(32) as i32;
        let gc = r.u32_at(36) as f64;
        let gcols = r.u32_at(40) as i32;
        let grows = r.u32_at(44) as i32;
        let nl = r.u32_at(48) as usize;
        let n = r.u32_at(52) as usize;
        let goal_xy = (r.f64_at(56), r.f64_at(64));
        let nc = (cols * rows) as usize;
        let gn = (gcols * grows) as usize;
        let mut lpos = Vec::new();
        for _ in 0..nl {
            let x = r.f64();
            let y = r.f64();
            lpos.push((x, y));
        }
        let gas = r.f32s(gn);
        let px = r.f32s(n);
        let py = r.f32s(n);
        let v0 = r.f32s(n);
        let rng = r.u32s(n);
        let lead: Vec<i16> = r.i32s(n).into_iter().map(|v| v as i16).collect();
        let walk = r.u8s(nc);
        let clear = r.u8s(nc);
        let gwalk = r.u8s(gn);

        let mut doff = [0i64; 8];
        let mut dvx = [0f64; 8];
        let mut dvy = [0f64; 8];
        for k in 0..8 {
            doff[k] = DXS[k] as i64 + DYS[k] as i64 * cols as i64;
            let (dx, dy) = (DXS[k] as f64, DYS[k] as f64);
            dvx[k] = dx / dx.hypot(dy);
            dvy[k] = dy / dx.hypot(dy);
        }
        let mut sim = Sim {
            n_initial: n,
            w, h, cell, cols, rows, nc, walk, clear, gc, gcols, grows, gas, gwalk, doff, dvx, dvy,
            buckets: (0..15).map(|_| Vec::new()).collect(),
            goal_xy,
            goal: Field { dist: Vec::new(), dir: Vec::new(), tx: 0.0, ty: 0.0 },
            na: n, px, py,
            vx: vec![0.0; n], vy: vec![0.0; n], v0,
            panic_t: vec![0.0; n], flee_x: vec![0.0; n], flee_y: vec![0.0; n],
            lead, gone: vec![0; n], rng,
            h_start: vec![0; HSIZE + 1], h_cur: vec![0; HSIZE + 1], h_items: vec![0; n], h_key: vec![0; n],
            leaders: Vec::new(), dispersed: 0, dist0: Vec::new(),
            outs: vec![AgentOut::default(); n],
        };
        for (x, y) in lpos {
            sim.add_leader(x, y);
        }
        sim.goal = sim.compute_field(goal_xy.0, goal_xy.1).expect("goal unreachable");
        for l in sim.leaders.iter_mut() {
            l.has_field = true;
            l.arrived = false;
        }
        sim.dist0 = (0..sim.na).map(|i| sim.field_dist(&sim.goal, sim.px[i] as f64, sim.py[i] as f64)).collect();
        sim
    }

    // ---------------- nav grid ----------------
    #[inline(always)]
    fn cell_of(&self, x: f64, y: f64) -> usize {
        ((y / self.cell).floor() as i64 * self.cols as i64 + (x / self.cell).floor() as i64) as usize
    }
    #[inline(always)]
    fn walk_at(&self, x: f64, y: f64) -> bool {
        if x < 0.0 || y < 0.0 || x >= self.w || y >= self.h {
            return false;
        }
        self.walk[self.cell_of(x, y)] == 1
    }
    fn nearest_walkable(&self, gx: i32, gy: i32, max_r: i32) -> i64 {
        let ok = |x: i32, y: i32| x > 0 && y > 0 && x < self.cols - 1 && y < self.rows - 1 && self.walk[(y * self.cols + x) as usize] != 0;
        let id = |x: i32, y: i32| (y as i64) * self.cols as i64 + x as i64;
        if ok(gx, gy) {
            return id(gx, gy);
        }
        for r in 1..=max_r {
            for d in -r..=r {
                if ok(gx + d, gy - r) { return id(gx + d, gy - r); }
                if ok(gx + d, gy + r) { return id(gx + d, gy + r); }
                if ok(gx - r, gy + d) { return id(gx - r, gy + d); }
                if ok(gx + r, gy + d) { return id(gx + r, gy + d); }
            }
        }
        -1
    }
    fn cell_x(&self, c: i64) -> f64 {
        ((c % self.cols as i64) as f64 + 0.5) * self.cell
    }
    fn cell_y(&self, c: i64) -> f64 {
        ((c / self.cols as i64) as f64 + 0.5) * self.cell
    }

    // ---------------- flow field (Dial's algorithm) ----------------
    pub fn compute_field(&mut self, mut tx: f64, mut ty: f64) -> Option<Field> {
        let t = if self.walk_at(tx, ty) {
            self.cell_of(tx, ty) as i64
        } else {
            self.nearest_walkable((tx / self.cell).floor() as i32, (ty / self.cell).floor() as i32, 60)
        };
        if t < 0 {
            return None;
        }
        if !self.walk_at(tx, ty) {
            tx = self.cell_x(t);
            ty = self.cell_y(t);
        }
        let nc = self.nc;
        let cols = self.cols as i64;
        let mut dist = vec![UNREACH; nc];
        let mut dir = vec![255u8; nc];
        let walk = &self.walk;
        let buckets = &mut self.buckets;
        dist[t as usize] = 0;
        buckets[0].push(t as u32);
        let mut pending: i64 = 1;
        let mut cur: u32 = 0;
        while pending > 0 {
            let bi = (cur % 15) as usize;
            while let Some(c) = buckets[bi].pop() {
                pending -= 1;
                let c = c as i64;
                if dist[c as usize] as u32 != cur {
                    continue;
                }
                for k in 0..8 {
                    let n = (c + self.doff[k]) as usize;
                    if walk[n] == 0 {
                        continue;
                    }
                    if k >= 4 && (walk[(c + DXS[k] as i64) as usize] == 0 || walk[(c + DYS[k] as i64 * cols) as usize] == 0) {
                        continue;
                    }
                    let nd = cur + DCOST[k];
                    if nd < dist[n] as u32 && nd < UNREACH as u32 {
                        dist[n] = nd as u16;
                        buckets[(nd % 15) as usize].push(n as u32);
                        pending += 1;
                    }
                }
            }
            cur += 1;
        }
        for c in 0..nc {
            let d = dist[c];
            if d == UNREACH {
                continue;
            }
            if d == 0 {
                dir[c] = 8;
                continue;
            }
            let ci = c as i64;
            let mut best = d;
            let mut bk = 255u8;
            for k in 0..8 {
                let n = (ci + self.doff[k]) as usize;
                if dist[n] < best {
                    if k >= 4 && (walk[(ci + DXS[k] as i64) as usize] == 0 || walk[(ci + DYS[k] as i64 * cols) as usize] == 0) {
                        continue;
                    }
                    best = dist[n];
                    bk = k as u8;
                }
            }
            dir[c] = bk;
        }
        Some(Field { dist, dir, tx, ty })
    }
    /// recompute the goal field (benchmark helper); returns its checksum
    pub fn bench_field(&mut self) -> u32 {
        let f = self.compute_field(self.goal_xy.0, self.goal_xy.1).unwrap();
        field_checksum(&f)
    }

    #[inline(always)]
    fn field_dir(&self, f: &Field, x: f64, y: f64) -> Option<(f64, f64)> {
        let fx = x / self.cell - 0.5;
        let fy = y / self.cell - 0.5;
        let i0 = fx.floor();
        let j0 = fy.floor();
        if i0 < 0.0 || j0 < 0.0 || i0 >= (self.cols - 1) as f64 || j0 >= (self.rows - 1) as f64 {
            return None;
        }
        let ax = fx - i0;
        let ay = fy - j0;
        let (i0, j0) = (i0 as i64, j0 as i64);
        let mut vx = 0.0;
        let mut vy = 0.0;
        for q in 0..4 {
            let di = q & 1;
            let dj = q >> 1;
            let w = (if di != 0 { ax } else { 1.0 - ax }) * (if dj != 0 { ay } else { 1.0 - ay });
            let code = f.dir[((j0 + dj) * self.cols as i64 + i0 + di) as usize];
            if code < 8 {
                vx += self.dvx[code as usize] * w;
                vy += self.dvy[code as usize] * w;
            } else if code == 8 {
                let dx = f.tx - x;
                let dy = f.ty - y;
                let mut l = dx.hypot(dy);
                if l == 0.0 { l = 1.0; }
                vx += dx / l * w;
                vy += dy / l * w;
            }
        }
        let l = vx.hypot(vy);
        if l < 1e-3 {
            return None;
        }
        Some((vx / l, vy / l))
    }
    #[inline(always)]
    fn field_dist(&self, f: &Field, x: f64, y: f64) -> f64 {
        let d = f.dist[self.cell_of(clamp(x, 0.0, self.w - 1.0), clamp(y, 0.0, self.h - 1.0))];
        if d == UNREACH { f64::INFINITY } else { d as f64 * self.cell / 10.0 }
    }

    // ---------------- spatial hash ----------------
    fn build_hash(&mut self) {
        self.h_start.fill(0);
        for i in 0..self.na {
            let k = hkey((self.px[i] as f64 / HC).floor() as i32, (self.py[i] as f64 / HC).floor() as i32);
            self.h_key[i] = k as i32;
            self.h_start[k + 1] += 1;
        }
        for k in 0..HSIZE {
            self.h_start[k + 1] += self.h_start[k];
        }
        self.h_cur.copy_from_slice(&self.h_start);
        for i in 0..self.na {
            let k = self.h_key[i] as usize;
            self.h_items[self.h_cur[k] as usize] = i as i32;
            self.h_cur[k] += 1;
        }
    }
    fn count_near(&self, x: f64, y: f64, r: f64) -> i32 {
        let cx = (x / HC).floor() as i32;
        let cy = (y / HC).floor() as i32;
        let rr = (r / HC).ceil() as i32;
        let r2 = r * r;
        let mut n = 0;
        for dy in -rr..=rr {
            for dx in -rr..=rr {
                let k = hkey(cx + dx, cy + dy);
                for s in self.h_start[k]..self.h_start[k + 1] {
                    let j = self.h_items[s as usize] as usize;
                    let ex = self.px[j] as f64 - x;
                    let ey = self.py[j] as f64 - y;
                    if ex * ex + ey * ey < r2 {
                        n += 1;
                    }
                }
            }
        }
        n
    }

    // ---------------- gas ----------------
    #[inline(always)]
    fn gas_sample(&self, x: f64, y: f64) -> (f64, f64, f64) {
        let i = (x / self.gc).floor() as i32;
        let j = (y / self.gc).floor() as i32;
        if i < 1 || j < 1 || i >= self.gcols - 1 || j >= self.grows - 1 {
            return (0.0, 0.0, 0.0);
        }
        let k = (j * self.gcols + i) as usize;
        let g = self.gas[k] as f64;
        if g < 0.01 {
            return (g, 0.0, 0.0);
        }
        let gc = self.gcols as usize;
        let s = |m: usize| if self.gwalk[m] != 0 { self.gas[m] as f64 } else { g };
        let (l, r, d, u) = (s(k - 1), s(k + 1), s(k - gc), s(k + gc));
        (g, (r - l) / (2.0 * self.gc), (u - d) / (2.0 * self.gc))
    }

    // ---------------- leaders ----------------
    fn add_leader(&mut self, mut x: f64, mut y: f64) {
        if !self.walk_at(x, y) {
            let c = self.nearest_walkable((x / self.cell).floor() as i32, (y / self.cell).floor() as i32, 60);
            if c < 0 {
                return;
            }
            x = self.cell_x(c);
            y = self.cell_y(c);
        }
        self.leaders.push(Leader { x, y, prog: 0.0, arrived: true, count: 0, energy: 100.0, speed: 0.0, has_field: false });
    }
    fn update_leaders(&mut self, dt: f64) {
        for li in 0..self.leaders.len() {
            let mut l = self.leaders[li].clone();
            let has_f = l.has_field;
            l.prog = if has_f { self.field_dist(&self.goal, l.x, l.y) } else { 0.0 };
            let mut moving = false;
            if has_f && !l.arrived {
                if l.prog < 2.5 {
                    l.arrived = true;
                } else {
                    let near = self.count_near(l.x, l.y, 1.5);
                    let rho = (near as f64 + 1.0) / 7.07;
                    let fw = if rho < 0.5 { 1.0 } else { f64::max(0.35, 1.0 - exp(-1.913 * (1.0 / rho - 1.0 / 5.4))) };
                    let (g, _, _) = self.gas_sample(l.x, l.y);
                    let gas_slow = if g > 0.3 { 0.55 } else { 1.0 };
                    l.speed = 1.45 / (1.0 + l.count as f64 / 300.0).sqrt() * (0.35 + 0.65 * l.energy / 100.0) * fw * gas_slow;
                    let d = self.field_dir(&self.goal, l.x, l.y).or_else(|| dir_to(l.x, l.y, self.goal.tx, self.goal.ty));
                    if let Some((dx, dy)) = d {
                        let (mx, my) = (dx * l.speed * dt, dy * l.speed * dt);
                        let (nx, ny) = (l.x + mx, l.y + my);
                        if self.walk_at(nx, ny) {
                            l.x = nx;
                            l.y = ny;
                        } else if self.walk_at(nx, l.y) {
                            l.x = nx;
                        } else if self.walk_at(l.x, ny) {
                            l.y = ny;
                        }
                        moving = true;
                    }
                    if g > 0.3 {
                        l.energy -= dt * 0.15;
                    }
                }
            }
            if !moving {
                l.speed = 0.0;
            }
            l.energy = clamp(l.energy + (if moving { -(0.006 + l.count as f64 / 120000.0) } else { 0.03 }) * dt, 0.0, 100.0);
            self.leaders[li] = l;
        }
    }

    // ---------------- one agent (reads shared state, returns its new state) ----------------
    #[inline(always)]
    fn agent(&self, i: usize, dt: f64) -> AgentOut {
        let x = self.px[i] as f64;
        let y = self.py[i] as f64;
        let nl = self.leaders.len();
        let mut votes = [0f32; 32];
        let (mut fx, mut fy, mut nn, mut avx, mut avy) = (0.0f64, 0.0f64, 0i32, 0.0f64, 0.0f64);
        let cx = (x / HC).floor() as i32;
        let cy = (y / HC).floor() as i32;
        for oy in -1..=1 {
            for ox in -1..=1 {
                let k = hkey(cx + ox, cy + oy);
                let (s0, e) = (self.h_start[k] as usize, self.h_start[k + 1] as usize);
                for s in s0..e {
                    let j = self.h_items[s] as usize;
                    if j == i {
                        continue;
                    }
                    let ddx = x - self.px[j] as f64;
                    let ddy = y - self.py[j] as f64;
                    let d2 = ddx * ddx + ddy * ddy;
                    if d2 > 4.0 {
                        continue;
                    }
                    let d = d2.sqrt() + 1e-3;
                    let mut f = SF_A * exp((RADS - d) / SF_B);
                    if d < RADS {
                        f += SF_K * (RADS - d);
                    }
                    fx += ddx / d * f;
                    fy += ddy / d * f;
                    if d < 1.5 {
                        nn += 1;
                        avx += self.vx[j] as f64;
                        avy += self.vy[j] as f64;
                    }
                    let lj = self.lead[j];
                    if lj >= 0 {
                        votes[lj as usize] += 1.0;
                    }
                }
            }
        }
        let rho = (nn as f64 + 1.0) / 7.07;
        let (g, ggx, ggy) = self.gas_sample(x, y);

        let mut rng = self.rng[i];
        let mut pt = self.panic_t[i] as f64;
        let mut flx = self.flee_x[i] as f64;
        let mut fly = self.flee_y[i] as f64;
        let mut gone = 0u8;
        let mut counted: i16 = -1;

        // --- attachment ---
        let mut l: i32 = self.lead[i] as i32;
        if pt > 0.0 {
            pt = f32r(pt - dt);
            l = -1;
            if pt <= 0.0 && xorshift(&mut rng) < GO_HOME {
                gone = 1;
            }
        } else {
            if l >= 0 {
                let ld = &self.leaders[l as usize];
                let dl = (ld.x - x).hypot(ld.y - y);
                if !(dl < 25.0 + 1.5 * (ld.count as f64).sqrt() || (votes[l as usize] >= 2.0 && dl < 700.0)) {
                    l = -1;
                }
            }
            if l < 0 {
                let mut bv = 2.5f64;
                for k in 0..nl {
                    if votes[k] as f64 > bv {
                        bv = votes[k] as f64;
                        l = k as i32;
                    }
                }
                if l < 0 {
                    for k in 0..nl {
                        let ld = &self.leaders[k];
                        if (ld.x - x).hypot(ld.y - y) < 20.0 && xorshift(&mut rng) < dt * 0.8 {
                            l = k as i32;
                            break;
                        }
                    }
                }
            }
        }
        let mut lead_out = l as i16;

        // --- desired velocity ---
        let (mut dxd, mut dyd, mut vdes) = (0.0f64, 0.0f64, 0.0f64);
        let v0 = self.v0[i] as f64;
        if pt > 0.0 {
            if g > 0.02 && (ggx != 0.0 || ggy != 0.0) {
                let ll = ggx.hypot(ggy);
                flx = f32r(-ggx / ll);
                fly = f32r(-ggy / ll);
            }
            dxd = flx;
            dyd = fly;
            vdes = 2.3;
        } else if l >= 0 {
            let ld = &self.leaders[l as usize];
            counted = l as i16;
            let cluster = (ld.count as f64).sqrt() * 0.95 + 3.0;
            let fd = if ld.has_field { self.field_dir(&self.goal, x, y) } else { None };
            if let Some((tx, ty)) = fd {
                dxd = tx;
                dyd = ty;
                let my = self.field_dist(&self.goal, x, y);
                if ld.arrived {
                    vdes = if my > cluster { v0 } else { 0.0 };
                } else {
                    let ahead = ld.prog - my;
                    vdes = if ahead > 2.0 { 0.0 } else if ahead > -1.0 { v0 * 0.6 } else if ahead < -15.0 { v0 * 1.25 } else { v0 };
                }
            } else if let Some((tx, ty)) = dir_to(x, y, ld.x, ld.y) {
                dxd = tx;
                dyd = ty;
                vdes = if (ld.x - x).hypot(ld.y - y) > cluster { v0 } else { 0.0 };
            }
        }
        if g > 0.05 && pt <= 0.0 {
            let ll = ggx.hypot(ggy);
            if ll > 1e-5 {
                let w = f64::min(1.0, g / 0.25);
                dxd = dxd * (1.0 - w) - ggx / ll * w * 1.5;
                dyd = dyd * (1.0 - w) - ggy / ll * w * 1.5;
                let mut dl = dxd.hypot(dyd);
                if dl == 0.0 { dl = 1.0; }
                dxd /= dl;
                dyd /= dl;
                vdes = f64::max(vdes, 1.4);
            }
            if g > 0.4 && xorshift(&mut rng) < dt * g * 0.9 {
                // makePanic(i, 12 + rnd*18, -gGX, -gGY)
                let t = 12.0 + xorshift(&mut rng) * 18.0;
                pt = f32r(f64::max(pt, t));
                lead_out = -1;
                let mut ll = ggx.hypot(ggy);
                if ll == 0.0 { ll = 1.0; }
                flx = f32r(-ggx / ll);
                fly = f32r(-ggy / ll);
            }
        }
        let fw = if rho < 0.3 { 1.0 } else { f64::max(0.05, 1.0 - exp(-1.913 * (1.0 / rho - 1.0 / 5.4))) };
        vdes *= fw;
        if g > 1.0 {
            vdes *= 0.7;
        }
        let vxi = self.vx[i] as f64;
        let vyi = self.vy[i] as f64;
        let mut ax = (dxd * vdes - vxi) / TAU + fx;
        let mut ay = (dyd * vdes - vyi) / TAU + fy;
        if nn != 0 {
            ax += VISC * (avx / nn as f64 - vxi);
            ay += VISC * (avy / nn as f64 - vyi);
        }
        // walls
        let c = self.cell_of(x, y);
        if self.clear[c] <= 1 {
            let cols = self.cols as usize;
            let gx = self.clear[c + 1] as i32 - self.clear[c - 1] as i32;
            let gy = self.clear[c + cols] as i32 - self.clear[c - cols] as i32;
            let gl = (gx as f64).hypot(gy as f64);
            if gl > 0.0 {
                ax += gx as f64 / gl * 2.5;
                ay += gy as f64 / gl * 2.5;
            }
        }
        // leaders part the crowd
        for ld in &self.leaders {
            let ex = x - ld.x;
            let ey = y - ld.y;
            if ex > 3.0 || ex < -3.0 || ey > 3.0 || ey < -3.0 {
                continue;
            }
            let d = ex.hypot(ey) + 1e-3;
            if d < 2.6 {
                let f = 5.0 * (2.6 - d);
                ax += ex / d * f;
                ay += ey / d * f;
            }
        }
        let mut nvx = vxi + ax * dt;
        let mut nvy = vyi + ay * dt;
        let sp = nvx.hypot(nvy);
        let vmax = if pt > 0.0 { 3.4 } else { 2.4 };
        if sp > vmax {
            nvx *= vmax / sp;
            nvy *= vmax / sp;
        }
        let nx = x + nvx * dt;
        let ny = y + nvy * dt;
        let (mut opx, mut opy) = (x, y);
        if self.walk_at(nx, ny) {
            opx = nx;
            opy = ny;
        } else if self.walk_at(nx, y) {
            opx = nx;
            nvy = 0.0;
        } else if self.walk_at(x, ny) {
            opy = ny;
            nvx = 0.0;
        } else {
            nvx *= -0.2;
            nvy *= -0.2;
        }
        AgentOut {
            px: opx as f32, py: opy as f32, vx: nvx as f32, vy: nvy as f32,
            panic_t: pt as f32, flee_x: flx as f32, flee_y: fly as f32, rng, lead: lead_out, counted, gone,
        }
    }

    #[inline(always)]
    fn apply(&mut self, i: usize, o: &AgentOut) {
        self.px[i] = o.px;
        self.py[i] = o.py;
        self.vx[i] = o.vx;
        self.vy[i] = o.vy;
        self.panic_t[i] = o.panic_t;
        self.flee_x[i] = o.flee_x;
        self.flee_y[i] = o.flee_y;
        self.rng[i] = o.rng;
        self.lead[i] = o.lead;
        self.gone[i] = o.gone;
    }

    fn finish_step(&mut self, counts: &[i32]) {
        for (l, c) in self.leaders.iter_mut().zip(counts) {
            l.count = *c;
        }
        let mut i = self.na;
        while i > 0 {
            i -= 1;
            if self.gone[i] != 0 {
                self.na -= 1;
                self.dispersed += 1;
                let n = self.na;
                if i != n {
                    self.px[i] = self.px[n]; self.py[i] = self.py[n]; self.vx[i] = self.vx[n]; self.vy[i] = self.vy[n];
                    self.v0[i] = self.v0[n]; self.rng[i] = self.rng[n]; self.panic_t[i] = self.panic_t[n];
                    self.flee_x[i] = self.flee_x[n]; self.flee_y[i] = self.flee_y[n]; self.lead[i] = self.lead[n]; self.gone[i] = self.gone[n];
                }
            }
        }
    }

    /// Faithful sequential step (same update order as the JS).
    pub fn step_seq(&mut self, dt: f64) {
        self.build_hash();
        self.update_leaders(dt);
        let mut counts = [0i32; 32];
        for i in 0..self.na {
            let o = self.agent(i, dt);
            self.apply(i, &o);
            if o.counted >= 0 {
                counts[o.counted as usize] += 1;
            }
        }
        let nl = self.leaders.len();
        self.finish_step(&counts[..nl]);
    }

    /// Two-phase (Jacobi) step: compute all agents from the step-start state, then write back.
    /// `threads > 1` runs phase 1 multithreaded (std::thread::scope pool, or rayon with feature "rayon");
    /// `threads <= 1` runs it on the calling thread.
    pub fn step_two_phase(&mut self, dt: f64, threads: usize) {
        self.build_hash();
        self.update_leaders(dt);
        let na = self.na;
        let mut outs = std::mem::take(&mut self.outs);
        {
            let me = &*self;
            if threads > 1 {
                #[cfg(feature = "rayon")]
                outs[..na].par_iter_mut().enumerate().with_min_len(256).for_each(|(i, o)| *o = me.agent(i, dt));
                #[cfg(not(feature = "rayon"))]
                par_agents(me, &mut outs[..na], dt, threads);
            } else {
                for (i, o) in outs[..na].iter_mut().enumerate() {
                    *o = me.agent(i, dt);
                }
            }
        }
        let mut counts = [0i32; 32];
        for i in 0..na {
            let o = outs[i];
            self.apply(i, &o);
            if o.counted >= 0 {
                counts[o.counted as usize] += 1;
            }
        }
        self.outs = outs;
        let nl = self.leaders.len();
        self.finish_step(&counts[..nl]);
    }

    // ---------------- reporting ----------------
    pub fn checksum(&self) -> (f64, u32) {
        let mut s = 0.0f64;
        for i in 0..self.na {
            s += self.px[i] as f64 * ((i % 7) + 1) as f64 + self.py[i] as f64 * ((i % 11) + 1) as f64;
        }
        let mut h: u32 = 0x811c9dc5;
        for arr in [&self.px, &self.py] {
            for v in &arr[..self.na] {
                for b in v.to_le_bytes() {
                    h ^= b as u32;
                    h = h.wrapping_mul(0x01000193);
                }
            }
        }
        (s, h)
    }
    pub fn aggregate(&self) -> Aggregate {
        let (mut sum_adv, mut n_adv, mut sum_adv_f, mut n_adv_f, mut sum_sp) = (0.0, 0usize, 0.0, 0usize, 0.0);
        let (mut attached, mut idle, mut fleeing) = (0, 0, 0);
        for i in 0..self.na {
            let d1 = self.field_dist(&self.goal, self.px[i] as f64, self.py[i] as f64);
            let d0 = self.dist0[i];
            if d0.is_finite() && d1.is_finite() {
                sum_adv += d0 - d1;
                n_adv += 1;
                if self.lead[i] >= 0 {
                    sum_adv_f += d0 - d1;
                    n_adv_f += 1;
                }
            }
            sum_sp += (self.vx[i] as f64).hypot(self.vy[i] as f64);
            if self.panic_t[i] > 0.0 {
                fleeing += 1;
            } else if self.lead[i] >= 0 {
                attached += 1;
            } else {
                idle += 1;
            }
        }
        Aggregate {
            na: self.na, attached, idle, fleeing, gone: self.dispersed,
            mean_advance_all: sum_adv / n_adv as f64,
            mean_advance_followers: if n_adv_f > 0 { sum_adv_f / n_adv_f as f64 } else { 0.0 },
            mean_speed: sum_sp / self.na as f64,
        }
    }
}

fn dir_to(x: f64, y: f64, tx: f64, ty: f64) -> Option<(f64, f64)> {
    let dx = tx - x;
    let dy = ty - y;
    let l = dx.hypot(dy);
    if l < 1e-3 { None } else { Some((dx / l, dy / l)) }
}

pub fn field_checksum(f: &Field) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for c in 0..f.dir.len() {
        h ^= f.dir[c] as u32;
        h = h.wrapping_mul(0x01000193);
        h ^= (f.dist[c] & 255) as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

// =====================================================================
// C ABI for the WASM build (also compiles natively). Driven by bench/sim_wasm.mjs.
// =====================================================================
#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
/// # Safety
/// `ptr` must come from `wasm_alloc(len)` and hold a fixture; it is freed here.
#[no_mangle]
pub unsafe extern "C" fn sim_create(ptr: *mut u8, len: usize) -> *mut Sim {
    let bytes = Vec::from_raw_parts(ptr, len, len);
    Box::into_raw(Box::new(Sim::from_fixture(&bytes)))
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_step(s: *mut Sim, dt: f64) {
    (*s).step_seq(dt)
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_bench_field(s: *mut Sim) -> u32 {
    (*s).bench_field()
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_goal_field_checksum(s: *mut Sim) -> u32 {
    field_checksum(&(*s).goal)
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_na(s: *mut Sim) -> usize {
    (*s).na
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_px(s: *mut Sim) -> *const f32 {
    (*s).px.as_ptr()
}
/// # Safety
/// `s` must come from `sim_create`.
#[no_mangle]
pub unsafe extern "C" fn sim_py(s: *mut Sim) -> *const f32 {
    (*s).py.as_ptr()
}
/// Writes the checksum and aggregate stats into `out` (f64[32]):
/// [sum, fnv, NA, attached, idle, fleeing, gone, meanAdvAll, meanAdvFollowers, meanSpeed, nLeaders,
///  then per leader: count, x, y, prog, energy, arrived]
/// # Safety
/// `s` must come from `sim_create`; `out` must point to 64 f64s.
#[no_mangle]
pub unsafe extern "C" fn sim_report(s: *mut Sim, out: *mut f64) {
    let s = &*s;
    let o = std::slice::from_raw_parts_mut(out, 64);
    let (sum, fnv) = s.checksum();
    let a = s.aggregate();
    o[..11].copy_from_slice(&[
        sum, fnv as f64, a.na as f64, a.attached as f64, a.idle as f64, a.fleeing as f64, a.gone as f64,
        a.mean_advance_all, a.mean_advance_followers, a.mean_speed, s.leaders.len() as f64,
    ]);
    for (k, l) in s.leaders.iter().enumerate().take(8) {
        let b = 11 + k * 6;
        o[b..b + 6].copy_from_slice(&[l.count as f64, l.x, l.y, l.prog, l.energy, if l.arrived { 1.0 } else { 0.0 }]);
    }
}
