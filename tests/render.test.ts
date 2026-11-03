import { describe, expect, test } from "bun:test";
import { renderTemplate } from "../skill/scripts/lib/render.ts";

const vars = { pm: "bun", pmRun: "bun run", bun: true, pnpm: false, "module:quality": true };

describe("renderTemplate", () => {
  test("substitutes variables and leaves GitHub expressions alone", () => {
    const githubExpression = ["$", "{{ github.event_name }}"].join("");
    const out = renderTemplate(`run: {%pmRun%} lint\nif: ${githubExpression}\n[[ -n $x ]]`, vars);
    expect(out).toBe(`run: bun run lint\nif: ${githubExpression}\n[[ -n $x ]]`);
  });

  test("keeps the branch whose condition holds and drops the tag lines", () => {
    const source = "a\n{%if bun%}\nbun only\n{%else%}\nnot bun\n{%endif%}\nz";
    expect(renderTemplate(source, vars)).toBe("a\nbun only\nz");
  });

  test("supports negation and nested blocks", () => {
    const source = "{%if !pnpm%}\nouter\n  {%if module:quality%}\n  inner\n  {%endif%}\n{%endif%}";
    expect(renderTemplate(source, vars)).toBe("outer\n  inner");
  });

  test("treats an unknown condition as false", () => {
    expect(renderTemplate("{%if module:env%}\nx\n{%endif%}\ny", vars)).toBe("y");
  });

  test("fails on an unknown variable instead of writing an empty string", () => {
    expect(() => renderTemplate("{%nope%}", vars)).toThrow("unknown template variable: nope");
  });

  test("fails on an unclosed block", () => {
    expect(() => renderTemplate("{%if bun%}\nx", vars)).toThrow("unclosed {%if%}");
  });
});
