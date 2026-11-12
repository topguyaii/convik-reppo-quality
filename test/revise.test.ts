import { describe, it, expect } from "vitest";
import { tidyAnswer } from "../src/revise";

const W = "0x" + "ab".repeat(20);
const H = "0x" + "cd".repeat(32);

describe("tidyAnswer", () => {
  it("turns bare and linked addresses and hashes into citations", () => {
    expect(tidyAnswer(`Wallet ${W} bought; tx ${H}.`)).toBe(`Wallet [wallet:${W}] bought; tx [tx:${H}].`);
    expect(tidyAnswer(`\`${W}\` via [${H}](https://x.example/tx/${H})`)).toBe(`[wallet:${W}] via [tx:${H}]`);
  });
  it("keeps existing citations and unwraps doubled brackets", () => {
    expect(tidyAnswer(`an AI bull [wallet:${W}] in [tx:${H}]`)).toBe(`an AI bull [wallet:${W}] in [tx:${H}]`);
    expect(tidyAnswer(`Bought +$500K. [[tx:${H}]]`)).toBe(`Bought +$500K. [tx:${H}]`);
  });
  it("drops tool names cited as sources", () => {
    expect(tidyAnswer("Net +$14K [stock_flow:USAR] in an hour.")).toBe("Net +$14K in an hour.");
    expect(tidyAnswer("Spread is -0.01% [dex_market]")).toBe("Spread is -0.01%");
  });
});
