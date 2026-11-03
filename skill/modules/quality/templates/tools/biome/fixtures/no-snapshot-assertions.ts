// @ts-nocheck
// Fixture for no-snapshot-assertions.grit. Lines ending in the flag marker must be reported; the rest must not.
test("renders the invoice", () => {
  const invoice = renderInvoice({ total: 10 });
  expect(invoice).toMatchSnapshot(); // flag
  expect(invoice.html).toMatchInlineSnapshot(`"<p>10</p>"`); // flag
  expect(() => renderInvoice(null)).toThrowErrorMatchingSnapshot(); // flag
  expect(invoice.total).toBe(10);
  expect(invoice.lines).toEqual([{ amount: 10 }]);
  expect(() => renderInvoice(null)).toThrow("invoice is required");
});
