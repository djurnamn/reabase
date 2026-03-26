#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { compute } from "./commands/compute.js";
import { planSync, executeSync } from "./commands/sync.js";
import { inspectTrack, applyChunk, setPreset, snapshotTrack, savePreset, deletePreset, revertPlugin, updatePresets, unlinkOverride, linkAsOverride } from "./commands/bridge.js";
import { loadPresets } from "./preset/loader.js";
import { findReabaseRoot } from "./utilities/discovery.js";
import type { ComputeInput } from "./commands/compute.js";
import type { ApplyChunkInput, SetPresetInput, SnapshotInput, SavePresetInput, DeletePresetInput, RevertPluginInput, UpdatePresetsInput, UnlinkOverrideInput, LinkAsOverrideInput } from "./commands/bridge.js";

const program = new Command()
  .name("reabase")
  .description(
    "Manage REAPER FX chains as reusable, updatable dependencies across projects"
  )
  .version("0.1.0");

// ─── init ───────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize a .reabase/ directory")
  .argument("[path]", "directory to initialize in", ".")
  .action((path: string) => {
    try {
      const { reabasePath } = init(path);
      console.log(`Initialized reabase at ${reabasePath}`);
      console.log("  presets/    — preset definitions and FX chain files");
      console.log("  snapshots/  — track state snapshots");
      console.log("  config.yaml — project configuration");
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// ─── status ─────────────────────────────────────────────────────

program
  .command("status")
  .description("Show the sync status of all managed tracks")
  .option("-p, --path <path>", "path to search from", ".")
  .action((options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        "Error: No .reabase/ directory found. Run 'reabase init' first."
      );
      process.exit(1);
    }

    try {
      const result = status(reabasePath);

      if (result.tracks.length === 0) {
        console.log("No managed tracks found.");
        console.log(
          "Assign presets to tracks using the REAPER dialog or by adding reabase_preset ext state."
        );
        return;
      }

      // Group by project
      const byProject = new Map<string, typeof result.tracks>();
      for (const track of result.tracks) {
        const existing = byProject.get(track.projectPath) ?? [];
        existing.push(track);
        byProject.set(track.projectPath, existing);
      }

      for (const [projectPath, tracks] of byProject) {
        console.log(`\n${projectPath}`);
        for (const track of tracks) {
          const statusIcon = getStatusIcon(track.status);
          const details = [];
          if (track.localChanges > 0)
            details.push(`${track.localChanges} local`);
          if (track.upstreamChanges > 0)
            details.push(`${track.upstreamChanges} upstream`);
          const detailStr =
            details.length > 0 ? ` (${details.join(", ")})` : "";
          console.log(
            `  ${statusIcon} ${track.trackName} [${track.preset}]${detailStr}`
          );
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// ─── compute ────────────────────────────────────────────────────

program
  .command("compute")
  .description("Compute a three-way merge (reads JSON from stdin, writes result to stdout)")
  .action(async () => {
    try {
      const inputJson = await readStdin();
      const input: ComputeInput = JSON.parse(inputJson);

      const result = compute(input);

      console.log(JSON.stringify(result));
      process.exit(result.merge.hasConflicts ? 1 : 0);
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── sync ───────────────────────────────────────────────────────

program
  .command("sync")
  .description("Sync preset changes to all managed tracks across projects")
  .option("-p, --path <path>", "path to search from", ".")
  .option("--dry-run", "show what would change without applying")
  .option("-y, --yes", "skip confirmation prompt")
  .action(
    async (options: { path: string; dryRun?: boolean; yes?: boolean }) => {
      const reabasePath = findReabaseRoot(options.path);
      if (!reabasePath) {
        console.error(
          "Error: No .reabase/ directory found. Run 'reabase init' first."
        );
        process.exit(1);
      }

      try {
        const plans = planSync(reabasePath);

        if (plans.length === 0) {
          console.log("Everything is up to date.");
          return;
        }

        // Show plan
        console.log("Sync plan:\n");
        for (const plan of plans) {
          console.log(`  ${plan.projectPath}`);
          for (const action of plan.trackActions) {
            const conflictMark = action.merge.hasConflicts ? " [CONFLICT]" : "";
            const actionSummary = summarizeMerge(action.merge);
            console.log(
              `    ${action.trackName} [${action.preset}]: ${actionSummary}${conflictMark}`
            );
          }
        }

        if (options.dryRun) {
          console.log("\n(dry run — no changes applied)");
          return;
        }

        // Confirm
        if (!options.yes) {
          const confirmed = await confirm("\nApply these changes?");
          if (!confirmed) {
            console.log("Aborted.");
            return;
          }
        }

        // Execute
        const result = executeSync(reabasePath, plans);

        if (result.errors.length > 0) {
          console.log("\nErrors:");
          for (const error of result.errors) {
            console.log(`  ${error}`);
          }
        }

        if (result.applied) {
          console.log("\nSync complete.");
        } else {
          console.log("\nSync completed with errors.");
          process.exit(1);
        }
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exit(1);
      }
    }
  );

// ─── presets ─────────────────────────────────────────────────────

program
  .command("presets")
  .description("List available presets")
  .option("-p, --path <path>", "path to search from", ".")
  .option("--json", "output as JSON")
  .action((options: { path: string; json?: boolean }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        "Error: No .reabase/ directory found. Run 'reabase init' first."
      );
      process.exit(1);
    }

    try {
      const presets = loadPresets(reabasePath + "/presets");

      if (options.json) {
        const list = [...presets.values()].map((p) => ({
          name: p.name,
          description: p.description,
          extends: p.extends,
          fxChainFile: p.fxChainFile,
        }));
        console.log(JSON.stringify(list));
        return;
      }

      if (presets.size === 0) {
        console.log("No presets defined.");
        console.log(
          "Add .yaml files to .reabase/presets/ to define presets."
        );
        return;
      }

      for (const [, preset] of presets) {
        const extendsStr = preset.extends
          ? ` (extends ${preset.extends})`
          : "";
        console.log(`  ${preset.name}${extendsStr}`);
        if (preset.description) {
          console.log(`    ${preset.description}`);
        }
      }
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// ─── inspect ─────────────────────────────────────────────────────

program
  .command("inspect")
  .description("Inspect a track chunk from REAPER (reads track chunk from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputRaw = await readStdin();
      // Accept both JSON (with fxParameters) and raw track chunk (legacy)
      let trackChunk: string;
      let fxParameters: Record<string, import("./snapshot/types.js").ParameterValue>[] | undefined;
      try {
        const parsed = JSON.parse(inputRaw);
        if (parsed && typeof parsed === "object" && "trackChunk" in parsed) {
          trackChunk = parsed.trackChunk;
          fxParameters = parsed.fxParameters;
        } else {
          trackChunk = inputRaw.trim();
        }
      } catch {
        trackChunk = inputRaw.trim();
      }
      const result = inspectTrack(trackChunk, reabasePath, fxParameters);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── apply-chunk ─────────────────────────────────────────────────

program
  .command("apply-chunk")
  .description("Apply a resolved FX chain to a track chunk (reads JSON from stdin, writes JSON to stdout)")
  .action(async () => {
    try {
      const inputJson = await readStdin();
      const input: ApplyChunkInput = JSON.parse(inputJson);
      const result = applyChunk(input);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── set-preset ──────────────────────────────────────────────────

program
  .command("set-preset")
  .description("Set the reabase preset on a track chunk (reads JSON from stdin, writes JSON to stdout)")
  .action(async () => {
    try {
      const inputJson = await readStdin();
      const input: SetPresetInput = JSON.parse(inputJson);
      const result = setPreset(input);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── snapshot ────────────────────────────────────────────────────

program
  .command("snapshot")
  .description("Snapshot the current FX chain state of a track (reads JSON from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input = JSON.parse(inputJson) as SnapshotInput;
      const result = snapshotTrack(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── save-preset ─────────────────────────────────────────────────

program
  .command("save-preset")
  .description("Create a new preset from a track's FX chain (reads JSON from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: SavePresetInput = JSON.parse(inputJson);
      const result = savePreset(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── delete-preset ──────────────────────────────────────────────

program
  .command("delete-preset")
  .description("Delete a preset (reads JSON from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: DeletePresetInput = JSON.parse(inputJson);
      const result = deletePreset(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── update-presets ─────────────────────────────────────────────

program
  .command("update-presets")
  .description("Update preset files from track's current state (reads JSON from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: UpdatePresetsInput = JSON.parse(inputJson);
      const result = updatePresets(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── revert-plugin ──────────────────────────────────────────────

program
  .command("revert-plugin")
  .description("Revert a single plugin's state to preset (reads JSON from stdin, writes JSON to stdout)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: RevertPluginInput = JSON.parse(inputJson);
      const result = revertPlugin(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── unlink-override ─────────────────────────────────────────────

program
  .command("unlink-override")
  .description("Convert a child override into a separate addition (reads JSON from stdin)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: UnlinkOverrideInput = JSON.parse(inputJson);
      const result = unlinkOverride(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── link-as-override ────────────────────────────────────────────

program
  .command("link-as-override")
  .description("Convert a child addition into an override of a parent slot (reads JSON from stdin)")
  .option("-p, --path <path>", "path to search from", ".")
  .action(async (options: { path: string }) => {
    const reabasePath = findReabaseRoot(options.path);
    if (!reabasePath) {
      console.error(
        JSON.stringify({ error: "No .reabase/ directory found" })
      );
      process.exit(1);
    }

    try {
      const inputJson = await readStdin();
      const input: LinkAsOverrideInput = JSON.parse(inputJson);
      const result = linkAsOverride(input, reabasePath);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        JSON.stringify({ error: (error as Error).message })
      );
      process.exit(2);
    }
  });

// ─── Helpers ────────────────────────────────────────────────────

function getStatusIcon(
  status: string
): string {
  switch (status) {
    case "up-to-date":
      return "ok";
    case "modified":
      return "M ";
    case "upstream-changes":
      return "U ";
    case "conflict":
      return "C ";
    case "no-snapshot":
      return "? ";
    case "unresolvable-preset":
      return "! ";
    default:
      return "  ";
  }
}

function summarizeMerge(
  merge: import("./merge/types.js").MergeResult
): string {
  const counts = { updated: 0, added: 0, removed: 0, conflicts: 0 };
  for (const action of merge.actions) {
    switch (action.type) {
      case "use_new_base":
        counts.updated++;
        break;
      case "add_base":
        counts.added++;
        break;
      case "remove":
        counts.removed++;
        break;
      case "conflict":
        counts.conflicts++;
        break;
    }
  }

  const parts: string[] = [];
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (counts.conflicts > 0) parts.push(`${counts.conflicts} conflicts`);

  return parts.length > 0 ? parts.join(", ") : "no changes";
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${message} [y/N] `);
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim().toLowerCase() === "y");
    });
  });
}

program.parse();
