// A plain object, so this file loads without importing vitest's types. Wrap it in defineConfig
// from "vitest/config" when you want editor hints.
export default {
  test: {
    environment: "node",
    globalSetup: ["./tools/vitest/hermetic-setup.ts"],
  },
};
