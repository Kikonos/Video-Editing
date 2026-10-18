import { test } from "node:test";
import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { extractAudio, isMp4Family, NoSoundTrack } from "../src/engine/mp4audio.ts";

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
