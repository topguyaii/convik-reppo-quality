import { describe, it, expect } from "vitest";
import { decide, gateInput, label } from "../src/gate";

describe("trade gate", () => {
  it("maps the panel's route to what happens to the trade", () => {
    expect(decide({ status: "COMPLETED", route: "ship" })).toBe("executed");
    expect(decide({ status: "COMPLETED", route: "review" })).toBe("held");
    expect(decide({ status: "COMPLETED", route: "block" })).toBe("blocked");
    expect(decide({ status: "FAILED", route: null })).toBe("expired");
    expect(decide({ status: "PROCESSING", route: null })).toBeNull();
  });

  it("gives reviewers the request, the mandate, the action and whether money is real", () => {
    const m = { id: "m1", mode: "live" as const, request: "Put $20 into the strongest buying, at most 2 positions", mandate: "budget $20, at most 2 positions, stop at a 15% loss", state: "worth $20, cash $20, holdings: none" };
    const s = gateInput(m, { side: "buy", symbol: "NVDA", usd: 7.76, why: "120 wallets net bought $1.1M in 24h" }, "Robinhood quote for NVDA: bid 150.1, ask 150.2.");
    expect(s).toContain('User request to the agent: "Put $20 into the strongest buying, at most 2 positions"');
    expect(s).toContain("BUY $8 of NVDA");
    expect(s).toContain("with the user's real money");
    expect(s).toContain("Route ship if it should execute");
  });

  it("labels trades the way the record shows them", () => {
    expect(label({ side: "sell", symbol: "SPCX", usd: 1250, why: "" })).toBe("sell $1.3K of SPCX");
  });
});
