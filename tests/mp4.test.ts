import { test } from "node:test";
import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { extractAudio, isMp4Family, NoSoundTrack, videoInfo, videoTrack } from "../src/engine/mp4.ts";

// Fixtures made with ffmpeg: 3 s stereo AAC tones in a QuickTime .mov (esds
// nested in a 'wave' box, as iPhones write) and in a faststart .mp4, a .mp4
// with MP3 sound, and a .mov with no sound track.
const fixture = (name: string) => openAsBlob(new URL(`./fixtures/${name}`, import.meta.url));

test("recognises mp4 and QuickTime containers", async () => {
  assert.equal(await isMp4Family(await fixture("tone.mov")), true);
  assert.equal(await isMp4Family(await fixture("tone-faststart.mp4")), true);
  assert.equal(await isMp4Family(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0x20])])), false);
});

for (const name of ["tone.mov", "tone-faststart.mp4"]) {
  test(`pulls the AAC sound out of ${name} as m4a and ADTS`, async () => {
    const r = await extractAudio(await fixture(name));
    assert.equal(r.codec, "aac");
    assert.equal(r.sampleRate, 44100);
    assert.equal(r.channels, 2);
    assert.equal(r.files.length, 2);
    assert.equal(r.files[0].type, "audio/mp4");
    assert.equal(r.files[1].type, "audio/aac");

    // The m4a is a valid container in its own right: extracting from it again
    // gives the same audio frames.
    const again = await extractAudio(r.files[0]);
    assert.equal(again.codec, "aac");
    assert.equal(again.sampleRate, 44100);

    // ADTS: every frame starts with the sync word.
    const adts = new Uint8Array(await r.files[1].arrayBuffer());
    let o = 0;
    let frames = 0;
    while (o < adts.length) {
      assert.equal(adts[o], 0xff);
      assert.equal(adts[o + 1] & 0xf6, 0xf0);
      o += ((adts[o + 3] & 3) << 11) | (adts[o + 4] << 3) | (adts[o + 5] >> 5);
      frames++;
    }
    assert.equal(o, adts.length);
    assert.ok(frames > 120 && frames < 140, `${frames} AAC frames for 3 s`);
  });
}

test("passes MP3 sound through as an .mp3 stream", async () => {
  const r = await extractAudio(await fixture("mp3.mp4"));
  assert.equal(r.codec, "mp3");
  const b = new Uint8Array(await r.files[0].arrayBuffer());
  assert.equal(b[0], 0xff);
  assert.equal(b[1] & 0xe0, 0xe0);
});

test("says when a video has no sound track", async () => {
  await assert.rejects(extractAudio(await fixture("silent.mov")), NoSoundTrack);
});

// Cameras (Canon and most others) record uncompressed sound in .MOV.
for (const [name, channels] of [["pcm-sowt.mov", 2], ["pcm-twos.mov", 2], ["pcm-s24.mov", 1]] as const) {
  test(`reads camera PCM sound from ${name} as a WAV`, async () => {
    const r = await extractAudio(await fixture(name));
    assert.equal(r.codec, "pcm");
    assert.equal(r.channels, channels);
    const wav = new DataView(await r.files[0].arrayBuffer());
    assert.equal(String.fromCharCode(wav.getUint8(8), wav.getUint8(9), wav.getUint8(10), wav.getUint8(11)), "WAVE");
    assert.equal(wav.getUint16(22, true), channels);
    assert.equal(wav.getUint32(24, true), 8000);
    // One second of a 440 Hz tone: it crosses zero about 880 times.
    let crossings = 0;
    for (let o = 44 + channels * 2; o < wav.byteLength; o += channels * 2) {
      if ((wav.getInt16(o - channels * 2, true) < 0) !== (wav.getInt16(o, true) < 0)) crossings++;
    }
    assert.ok(crossings > 860 && crossings < 900, `${crossings} zero crossings`);
  });
}

test("reads PCM at a lower rate for scanning", async () => {
  const r = await extractAudio(await fixture("pcm-sowt.mov"), { maxRate: 1000 });
  const wav = new DataView(await r.files[0].arrayBuffer());
  assert.equal(wav.getUint32(24, true), 1000);
  assert.equal(wav.getUint32(40, true), 1000 * 2 * 2);
});

test("tells which videos iPhones can't play", async () => {
  const ok = await videoInfo(await fixture("pcm-sowt.mov"));
  assert.equal(ok?.codec, "H.264");
  assert.equal(ok?.playable, true);
  const h264pro = await videoInfo(await fixture("h264-422-10.mov"));
  assert.equal(h264pro?.chroma, "4:2:2");
  assert.equal(h264pro?.playable, false);
  const hevc422 = await videoInfo(await fixture("hevc-422-10.mov"));
  assert.equal(hevc422?.codec, "HEVC");
  assert.equal(hevc422?.bitDepth, 10);
  assert.equal(hevc422?.chroma, "4:2:2");
  assert.equal(hevc422?.playable, false);
  assert.match(hevc422!.summary, /HEVC 10-bit 4:2:2, 25 fps/);
  const hevc420 = await videoInfo(await fixture("hevc-420-10.mov"));
  assert.equal(hevc420?.playable, true);
});

test("reads H.264 picture samples in decode order with display times", async () => {
  const v = await videoTrack(await fixture("h264-bframes.mov"));
  assert.ok(v);
  assert.equal(v.codec, "avc1.64000a");
  assert.equal(v.samples.length, 60);
  assert.equal(v.samples.filter((s) => s.key).length, 4);
  // B-frames: decode order differs from display order (values from ffprobe).
  assert.deepEqual(v.samples.slice(0, 4).map((s) => Math.round(s.t * 30)), [0, 3, 1, 2]);
  const shown = v.samples.map((s) => s.t).sort((a, b) => a - b);
  assert.equal(shown[0], 0);
  assert.ok(Math.abs(shown[59] - 59 / 30) < 1e-6);
  assert.equal(v.rotation, 0);
});

test("reads the rotation phones store portrait video with", async () => {
  // ffmpeg's display_rotation 90 is anticlockwise: 270 clockwise.
  assert.equal((await videoTrack(await fixture("h264-rotated.mov")))?.rotation, 270);
});

test("builds codec strings for HEVC and VP9", async () => {
  assert.equal((await videoTrack(await fixture("hevc-420-10.mov")))?.codec, "hvc1.2.4.L30.90");
  const vp9 = await videoTrack(await fixture("vp9.mp4"));
  assert.equal(vp9?.codec, "vp09.00.10.08");
  assert.equal(vp9?.description, null);
});
