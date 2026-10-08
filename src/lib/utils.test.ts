import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges conditional class names", () => {
    expect(cn("px-2", false && "hidden", "py-1")).toBe("px-2 py-1");
  });

  it("resolves Tailwind conflicts with last-wins semantics", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("handles undefined and empty inputs", () => {
    expect(cn(undefined, "", "text-sm")).toBe("text-sm");
  });
});
