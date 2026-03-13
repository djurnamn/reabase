import { describe, it, expect } from "vitest";
import { normalizeStateBlob } from "../../src/snapshot/normalize.js";

// ─── helpers ──────────────────────────────────────────────────

/** Encode a Buffer as a multi-line base64 string (matching RPP blob format). */
function toBlob(binary: Buffer): string {
  const raw = binary.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 76) {
    lines.push(raw.slice(i, i + 76));
  }
  return lines.join("\n");
}

// ─── VST2 ─────────────────────────────────────────────────────

describe("normalizeStateBlob — VST2", () => {
  function buildVst2Blob(options: {
    header?: Buffer;
    chunk: Buffer;
    trailer?: Buffer;
  }): string {
    const header = options.header ?? Buffer.alloc(8, 0x00);
    const trailer = options.trailer ?? Buffer.alloc(8, 0x00);
    return toBlob(Buffer.concat([header, options.chunk, trailer]));
  }

  it("strips REAPER header and trailer, hashing only the plugin chunk", () => {
    const chunk = Buffer.from("plugin-state-data-here", "utf-8");

    const blob1 = buildVst2Blob({
      header: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
      chunk,
      trailer: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22]),
    });

    const blob2 = buildVst2Blob({
      header: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]),
      chunk,
      trailer: Buffer.from([0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00]),
    });

    // Different wrappers, same chunk → same normalized output
    expect(normalizeStateBlob(blob1, "VST")).toBe(
      normalizeStateBlob(blob2, "VST")
    );
  });

  it("produces different output when plugin chunk differs", () => {
    const blob1 = buildVst2Blob({
      chunk: Buffer.from("state-version-A", "utf-8"),
    });
    const blob2 = buildVst2Blob({
      chunk: Buffer.from("state-version-B", "utf-8"),
    });

    expect(normalizeStateBlob(blob1, "VST")).not.toBe(
      normalizeStateBlob(blob2, "VST")
    );
  });

  it("falls back to full blob when data is too short", () => {
    const tinyBlob = toBlob(Buffer.from([0x01, 0x02, 0x03]));
    expect(normalizeStateBlob(tinyBlob, "VST")).toBe(tinyBlob);
  });
});

// ─── VST3 ─────────────────────────────────────────────────────

describe("normalizeStateBlob — VST3", () => {
  function buildVst3Blob(options: {
    componentState: Buffer;
    controllerState?: Buffer;
    separator?: number;
  }): string {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(options.componentState.length, 0);
    header.writeUInt32LE(options.separator ?? 0x00000001, 4);

    const parts = [header, options.componentState];
    if (options.controllerState) {
      parts.push(options.controllerState);
    }
    return toBlob(Buffer.concat(parts));
  }

  it("extracts only IComponent state, ignoring IEditController state", () => {
    const componentState = Buffer.from("dsp-parameters-data", "utf-8");

    const blob1 = buildVst3Blob({
      componentState,
      controllerState: Buffer.from("gui-state-version-1", "utf-8"),
    });

    const blob2 = buildVst3Blob({
      componentState,
      controllerState: Buffer.from("gui-state-version-2-scrolled", "utf-8"),
    });

    // Same component state, different controller state → same normalized output
    expect(normalizeStateBlob(blob1, "VST3")).toBe(
      normalizeStateBlob(blob2, "VST3")
    );
  });

  it("produces different output when component state differs", () => {
    const blob1 = buildVst3Blob({
      componentState: Buffer.from("params-A", "utf-8"),
      controllerState: Buffer.from("gui", "utf-8"),
    });

    const blob2 = buildVst3Blob({
      componentState: Buffer.from("params-B", "utf-8"),
      controllerState: Buffer.from("gui", "utf-8"),
    });

    expect(normalizeStateBlob(blob1, "VST3")).not.toBe(
      normalizeStateBlob(blob2, "VST3")
    );
  });

  it("works with no controller state (component-only plugins)", () => {
    const componentState = Buffer.from("dsp-only-plugin", "utf-8");
    const blob = buildVst3Blob({ componentState });

    // Should not throw, and should return the component state
    const normalized = normalizeStateBlob(blob, "VST3");
    expect(normalized).toBe(componentState.toString("base64"));
  });

  it("falls back to full blob when header length exceeds data", () => {
    // Claim component state is 9999 bytes but only provide 10
    const header = Buffer.alloc(8);
    header.writeUInt32LE(9999, 0);
    header.writeUInt32LE(1, 4);
    const blob = toBlob(Buffer.concat([header, Buffer.alloc(10)]));

    expect(normalizeStateBlob(blob, "VST3")).toBe(blob);
  });

  it("falls back to full blob when data is too short", () => {
    const tinyBlob = toBlob(Buffer.from([0x01, 0x02, 0x03]));
    expect(normalizeStateBlob(tinyBlob, "VST3")).toBe(tinyBlob);
  });
});

// ─── JS ───────────────────────────────────────────────────────

describe("normalizeStateBlob — JS", () => {
  it("returns blob unchanged (JS state is plain text)", () => {
    const blob = "some-jsfx-state-as-text";
    expect(normalizeStateBlob(blob, "JS")).toBe(blob);
  });
});

// ─── unknown type ─────────────────────────────────────────────

describe("normalizeStateBlob — unknown type", () => {
  it("returns blob unchanged for unrecognized plugin types", () => {
    const blob = "opaque-binary-data";
    expect(normalizeStateBlob(blob, "CLAP")).toBe(blob);
  });
});
