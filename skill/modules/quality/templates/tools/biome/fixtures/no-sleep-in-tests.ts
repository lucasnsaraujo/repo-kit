// @ts-nocheck
// Fixture for no-sleep-in-tests.grit. Lines ending in the flag marker must be reported; the rest must not.
import { setTimeout } from "node:timers/promises";

test("shows the toast", async () => {
  await new Promise((resolve) => setTimeout(resolve, 200)); // flag
  await new Promise((resolve) => { // flag
    setTimeout(resolve, 50);
  });
  await setTimeout(100); // flag
  await sleep(100); // flag
  await Bun.sleep(10); // flag
  await page.waitForTimeout(500); // flag
  await vi.waitFor(() => expect(toast()).toBeVisible());
  await expect.poll(() => readStatus()).toBe("done");
  await page.getByText("Saved").waitFor();
  const fake = new FakeClock();
  fake.advance(100);
});
