import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRpp, getTracks } from "../../src/parser/index.js";
import { captureFxChain, hashBlob } from "../../src/snapshot/capture.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("captureFxChain", () => {
  it("captures FX chain from a track with one FX", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];
    const chain = captureFxChain(track);

    expect(chain).toHaveLength(1);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[0].pluginType).toBe("AU");
    expect(chain[0].stateHash).toBeTruthy();
    expect(chain[0].stateBlob).toContain("6QMAAAA");
  });

  it("returns empty array for track without FX chain", () => {
    const root = parseRpp(readFixture("special-characters.rpp"));
    const tracks = getTracks(root);
    // DÖRR track has no FX chain
    const dorrTrack = tracks[1];
    const chain = captureFxChain(dorrTrack);

    expect(chain).toHaveLength(0);
  });

  it("captures multiple FX from a multi-track project", () => {
    const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
    const tracks = getTracks(root);

    // RÖSTER has a Limiter
    const rosterChain = captureFxChain(tracks[0]);
    expect(rosterChain).toHaveLength(1);
    expect(rosterChain[0].pluginName).toContain("kHs Limiter");

    // BJÖRN has a De-Esser
    const bjornChain = captureFxChain(tracks[1]);
    expect(bjornChain).toHaveLength(1);
    expect(bjornChain[0].pluginName).toContain("T-De-Esser 2");
  });

  it("produces different hashes for different states", () => {
    const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
    const tracks = getTracks(root);

    // BJÖRN and SARA both have De-Esser but with different state blobs
    const bjornChain = captureFxChain(tracks[1]);
    const saraChain = captureFxChain(tracks[2]);

    expect(bjornChain[0].pluginName).toBe(saraChain[0].pluginName);
    expect(bjornChain[0].stateHash).not.toBe(saraChain[0].stateHash);
  });
});

/**
 * Build a fake AU plugin state blob with a zip archive inside.
 *
 * Structure:
 *   [52-byte binary header] [plist XML with <data> containing base64-encoded zip]
 *
 * The zip is a minimal local file header + compressed data, with the
 * modification time at bytes 10-11 set to the provided value.
 */
function buildAuBlobWithZip(options: {
  zipModTime: number;
  zipModDate: number;
  compressedPayload: Buffer;
  filename?: string;
}): string {
  const {
    zipModTime,
    zipModDate,
    compressedPayload,
    filename = "state.json",
  } = options;

  const filenameBuffer = Buffer.from(filename, "utf-8");

  // Build a minimal ZIP local file header (30 bytes + filename + data)
  const localHeader = Buffer.alloc(30);
  // Signature: PK\x03\x04
  localHeader[0] = 0x50; // P
  localHeader[1] = 0x4b; // K
  localHeader[2] = 0x03;
  localHeader[3] = 0x04;
  // Version needed: 20
  localHeader.writeUInt16LE(20, 4);
  // General purpose bit flag: 0x0808 (UTF-8 filenames + data descriptor)
  localHeader.writeUInt16LE(0x0808, 6);
  // Compression method: 8 (deflate)
  localHeader.writeUInt16LE(8, 8);
  // Modification time (bytes 10-11) -- the non-deterministic field
  localHeader.writeUInt16LE(zipModTime, 10);
  // Modification date (bytes 12-13)
  localHeader.writeUInt16LE(zipModDate, 12);
  // CRC-32 (placeholder, not checked by our code)
  localHeader.writeUInt32LE(0xdeadbeef, 14);
  // Compressed size
  localHeader.writeUInt32LE(compressedPayload.length, 18);
  // Uncompressed size (placeholder)
  localHeader.writeUInt32LE(compressedPayload.length + 10, 22);
  // Filename length
  localHeader.writeUInt16LE(filenameBuffer.length, 26);
  // Extra field length
  localHeader.writeUInt16LE(0, 28);

  const zipData = Buffer.concat([localHeader, filenameBuffer, compressedPayload]);

  // Wrap zip in plist XML <data> tag
  const innerBase64 = zipData.toString("base64");
  const plistXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `\t<key>state</key>\n` +
    `\t<data>\n` +
    `\t${innerBase64}\n` +
    `\t</data>\n` +
    `</dict>\n` +
    `</plist>`;

  // 52-byte binary header (arbitrary but deterministic bytes)
  const binaryHeader = Buffer.alloc(52, 0x00);
  binaryHeader.write("AUpresetBinaryHeader!", 0, "utf-8");

  const fullBinary = Buffer.concat([binaryHeader, Buffer.from(plistXml, "utf-8")]);

  // Encode as base64 and split into 76-char lines (standard base64 line length)
  const rawBase64 = fullBinary.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < rawBase64.length; i += 76) {
    lines.push(rawBase64.slice(i, i + 76));
  }
  return lines.join("\n");
}

describe("hashBlob – AU zip timestamp stability", () => {
  // A fixed compressed payload that stands in for the actual deflated plugin state
  const compressedPayload = Buffer.from(
    '{"threshold":-18,"ratio":4,"attack":10,"release":100}',
    "utf-8",
  );

  it("produces the same hash when only the zip modification timestamp differs", () => {
    const blob1 = buildAuBlobWithZip({
      zipModTime: 0x4a85, // e.g. 09:20:10
      zipModDate: 0x5697, // e.g. 2023-04-23
      compressedPayload,
    });

    const blob2 = buildAuBlobWithZip({
      zipModTime: 0x6b2f, // e.g. 13:25:30 (different time)
      zipModDate: 0x569a, // e.g. 2023-04-26 (different date)
      compressedPayload,
    });

    // Sanity check: the raw blobs ARE different
    expect(blob1).not.toBe(blob2);

    // But the hashes should be identical because timestamps are neutralized
    expect(hashBlob(blob1, "AU")).toBe(hashBlob(blob2, "AU"));
  });

  it("produces a different hash when actual zip content differs", () => {
    const differentPayload = Buffer.from(
      '{"threshold":-24,"ratio":8,"attack":5,"release":200}',
      "utf-8",
    );

    const blob1 = buildAuBlobWithZip({
      zipModTime: 0x4a85,
      zipModDate: 0x5697,
      compressedPayload,
    });

    const blob2 = buildAuBlobWithZip({
      zipModTime: 0x4a85,
      zipModDate: 0x5697,
      compressedPayload: differentPayload,
    });

    expect(hashBlob(blob1, "AU")).not.toBe(hashBlob(blob2, "AU"));
  });

  it("produces a different hash when the zip filename differs", () => {
    const blob1 = buildAuBlobWithZip({
      zipModTime: 0x4a85,
      zipModDate: 0x5697,
      compressedPayload,
      filename: "state.json",
    });

    const blob2 = buildAuBlobWithZip({
      zipModTime: 0x4a85,
      zipModDate: 0x5697,
      compressedPayload,
      filename: "preset.json",
    });

    expect(hashBlob(blob1, "AU")).not.toBe(hashBlob(blob2, "AU"));
  });
});
