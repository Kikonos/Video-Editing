// Pulls the sound track out of an MP4 / QuickTime (.mov) video without
// decoding the picture, and repackages it as files any decoder accepts.
//
// Why: Safari's decodeAudioData can't open a QuickTime movie, and an iPhone
// hands web pages its videos (screen recordings included) as .mov. Reading
// only the audio samples is also far lighter than loading a whole video.
// Works on Blobs only (no DOM), so it runs in tests too.

export class NoSoundTrack extends Error {
  constructor() {
    super("This video has no sound track.");
    this.name = "NoSoundTrack";
  }
}

export interface ExtractedAudio {
  codec: "aac" | "mp3" | "pcm";
  sampleRate: number;
  channels: number;
  /** Ready-to-decode files, best first: an .m4a (AAC), .mp3 or .wav (PCM), then an ADTS .aac stream. */
  files: Blob[];
}

const CONTAINER_TOP = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot", "uuid"]);

const fourcc = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** True when the file is an ISO-BMFF / QuickTime container (mp4, mov, m4a, 3gp). */
export async function isMp4Family(file: Blob): Promise<boolean> {
  if (file.size < 8) return false;
  const v = new DataView(await file.slice(0, 8).arrayBuffer());
  return CONTAINER_TOP.has(fourcc(v, 4));
}

interface Box {
  type: string;
  /** Offset of the payload (after the header), relative to the view. */
  start: number;
  end: number;
}

function children(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = v.getUint32(o);
    const type = fourcc(v, o + 4);
    let head = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(v.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type, start: o + head, end: o + size });
    o += size;
  }
  return out;
}

const child = (v: DataView, b: Box, type: string) => children(v, b.start, b.end).find((c) => c.type === type) ?? null;

function path(v: DataView, b: Box | null, ...types: string[]): Box | null {
  let cur = b;
  for (const t of types) {
    if (!cur) return null;
    cur = child(v, cur, t);
  }
  return cur;
}

