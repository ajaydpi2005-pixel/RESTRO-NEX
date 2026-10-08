import { describe, expect, it } from "vitest";
import { appModules, appNavGroups, getModule, getModuleByPath } from "@/config/modules";

describe("roadmap module registry", () => {
  it("defines every application module with a unique path", () => {
    const paths = appModules.map((m) => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("requires title, description, phase and planned capabilities for every module", () => {
    for (const mod of appModules) {
      expect(mod.title).toBeTruthy();
      expect(mod.description).toBeTruthy();
      expect(mod.phase).toBeGreaterThanOrEqual(0);
      expect(mod.phaseName).toBeTruthy();
      expect(mod.planned.length).toBeGreaterThan(0);
    }
  });

  it("only references known modules in sidebar groups, with no duplicates", () => {
    const known = new Set(appModules.map((m) => m.path));
    const seen = new Set<string>();
    for (const group of appNavGroups) {
      for (const path of group.paths) {
        expect(known.has(path)).toBe(true);
        expect(seen.has(path)).toBe(false);
        seen.add(path);
      }
    }
    // Every module must be reachable from the sidebar.
    expect(seen.size).toBe(known.size);
  });

  it("resolves modules by pathname prefix", () => {
    expect(getModuleByPath("/pos")?.title).toBe("POS");
    expect(getModuleByPath("/nonexistent")).toBeUndefined();
  });

  it("throws for unknown modules via the strict accessor", () => {
    expect(() => getModule("/wrong" as never)).toThrow();
  });
});
