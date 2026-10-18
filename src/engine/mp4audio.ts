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
  codec: "aac" | "mp3";
  sampleRate: number;
  channels: number;
  /** Ready-to-decode files, best first: an .m4a (AAC) or .mp3, then an ADTS .aac stream. */
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
  entry: DataView;
  entryType: string;
  stts: Uint8Array;
  sizes: number[];
  /** File offset of every sample. */
  offsets: number[];
}

function soundTrack(v: DataView): Track | null {
  const moov: Box = { type: "moov", start: 8, end: v.byteLength };
  for (const trak of children(v, moov.start, moov.end).filter((b) => b.type === "trak")) {
    const mdia = child(v, trak, "mdia");
    const hdlr = mdia && child(v, mdia, "hdlr");
    if (!mdia || !hdlr || fourcc(v, hdlr.start + 8) !== "soun") continue;
    const mdhd = child(v, mdia, "mdhd");
    const stbl = path(v, mdia, "minf", "stbl");
    if (!mdhd || !stbl) continue;
    const timescale = v.getUint8(mdhd.start) === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);

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
    const sizes: number[] = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || v.getUint32(stsz.start + 12 + i * 4);

    const wide = stco.type === "co64";
    const nChunks = v.getUint32(stco.start + 4);
    const chunkOff = (i: number) => (wide ? Number(v.getBigUint64(stco.start + 8 + i * 8)) : v.getUint32(stco.start + 8 + i * 4));
    const nRuns = v.getUint32(stsc.start + 4);
    const runs = Array.from({ length: nRuns }, (_, i) => ({
      first: v.getUint32(stsc.start + 8 + i * 12) - 1,
      per: v.getUint32(stsc.start + 12 + i * 12),
    }));
    const offsets: number[] = [];
    let s = 0;
    for (let r = 0; r < runs.length && s < count; r++) {
      const last = r + 1 < runs.length ? runs[r + 1].first : nChunks;
      for (let c = runs[r].first; c < last && s < count; c++) {
        let o = chunkOff(c);
        for (let k = 0; k < runs[r].per && s < count; k++, s++) {
          offsets.push(o);
          o += sizes[s];
        }
      }
    }
    if (offsets.length < count) sizes.length = offsets.length;
    return { timescale, entry, entryType, stts: new Uint8Array(v.buffer, v.byteOffset + stts.start, stts.end - stts.start), sizes, offsets };
  }
  return null;
}

/** Finds the esds box inside a sample entry (QuickTime nests it in a 'wave' box). */
function findEsds(entry: DataView): Uint8Array | null {
  for (let o = 8; o + 8 <= entry.byteLength; o++) {
    if (fourcc(entry, o + 4) !== "esds") continue;
    const size = entry.getUint32(o);
    if (size >= 12 && o + size <= entry.byteLength) return new Uint8Array(entry.buffer, entry.byteOffset + o, size);
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
async function readSamples(file: Blob, offsets: number[], sizes: number[]): Promise<Uint8Array[]> {
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

/**
 * The sound track of an MP4/MOV as decodable files. Throws NoSoundTrack when
 * the movie has none, and a plain Error for codecs it can't repackage.
 */
export async function extractAudio(file: Blob): Promise<ExtractedAudio> {
  const moov = await readMoov(file);
  const t = soundTrack(moov);
  if (!t) throw new NoSoundTrack();
  if (!t.sizes.length) throw new NoSoundTrack();
  const esdsBox = findEsds(t.entry);
  const esds = esdsBox && parseEsds(esdsBox);
  const samples = await readSamples(file, t.offsets, t.sizes);

  if (t.entryType === ".mp3" || (esds && (esds.oti === 0x6b || esds.oti === 0x69))) {
    return { codec: "mp3", sampleRate: 0, channels: 0, files: [new Blob(samples as BlobPart[], { type: "audio/mpeg" })] };
  }
  if (!esds || !esds.asc || ![0x40, 0x66, 0x67, 0x68].includes(esds.oti)) {
    throw new Error(`Unsupported sound format (${t.entryType}).`);
  }
  const asc = parseAsc(esds.asc);
  const channels = asc.channels || 2;
  const files = [buildM4a(t, esdsBox!, asc.rate, channels, samples)];
  const adts = buildAdts(asc, samples);
  if (adts) files.push(adts);
  return { codec: "aac", sampleRate: asc.rate, channels, files };
}
