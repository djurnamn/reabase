import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRpp, parseValues, RppParseError } from "../../src/parser/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("parseValues", () => {
  it("parses unquoted tokens", () => {
    expect(parseValues("NAME BJÖRN")).toEqual(["NAME", "BJÖRN"]);
  });

  it("parses numbers", () => {
    expect(parseValues("VOLPAN 1 0 -1 -1 1")).toEqual([
      "VOLPAN",
      1,
      0,
      -1,
      -1,
      1,
    ]);
  });

  it("parses floats", () => {
    expect(parseValues("POSITION 44.5")).toEqual(["POSITION", 44.5]);
  });

  it("parses double-quoted strings", () => {
    expect(parseValues('"FLICKA MED SOLROS"')).toEqual(["FLICKA MED SOLROS"]);
  });

  it("parses single-quoted strings", () => {
    expect(parseValues("''")).toEqual([""]);
  });

  it("parses GUIDs as strings", () => {
    const result = parseValues("{66595AAC-8084-8049-8F26-93FAE19A27C6}");
    expect(result).toEqual(["{66595AAC-8084-8049-8F26-93FAE19A27C6}"]);
    expect(typeof result[0]).toBe("string");
  });

  it("parses colon-separated values as strings", () => {
    const result = parseValues("-1:U");
    expect(result).toEqual(["-1:U"]);
    expect(typeof result[0]).toBe("string");
  });

  it("parses mixed quoted and unquoted values", () => {
    expect(
      parseValues(
        '"AU: T-De-Esser 2 (Techivation)" "Techivation: T-De-Esser 2" "" 1635083896'
      )
    ).toEqual([
      "AU: T-De-Esser 2 (Techivation)",
      "Techivation: T-De-Esser 2",
      "",
      1635083896,
    ]);
  });

  it("parses AUXRECV line with mixed types", () => {
    expect(parseValues("6 0 1 0 0 0 0 0 0 -1:U 0 -1 ''")).toEqual([
      6, 0, 1, 0, 0, 0, 0, 0, 0, "-1:U", 0, -1, "",
    ]);
  });
});

describe("parseRpp", () => {
  it("parses a minimal RPP file", () => {
    const input = readFixture("minimal.rpp");
    const root = parseRpp(input);

    expect(root.token).toBe("REAPER_PROJECT");
    expect(root.params).toEqual([0.1, "7.55/macOS-arm64", 1772476508, 0]);

    const structs = root.children.filter((c) => c.kind === "struct");
    expect(structs.length).toBeGreaterThanOrEqual(3);
  });

  it("parses a track with FX chain", () => {
    const input = readFixture("single-track-with-fx.rpp");
    const root = parseRpp(input);

    const tracks = root.children.filter(
      (c) => c.kind === "node" && c.token === "TRACK"
    );
    expect(tracks.length).toBe(1);

    const track = tracks[0];
    expect(track.kind).toBe("node");
    if (track.kind !== "node") return;

    // Check track GUID
    expect(track.params[0]).toBe("{66595AAC-8084-8049-8F26-93FAE19A27C6}");

    // Check NAME struct
    const nameStruct = track.children.find(
      (c) => c.kind === "struct" && c.token === "NAME"
    );
    expect(nameStruct).toBeDefined();
    if (nameStruct?.kind === "struct") {
      expect(nameStruct.params[0]).toBe("BJÖRN");
    }

    // Check FXCHAIN
    const fxChain = track.children.find(
      (c) => c.kind === "node" && c.token === "FXCHAIN"
    );
    expect(fxChain).toBeDefined();
    if (fxChain?.kind !== "node") return;

    // Check AU plugin inside FXCHAIN
    const auPlugin = fxChain.children.find(
      (c) => c.kind === "node" && c.token === "AU"
    );
    expect(auPlugin).toBeDefined();
    if (auPlugin?.kind !== "node") return;
    expect(auPlugin.params[0]).toBe("AU: T-De-Esser 2 (Techivation)");

    // Check base64 data inside AU plugin
    const rawLines = auPlugin.children.filter((c) => c.kind === "raw");
    expect(rawLines.length).toBeGreaterThan(0);
  });

  it("parses multiple tracks with routing", () => {
    const input = readFixture("multi-track-with-routing.rpp");
    const root = parseRpp(input);

    const tracks = root.children.filter(
      (c) => c.kind === "node" && c.token === "TRACK"
    );
    expect(tracks.length).toBe(5);

    // Check AUXRECV on the last track (VINBAR)
    const vinbar = tracks[4];
    if (vinbar.kind !== "node") return;
    const auxRecv = vinbar.children.find(
      (c) => c.kind === "struct" && c.token === "AUXRECV"
    );
    expect(auxRecv).toBeDefined();
    if (auxRecv?.kind === "struct") {
      expect(auxRecv.params[0]).toBe(0); // source track index
    }
  });

  it("parses special characters in names and markers", () => {
    const input = readFixture("special-characters.rpp");
    const root = parseRpp(input);

    // Check MARKER with Swedish text
    const marker = root.children.find(
      (c) => c.kind === "struct" && c.token === "MARKER"
    );
    expect(marker).toBeDefined();
    if (marker?.kind === "struct") {
      expect(marker.params[2]).toBe("tape stop på ambiens/ev musik");
    }

    // Check track with multi-word quoted name
    const tracks = root.children.filter(
      (c) => c.kind === "node" && c.token === "TRACK"
    );
    const flicka = tracks[0];
    if (flicka?.kind === "node") {
      const name = flicka.children.find(
        (c) => c.kind === "struct" && c.token === "NAME"
      );
      if (name?.kind === "struct") {
        expect(name.params[0]).toBe("FLICKA MED SOLROS");
      }
    }
  });

  it("parses EXT blocks", () => {
    const input = readFixture("special-characters.rpp");
    const root = parseRpp(input);

    const tracks = root.children.filter(
      (c) => c.kind === "node" && c.token === "TRACK"
    );
    const track = tracks[0];
    if (track?.kind !== "node") return;

    const item = track.children.find(
      (c) => c.kind === "node" && c.token === "ITEM"
    );
    if (item?.kind !== "node") return;

    const ext = item.children.find(
      (c) => c.kind === "node" && c.token === "EXT"
    );
    expect(ext).toBeDefined();
    if (ext?.kind !== "node") return;

    const entry = ext.children.find(
      (c) => c.kind === "struct" && c.token === "nvk_take_source_type_v2"
    );
    expect(entry).toBeDefined();
    if (entry?.kind === "struct") {
      expect(entry.params[0]).toBe("WAVE");
    }
  });

  it("throws on empty input", () => {
    expect(() => parseRpp("")).toThrow(RppParseError);
  });

  it("throws on unclosed block", () => {
    expect(() => parseRpp("<REAPER_PROJECT\n  RIPPLE 0")).toThrow(
      RppParseError
    );
  });

  it("throws on unexpected closing bracket", () => {
    expect(() => parseRpp(">\n")).toThrow(RppParseError);
  });
});
