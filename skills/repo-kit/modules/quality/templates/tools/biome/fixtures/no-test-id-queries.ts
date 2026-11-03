// @ts-nocheck
// Fixture for no-test-id-queries.grit. Lines ending in the flag marker must be reported; the rest must not.
test("submits the form", async () => {
  const { getByTestId } = render(Form());
  screen.getByTestId("submit"); // flag
  getByTestId("email"); // flag
  await screen.findAllByTestId("row"); // flag
  container.querySelector('[data-testid="total"]'); // flag
  page.locator(`[data-testid=${id}]`); // flag
  screen.getByRole("button", { name: "Submit" });
  screen.getByLabelText("Email");
  await screen.findByText("Saved");
  page.getByRole("row");
});
