// @ts-nocheck
// Fixture for no-class-style-assertions.grit. Lines ending in the flag marker must be reported; the rest must not.
test("disables the button while saving", async () => {
  const button = screen.getByRole("button", { name: "Save" });
  expect(button).toHaveClass("btn-disabled"); // flag
  expect(button).toHaveClass("btn", "btn-primary"); // flag
  expect(button).toHaveStyle({ opacity: 0.5 }); // flag
  await expect(page.getByRole("button")).toHaveCSS("color", "red"); // flag
  expect(button).toHaveAttribute("class", "btn"); // flag
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleName("Save");
  expect(button).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status")).toHaveText("Saving");
});
