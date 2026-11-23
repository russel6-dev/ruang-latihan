// Encoder MP3 di background (lamejs, LGPL-3.0 — lihat vendor/LICENSE-lamejs.txt).
importScripts('../vendor/lame.min.js');

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

self.onmessage = (e) => {
  const { channels, sampleRate, kbps } = e.data;
  const nch = channels.length;
  const enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
  const left = toInt16(channels[0]);
  const right = nch > 1 ? toInt16(channels[1]) : null;
  const block = 1152;
  const parts = [];
  const total = left.length;
  let lastReport = 0;
  for (let i = 0; i < total; i += block) {
    const l = left.subarray(i, i + block);
    const buf = nch > 1 ? enc.encodeBuffer(l, right.subarray(i, i + block)) : enc.encodeBuffer(l);
    if (buf.length) parts.push(new Uint8Array(buf));
    if (i - lastReport > sampleRate * 5) {
      lastReport = i;
      self.postMessage({ progress: i / total });
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  self.postMessage({ done: true, blob: new Blob(parts, { type: 'audio/mpeg' }) });
};