async function readMoov(file: Blob): Promise<DataView> {
  let o = 0;
  while (o + 8 <= file.size) {
    const h = new DataView(await file.slice(o, o + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = Number(h.getBigUint64(8));
    else if (size === 0) size = file.size - o;
    if (size < 8) break;
    if (type === "moov") return new DataView(await file.slice(o, o + size).arrayBuffer());
    o += size;
  }
  throw new Error("No movie header found.");
}

interface Track {
  timescale: number;
  /** In timescale units. */
  duration: number;
  entry: DataView;
  entryType: string;
  stts: Uint8Array;
  /** Constant sample size, or 0 when `table` holds per-sample sizes. */
  fixed: number;
  table: Uint32Array | null;
  count: number;
  /** Every chunk: its file offset and how many samples it holds. */
  chunks: { off: number; n: number }[];
  width: number;
  height: number;
}

function findTrack(v: DataView, handler: "soun" | "vide"): Track | null {
  const moov: Box = { type: "moov", start: 8, end: v.byteLength };
  for (const trak of children(v, moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(v, trak, "mdia");
    const hdlr = mdia && child(v, mdia, "hdlr");
    if (!mdia || !hdlr || fourcc(v, hdlr.start + 8) !== handler) continue;
    const mdhd = child(v, mdia, "mdhd");
    const stbl = path(v, mdia, "minf", "stbl");
    if (!mdhd || !stbl) continue;
    const v1 = v.getUint8(mdhd.start) === 1;
    const timescale = v1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
    const duration = v1 ? Number(v.getBigUint64(mdhd.start + 24)) : v.getUint32(mdhd.start + 16);
    const tkhd = child(v, trak, "tkhd");
    const width = tkhd ? v.getUint32(tkhd.end - 8) / 65536 : 0;
    const height = tkhd ? v.getUint32(tkhd.end - 4) / 65536 : 0;

    const stsd = child(v, stbl, "stsd");
    const stts = child(v, stbl, "stts");
    const stsc = child(v, stbl, "stsc");
    const stsz = child(v, stbl, "stsz");
    const stco = child(v, stbl, "stco") ?? child(v, stbl, "co64");
    if (!stsd || !stts || !stsc || !stsz || !stco) continue;

    // First sample description.
    const eStart = stsd.start + 8;
    const eSize = v.getUint32(eStart);
    const entry = new DataView(v.buffer, v.byteOffset + eStart, Math.min(eSize, stsd.end - eStart));
    const entryType = fourcc(v, eStart + 4);

    const fixed = v.getUint32(stsz.start + 4);
    const count = v.getUint32(stsz.start + 8);
    let table: Uint32Array | null = null;
    if (!fixed) {
      table = new Uint32Array(count);
      for (let i = 0; i < count; i++) table[i] = v.getUint32(stsz.start + 12 + i * 4);
    }

    const wide = stco.type === "co64";
    const nChunks = v.getUint32(stco.start + 4);
    const chunkOff = (i: number) => (wide ? Number(v.getBigUint64(stco.start + 8 + i * 8)) : v.getUint32(stco.start + 8 + i * 4));
    const nRuns = v.getUint32(stsc.start + 4);
    const runs = Array.from({ length: nRuns }, (_, i) => ({
      first: v.getUint32(stsc.start + 8 + i * 12) - 1,
      per: v.getUint32(stsc.start + 12 + i * 12),
    }));
    const chunks: { off: number; n: number }[] = [];
    let s = 0;
    for (let r = 0; r < runs.length && s < count; r++) {
      const last = r + 1 < runs.length ? runs[r + 1].first : nChunks;
      for (let c = runs[r].first; c < last && s < count; c++) {
        const n = Math.min(runs[r].per, count - s);
        chunks.push({ off: chunkOff(c), n });
        s += n;
      }
    }
    return {
      timescale,
      duration,
      entry,
      entryType,
      stts: new Uint8Array(v.buffer, v.byteOffset + stts.start, stts.end - stts.start),
      fixed,
      table,
      count: s,
      chunks,
      width,
      height,
    };
  }
  return null;
}

/** File offset and size of every sample (compressed audio: one AAC/MP3 frame each). */
function sampleLayout(t: Track): { offsets: number[]; sizes: number[] } {
  const offsets: number[] = [];
  const sizes: number[] = [];
  let i = 0;
  for (const c of t.chunks) {
    let o = c.off;
    for (let k = 0; k < c.n; k++, i++) {
      const size = t.fixed || t.table![i];
      offsets.push(o);
      sizes.push(size);
      o += size;
    }
  }
  return { offsets, sizes };
}

/** Finds a box by type anywhere inside a sample entry (QuickTime nests some in a 'wave' box). */
function findIn(entry: DataView, type: string, from = 8): Uint8Array | null {
  for (let o = from; o + 8 <= entry.byteLength; o++) {
    if (fourcc(entry, o + 4) !== type) continue;
    const size = entry.getUint32(o);
    if (size >= 8 && o + size <= entry.byteLength) return new Uint8Array(entry.buffer, entry.byteOffset + o, size);
  }
  return null;
}

interface Esds {
  oti: number;
  asc: Uint8Array | null;
}

function parseEsds(box: Uint8Array): Esds | null {
  const b = box;
  let o = 12; // size, type, version+flags
  const len = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[o++];
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return n;
  };
  if (b[o++] !== 0x03) return null;
  len();
  o += 2;
  const flags = b[o++];
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + b[o];
  if (flags & 0x20) o += 2;
  if (b[o++] !== 0x04) return null;
  len();
  const oti = b[o];
  o += 13;
  let asc: Uint8Array | null = null;
  if (o < b.length && b[o] === 0x05) {
    o++;
    const n = len();
    asc = b.slice(o, o + n);
  }
  return { oti, asc };
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAsc(asc: Uint8Array) {
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  const sfi = read(4);
  const rate = sfi === 15 ? read(24) : SAMPLE_RATES[sfi] ?? 44100;
  const channels = read(4);
  return { aot, sfi, rate, channels };
}

/** Reads every sample, merging nearby ranges so a file with tiny chunks still takes few reads. */
async function readRanges(file: Blob, offsets: number[], sizes: number[]): Promise<Uint8Array[]> {
  const order = offsets.map((_, i) => i).sort((a, b) => offsets[a] - offsets[b]);
  const out: Uint8Array[] = new Array(offsets.length);
  let i = 0;
  while (i < order.length) {
    const from = offsets[order[i]];
    let to = from + sizes[order[i]];
    let j = i + 1;
    while (j < order.length && offsets[order[j]] - to < 256 * 1024 && to - from < 8 * 1024 * 1024) {
      to = Math.max(to, offsets[order[j]] + sizes[order[j]]);
      j++;
    }
    const buf = new Uint8Array(await file.slice(from, to).arrayBuffer());
    for (let k = i; k < j; k++) {
      const s = order[k];
      out[s] = buf.subarray(offsets[s] - from, offsets[s] - from + sizes[s]);
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- writing

function u32(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function u16(n: number) {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n: number) => new Uint8Array(n);

function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const payload = cat(body);
  return cat([u32(payload.length + 8), ascii(type), payload]);
}

const full = (type: string, version: number, flags: number, ...body: Uint8Array[]) => box(type, u32((version << 24) | flags), ...body);

const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function buildM4a(t: Track, esds: Uint8Array, rate: number, channels: number, samples: Uint8Array[]): Blob {
  const n = samples.length;
  const sttsCount = new DataView(t.stts.buffer, t.stts.byteOffset).getUint32(4);
  let duration = 0;
  const sttsDv = new DataView(t.stts.buffer, t.stts.byteOffset, t.stts.length);
  for (let i = 0; i < sttsCount; i++) duration += sttsDv.getUint32(8 + i * 8) * sttsDv.getUint32(12 + i * 8);

  const mp4a = box(
    "mp4a",
    zeros(6),
    u16(1),
    zeros(8),
    u16(channels),
    u16(16),
    u16(0),
    u16(0),
    u32(rate < 65536 ? rate * 65536 : 0),
    esds,
  );
  const sizes = new Uint8Array(n * 4);
  const sv = new DataView(sizes.buffer);
  samples.forEach((s, i) => sv.setUint32(i * 4, s.length));
  const stbl = (chunkOffset: number) =>
    box(
      "stbl",
      full("stsd", 0, 0, u32(1), mp4a),
      box("stts", t.stts.slice(0, 8 + sttsCount * 8)),
      full("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
      full("stsz", 0, 0, u32(0), u32(n), sizes),
      full("stco", 0, 0, u32(1), u32(chunkOffset)),
    );
  const moov = (chunkOffset: number) =>
    box(
      "moov",
      full("mvhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(duration), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)),
      box(
        "trak",
        full("tkhd", 0, 7, u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0x100), u16(0), MATRIX, u32(0), u32(0)),
        box(
          "mdia",
          full("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(duration), u16(0x55c4), u16(0)),
          full("hdlr", 0, 0, u32(0), ascii("soun"), zeros(12), ascii("SoundHandler\0")),
          box(
            "minf",
            full("smhd", 0, 0, u16(0), u16(0)),
            box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
            stbl(chunkOffset),
          ),
        ),
      ),
    );
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A "), ascii("mp42"), ascii("isom"));
  const dataLen = samples.reduce((a, s) => a + s.length, 0);
  const head = moov(0);
  const offset = ftyp.length + head.length + 8;
  return new Blob([ftyp, moov(offset), u32(dataLen + 8), ascii("mdat"), ...samples] as BlobPart[], { type: "audio/mp4" });
}

function buildAdts(asc: ReturnType<typeof parseAsc>, samples: Uint8Array[]): Blob | null {
  if (asc.sfi === 15 || asc.aot < 1 || asc.aot > 4) return null;
  const parts: Uint8Array[] = [];
  for (const s of samples) {
    const len = s.length + 7;
    parts.push(
      new Uint8Array([
        0xff,
        0xf1,
        ((asc.aot - 1) << 6) | (asc.sfi << 2) | ((asc.channels >> 2) & 1),
        ((asc.channels & 3) << 6) | (len >> 11),
        (len >> 3) & 0xff,
        ((len & 7) << 5) | 0x1f,
        0xfc,
      ]),
      s,
    );
  }
  return new Blob(parts as BlobPart[], { type: "audio/aac" });
}

// ------------------------------------------------------------------ PCM

interface PcmFormat {
  channels: number;
  rate: number;
  bits: number;
  float: boolean;
  bigEndian: boolean;
  /** 8-bit QuickTime 'raw ' is unsigned. */
  unsigned: boolean;
}

const PCM_TYPES = new Set(["sowt", "twos", "raw ", "in24", "in32", "fl32", "fl64", "lpcm", "ipcm"]);

/** Uncompressed sound (Canon and most other cameras record this in .MOV). */
function pcmFormat(t: Track): PcmFormat | null {
  if (!PCM_TYPES.has(t.entryType)) return null;
  const e = t.entry;
  const version = e.getUint16(16);
  const enda = findIn(e, "enda", 36);
  const little = enda ? new DataView(enda.buffer, enda.byteOffset + 8, 2).getUint16(0) === 1 : false;
  if (version === 2) {
    const flags = e.getUint32(60);
    return {
      channels: e.getUint32(48),
      rate: e.getFloat64(40),
      bits: e.getUint32(56),
      float: (flags & 1) !== 0,
      bigEndian: (flags & 2) !== 0,
      unsigned: (flags & 4) === 0 && e.getUint32(56) === 8,
    };
  }
  const channels = e.getUint16(24);
  const rate = e.getUint32(32) / 65536;
  const type = t.entryType;
  const bits = type === "in24" ? 24 : type === "in32" || type === "fl32" ? 32 : type === "fl64" ? 64 : e.getUint16(26);
  return {
    channels,
    rate,
    bits,
    float: type === "fl32" || type === "fl64",
    bigEndian: type === "sowt" ? false : !little,
    unsigned: type === "raw ",
  };
}

function wav16(frames: Int16Array, channels: number, rate: number): Blob {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o: number, x: string) => [...x].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  h.setUint32(4, 36 + frames.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, channels, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * 2, true);
  h.setUint16(32, channels * 2, true);
  h.setUint16(34, 16, true);
  str(36, "data");
  h.setUint32(40, frames.byteLength, true);
  return new Blob([h.buffer, frames.buffer as ArrayBuffer], { type: "audio/wav" });
}

/** Reads PCM chunk by chunk into a 16-bit WAV, averaging down to at most `maxRate`. */
async function readPcm(file: Blob, t: Track, f: PcmFormat, maxRate: number): Promise<Blob> {
  const bytesPer = f.bits / 8;
  const frameBytes = bytesPer * f.channels;
  if (!frameBytes || !f.channels || !f.rate) throw new Error("Unreadable sound format.");
  // Old-style tables count frames with a nominal size of 1 byte.
  const sizes: number[] = [];
  let i = 0;
  for (const c of t.chunks) {
    let n = 0;
    for (let k = 0; k < c.n; k++, i++) n += t.fixed === 1 ? frameBytes : t.fixed || t.table![i];
    sizes.push(n);
  }
  const totalFrames = Math.floor(sizes.reduce((a, b) => a + b, 0) / frameBytes);
  const step = Math.max(1, Math.floor(f.rate / maxRate));
  const outCh = Math.min(2, f.channels);
  const out = new Int16Array(Math.ceil(totalFrames / step) * outCh);
  const acc = new Float64Array(outCh);
  let inStep = 0;
  let w = 0;
  const parts = await readRanges(file, t.chunks.map((c) => c.off), sizes);
  for (const part of parts) {
    const dv = new DataView(part.buffer, part.byteOffset, part.byteLength);
    const le = !f.bigEndian;
    const n = Math.floor(part.byteLength / frameBytes);
    for (let fr = 0; fr < n; fr++) {
      for (let ch = 0; ch < outCh; ch++) {
        const o = fr * frameBytes + ch * bytesPer;
        let x: number;
        if (f.float) x = f.bits === 64 ? dv.getFloat64(o, le) : dv.getFloat32(o, le);
        else if (f.bits === 16) x = dv.getInt16(o, le) / 32768;
        else if (f.bits === 24) {
          const b0 = dv.getUint8(o);
          const b1 = dv.getUint8(o + 1);
          const b2 = dv.getUint8(o + 2);
          const v = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
          x = ((v << 8) >> 8) / 8388608;
        } else if (f.bits === 32) x = dv.getInt32(o, le) / 2147483648;
        else x = f.unsigned ? (dv.getUint8(o) - 128) / 128 : dv.getInt8(o) / 128;
        acc[ch] += x;
      }
      if (++inStep === step) {
        for (let ch = 0; ch < outCh; ch++) {
          out[w++] = Math.max(-32768, Math.min(32767, Math.round((acc[ch] / step) * 32767)));
          acc[ch] = 0;
        }
        inStep = 0;
      }
    }
  }
  return wav16(out.subarray(0, w), outCh, Math.round(f.rate / step));
}

/**
 * The sound track of an MP4/MOV as decodable files. Throws NoSoundTrack when
 * the movie has none, and a plain Error for codecs it can't repackage.
 * `maxRate` caps the sample rate of uncompressed sound (scanning only needs
 * loudness, and a minute of camera PCM is 11 MB at full rate).
 */
export async function extractAudio(file: Blob, opts: { maxRate?: number } = {}): Promise<ExtractedAudio> {
  const moov = await readMoov(file);
  const t = findTrack(moov, "soun");
  if (!t || !t.count) throw new NoSoundTrack();

  const pcm = pcmFormat(t);
  if (pcm) {
    const wav = await readPcm(file, t, pcm, opts.maxRate ?? 192000);
    return { codec: "pcm", sampleRate: pcm.rate, channels: pcm.channels, files: [wav] };
  }

  const esdsBox = findIn(t.entry, "esds");
  const esds = esdsBox && parseEsds(esdsBox);
  const { offsets, sizes } = sampleLayout(t);
  const samples = await readRanges(file, offsets, sizes);

  if (t.entryType === ".mp3" || (esds && (esds.oti === 0x6b || esds.oti === 0x69))) {
    return { codec: "mp3", sampleRate: 0, channels: 0, files: [new Blob(samples as BlobPart[], { type: "audio/mpeg" })] };
  }
  if (!esds || !esds.asc || ![0x40, 0x66, 0x67, 0x68].includes(esds.oti)) {
    throw new Error(`Unsupported sound format (${t.entryType.trim()}).`);
  }
  const asc = parseAsc(esds.asc);
  const channels = asc.channels || 2;
  const files = [buildM4a(t, esdsBox!, asc.rate, channels, samples)];
  const adts = buildAdts(asc, samples);
  if (adts) files.push(adts);
  return { codec: "aac", sampleRate: asc.rate, channels, files };
}

// ---------------------------------------------------------------- video

export interface VideoInfo {
  /** "H.264", "HEVC", "ProRes", ... or the raw four-letter code. */
  codec: string;
  width: number;
  height: number;
  fps: number;
  chroma: "4:2:0" | "4:2:2" | "4:4:4" | null;
  bitDepth: number | null;
  /** False when iPhones and Macs can't decode this in a browser. Null when unknown. */
  playable: boolean | null;
  /** e.g. "4K HEVC 10-bit 4:2:2, 50 fps" */
  summary: string;
}

const CODECS: Record<string, string> = {
  avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", dvh1: "HEVC (Dolby Vision)", dvhe: "HEVC (Dolby Vision)",
  apch: "ProRes", apcn: "ProRes", apcs: "ProRes", apco: "ProRes", ap4h: "ProRes 4444", ap4x: "ProRes 4444 XQ",
  mp4v: "MPEG-4", mjpa: "Motion JPEG", mjpb: "Motion JPEG", jpeg: "Motion JPEG", av01: "AV1", vp09: "VP9",
  "xd5c": "XDCAM HD", "dvhp": "DVCPRO HD", "dvc ": "DV", "dvcp": "DV",
};

/** What the picture is encoded as, read from the container (for explaining why a clip won't open). */
export async function videoInfo(file: Blob): Promise<VideoInfo | null> {
  if (!(await isMp4Family(file))) return null;
  const moov = await readMoov(file);
  const t = findTrack(moov, "vide");
  if (!t) return null;
  const e = t.entry;
  const codec = CODECS[t.entryType] ?? t.entryType.trim();
  const width = t.width || e.getUint16(32);
  const height = t.height || e.getUint16(34);
  const fps = t.duration ? Math.round((t.count / (t.duration / t.timescale)) * 100) / 100 : 0;
  let chroma: VideoInfo["chroma"] = null;
  let bitDepth: number | null = null;
  let playable: boolean | null = null;
  const avcC = findIn(e, "avcC", 86);
  const hvcC = findIn(e, "hvcC", 86);
  if (avcC && avcC.length > 9) {
    const profile = avcC[9];
    chroma = profile === 122 ? "4:2:2" : profile === 244 || profile === 44 ? "4:4:4" : "4:2:0";
    bitDepth = profile === 110 || profile === 122 || profile === 244 ? 10 : 8;
    // Apple's hardware decodes 8-bit 4:2:0 H.264 only.
    playable = profile !== 110 && profile !== 122 && profile !== 244 && profile !== 44;
  } else if (hvcC && hvcC.length > 25) {
    const c = hvcC[8 + 16] & 3;
    chroma = c === 2 ? "4:2:2" : c === 3 ? "4:4:4" : "4:2:0";
    bitDepth = (hvcC[8 + 17] & 7) + 8;
    playable = c <= 1 && bitDepth <= 10;
  } else if (codec === "Motion JPEG" || codec.startsWith("DV") || codec.startsWith("XDCAM")) {
    playable = false;
  }
  const res = Math.max(width, height) >= 3800 ? "4K " : Math.min(width, height) >= 1070 ? "1080p " : Math.min(width, height) >= 700 ? "720p " : "";
  const detail = [bitDepth && bitDepth > 8 ? `${bitDepth}-bit` : "", chroma && chroma !== "4:2:0" ? chroma : ""].filter(Boolean).join(" ");
  const summary = `${res}${codec}${detail ? " " + detail : ""}${fps ? `, ${Math.round(fps)} fps` : ""}`;
  return { codec, width, height, fps, chroma, bitDepth, playable, summary };
}
