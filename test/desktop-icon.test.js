import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

// Read the exported pixels rather than asserting that a renderer used a particular API.
function readPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8, "8-bit app icon");
  assert.equal(bytes[25], 6, "app icon must contain RGBA pixels");
  assert.equal(bytes[28], 0, "non-interlaced app icon");
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  assert.equal(raw.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, "valid PNG row filter");
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0;
      const predicted = left + above - upperLeft;
      const distances = [left, above, upperLeft].map((value) => Math.abs(predicted - value));
      const paeth = [left, above, upperLeft][distances.indexOf(Math.min(...distances))];
      const adjustment = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      pixels[index] = (raw[y * (stride + 1) + x + 1] + adjustment) & 255;
    }
  }
  return { width, height, pixels, alpha: (x, y) => pixels[(y * width + x) * 4 + 3] };
}

const native = { skip: process.platform !== "darwin" && "Mac app icons are built on macOS" };

test("Dock icon has transparent rounded corners and carries the dark Formicand tile", native, async () => {
  const master = await readFile("build/atria-icon.png");
  assert.deepEqual(await readFile("dist/src/desktop/atria-icon.png"), master);
  const icon = readPng(master);
  assert.equal(icon.width, 1024);
  assert.equal(icon.height, 1024);
  for (const [x, y] of [
    [0, 0],
    [1023, 0],
    [0, 1023],
    [1023, 1023]
  ]) {
    assert.equal(icon.alpha(x, y), 0, "outer canvas stays transparent");
  }
  assert.ok(icon.alpha(100, 100) < 32, "tile corner is rounded");
  assert.equal(icon.alpha(512, 120), 255, "tile is solid inside the top edge");
  assert.equal(icon.alpha(512, 512), 255, "tile center is solid");
  let lightPixels = 0;
  let tilePixels = 0;
  for (let index = 0; index < icon.pixels.length; index += 4) {
    const [red, green, blue, alpha] = icon.pixels.subarray(index, index + 4);
    if (alpha !== 255) continue;
    if (red > 200 && green > 200 && blue > 200) lightPixels++;
    if (red < 40 && green < 40 && blue < 40) tilePixels++;
  }
  assert.ok(lightPixels > 50000, "the five-node mark remains prominent");
  assert.ok(tilePixels > 300000, "the tile is dark rather than the previous white tile");
});

test("Finder ICNS includes transparent artwork at every standard and Retina size", native, async () => {
  const bytes = await readFile("build/atria.icns");
  assert.equal(bytes.toString("ascii", 0, 4), "icns");
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const entries = new Map();
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= bytes.length);
    entries.set(bytes.toString("ascii", offset, offset + 4), bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.ok(entries.has("ic04"), "ICNS contains the standard 16px icon");
  assert.ok(entries.has("ic05"), "ICNS contains the standard 32px icon");
  const small = readPng(await readFile("build/atria.iconset/icon_16x16.png"));
  assert.equal(small.width, 16);
  assert.equal(small.height, 16);
  assert.equal(small.alpha(0, 0), 0);
  for (const [type, size] of [
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024]
  ]) {
    assert.ok(entries.has(type), `ICNS contains ${type}`);
    const icon = readPng(entries.get(type));
    assert.equal(icon.width, size);
    assert.equal(icon.height, size);
    assert.equal(icon.alpha(0, 0), 0, `${size}px icon retains transparency`);
    assert.equal(icon.alpha(size / 2, size / 2), 255);
  }
});
