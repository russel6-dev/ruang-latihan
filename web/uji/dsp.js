// STFT / iSTFT yang meniru persis torch.stft / torch.istft versi Demucs
// (n_fft 4096, hop 1024, jendela Hann periodik, normalized=True, center=True, padding reflect).

export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  // FFT kompleks di tempat (inverse=true -> tanpa pembagian 1/n)
  run(re, im, inverse = false) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sgn * this.sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

const NFFT = 4096, HOP = 1024;
let fft = null, win = null;
function setup() {
  if (fft) return;
  fft = new FFT(NFFT);
  win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT); // periodik
}

function reflectPad(x, left, right) {
  const L = x.length, out = new Float64Array(L + left + right);
  for (let i = 0; i < left; i++) out[i] = x[left - i];
  out.set(x, left);
  for (let j = 0; j < right; j++) out[left + L + j] = x[L - 2 - j];
  return out;
}

// HTDemucs._spec + _magnitude untuk satu kanal. Tulis ke mag[(ch*2+ri)*bins*T + f*T + t]
export function specChannel(x, mag, ch, T) {
  setup();
  const L = x.length, le = Math.ceil(L / HOP), pad = (HOP / 2) * 3;
  const p = reflectPad(x, pad, pad + le * HOP - L);
  const c = reflectPad(p, NFFT / 2, NFFT / 2); // center=True
  const bins = NFFT / 2, scale = 1 / Math.sqrt(NFFT);
  const re = fft.re, im = fft.im;
  for (let t = 0; t < le; t++) {
    const frame = t + 2; // z[..., 2:2+le]
    const off = frame * HOP;
    for (let i = 0; i < NFFT; i++) { re[i] = c[off + i] * win[i]; im[i] = 0; }
    fft.run(re, im);
    const baseR = (ch * 2) * bins * T, baseI = (ch * 2 + 1) * bins * T;
    for (let f = 0; f < bins; f++) {
      mag[baseR + f * T + t] = re[f] * scale;
      mag[baseI + f * T + t] = im[f] * scale;
    }
  }
}

// HTDemucs._ispec untuk satu (instrumen, kanal). spec: Float32Array output model, offset ke [s][c][ri][f][t].
export function ispecChannel(spec, offRe, offIm, T, length) {
  setup();
  const bins = NFFT / 2, pad = (HOP / 2) * 3;
  const frames = T + 4; // pad 2 frame kiri-kanan (nol)
  const le = HOP * Math.ceil(length / HOP) + 2 * pad;
  const total = NFFT + HOP * (frames - 1);
  const y = new Float64Array(total), env = new Float64Array(total);
  const re = fft.re, im = fft.im, scale = Math.sqrt(NFFT) / NFFT;
  for (let fr = 0; fr < frames; fr++) {
    const t = fr - 2;
    re.fill(0); im.fill(0);
    if (t >= 0 && t < T) {
      for (let f = 0; f < bins; f++) { re[f] = spec[offRe + f * T + t]; im[f] = spec[offIm + f * T + t]; }
      // bin Nyquist (2048) = 0; isi pasangan konjugat
      for (let f = 1; f < bins; f++) { re[NFFT - f] = re[f]; im[NFFT - f] = -im[f]; }
      im[0] = 0;
      fft.run(re, im, true);
    }
    const off = fr * HOP;
    for (let i = 0; i < NFFT; i++) {
      y[off + i] += re[i] * scale * win[i];
      env[off + i] += win[i] * win[i];
    }
  }
  const out = new Float32Array(length);
  const start = NFFT / 2 + pad; // center + crop pad
  for (let i = 0; i < length; i++) {
    const k = start + i;
    if (k < total && k - NFFT / 2 < le) out[i] = env[k] > 1e-11 ? y[k] / env[k] : 0;
  }
  return out;
}
