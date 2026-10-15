import { describe, expect, it } from "vitest";
import { openTicketSchema, tenantReplySchema } from "./schemas";

const BIZ = "cccccccc-0000-4000-8000-000000000001";
const TICKET = "dddddddd-0000-4000-8000-000000000002";

describe("tenant support schemas", () => {
  it("needs a subject of at least 3 characters and a message", () => {
    expect(
      openTicketSchema.safeParse({ businessId: BIZ, subject: "Hi", body: "Printer" }).success,
    ).toBe(false);
    expect(
      openTicketSchema.safeParse({ businessId: BIZ, subject: "Printer offline", body: "" }).success,
    ).toBe(false);
    expect(
      openTicketSchema.safeParse({ businessId: BIZ, subject: "Printer offline", body: "Since 9am" })
        .success,
    ).toBe(true);
  });

  it("caps the subject and message length", () => {
    expect(
      openTicketSchema.safeParse({ businessId: BIZ, subject: "x".repeat(121), body: "a" }).success,
    ).toBe(false);
    expect(
      openTicketSchema.safeParse({ businessId: BIZ, subject: "Valid", body: "x".repeat(4001) })
        .success,
    ).toBe(false);
  });

  it("rejects a business id that is not a UUID", () => {
    expect(
      openTicketSchema.safeParse({ businessId: "1", subject: "Valid", body: "Hi" }).success,
    ).toBe(false);
  });

  it("accepts a tenant reply with both ids", () => {
    expect(
      tenantReplySchema.safeParse({ businessId: BIZ, ticketId: TICKET, body: "Thanks" }).success,
    ).toBe(true);
    expect(
      tenantReplySchema.safeParse({ businessId: BIZ, ticketId: "x", body: "Thanks" }).success,
    ).toBe(false);
  });
});
