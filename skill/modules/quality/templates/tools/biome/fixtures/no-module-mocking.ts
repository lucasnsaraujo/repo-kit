// @ts-nocheck
// Fixture for no-module-mocking.grit. Lines ending in the flag marker must be reported; the rest must not.
vi.mock("./billing"); // flag
vi.doMock("../db", () => ({ query: vi.fn() })); // flag
jest.mock("node-fetch"); // flag
mock.module("./clock", () => ({ now: () => 0 })); // flag

test("charges the card", async () => {
  const payments = new FakePayments();
  const send = vi.fn();
  vi.spyOn(console, "error");
  await chargeCard({ payments, send }, 10);
  expect(payments.charges).toEqual([10]);
});
