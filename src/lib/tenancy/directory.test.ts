import { describe, expect, it } from "vitest";
import {
  resolveSelection,
  selectBusiness,
  selectOutlet,
  type TenantDirectory,
} from "@/lib/tenancy/directory";
import { isTenancyError } from "@/lib/tenancy/errors";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const O_A1 = "00000000-0000-4000-8000-000000000a01";
const O_A2 = "00000000-0000-4000-8000-000000000a02";
const O_B1 = "00000000-0000-4000-8000-000000000b01";

function makeDirectory(overrides: Partial<TenantDirectory> = {}): TenantDirectory {
  return {
    userId: "00000000-0000-4000-8000-0000000000ff",
    businesses: [
      { id: A, name: "Tenant A", slug: "tenant-a", role: "owner", status: "active" },
      { id: B, name: "Tenant B", slug: "tenant-b", role: "waiter", status: "active" },
    ],
    outlets: [
      { id: O_A1, businessId: A, name: "A Main", slug: "main", status: "active" },
      { id: O_A2, businessId: A, name: "A Branch", slug: "branch", status: "active" },
      { id: O_B1, businessId: B, name: "B Main", slug: "main", status: "active" },
    ],
    // Owner of A → both A outlets; waiter in B with one grant.
    accessibleOutletIds: [O_A1, O_A2, O_B1],
    ...overrides,
  };
}

describe("selectBusiness", () => {
  it("resolves an explicit active membership", () => {
    expect(selectBusiness(makeDirectory(), A).slug).toBe("tenant-a");
  });

  it("falls back to the only active membership when omitted", () => {
    const directory = makeDirectory({
      businesses: [{ id: A, name: "Tenant A", slug: "tenant-a", role: "owner", status: "active" }],
    });
    expect(selectBusiness(directory).id).toBe(A);
  });

  it("rejects a suspended business like an unknown one (no tenant probing)", () => {
    const directory = makeDirectory({
      businesses: [{ id: A, name: "Tenant A", slug: "tenant-a", role: "owner", status: "suspended" }],
    });
    expect(() => selectBusiness(directory, A)).toThrow(/not found or not active/);
  });

  it("demands an explicit choice across multiple memberships", () => {
    try {
      selectBusiness(makeDirectory());
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("ambiguous-business");
    }
  });

  it("reports no-membership for an empty directory", () => {
    try {
      selectBusiness(makeDirectory({ businesses: [] }));
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("no-membership");
    }
  });
});

describe("selectOutlet", () => {
  const directory = makeDirectory();
  const business = selectBusiness(directory, A);

  it("resolves an accessible outlet", () => {
    expect(selectOutlet(directory, business, O_A1).slug).toBe("main");
  });

  it("auto-selects when exactly one outlet is accessible", () => {
    const single = makeDirectory({ accessibleOutletIds: [O_A1] });
    expect(selectOutlet(single, selectBusiness(single, A)).id).toBe(O_A1);
  });

  it("demands an explicit outlet when several are accessible", () => {
    try {
      selectOutlet(directory, business);
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("ambiguous-outlet");
    }
  });

  it("rejects outlets that belong to another business", () => {
    try {
      selectOutlet(directory, business, O_B1);
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("unknown-outlet");
    }
  });

  it("rejects visible-but-not-accessible outlets", () => {
    const restricted = makeDirectory({ accessibleOutletIds: [O_A1] });
    try {
      selectOutlet(restricted, selectBusiness(restricted, A), O_A2);
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("outlet-not-accessible");
    }
  });

  it("rejects inactive outlets", () => {
    const closed = makeDirectory({
      outlets: [
        { id: O_A1, businessId: A, name: "A Main", slug: "main", status: "closed" },
      ],
    });
    try {
      selectOutlet(closed, selectBusiness(closed, A), O_A1);
      expect.unreachable();
    } catch (error) {
      expect(isTenancyError(error) && error.code).toBe("unknown-outlet");
    }
  });
});

describe("resolveSelection", () => {
  it("validates a full client selection end to end", () => {
    const resolved = resolveSelection(makeDirectory(), { businessId: A, outletId: O_A1 });
    expect(resolved.business.id).toBe(A);
    expect(resolved.outlet.id).toBe(O_A1);
  });

  it("never resolves ids outside the caller's directory", () => {
    const outsider = makeDirectory({
      businesses: [{ id: A, name: "Tenant A", slug: "tenant-a", role: "waiter", status: "active" }],
      outlets: [{ id: O_A1, businessId: A, name: "A Main", slug: "main", status: "active" }],
      accessibleOutletIds: [],
    });
    expect(() => resolveSelection(outsider, { businessId: B, outletId: O_B1 })).toThrow();
    expect(() => resolveSelection(outsider, { businessId: A, outletId: O_A1 })).toThrow(/access/);
  });
});
