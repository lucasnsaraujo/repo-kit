export type TemplateVars = Record<string, string | boolean>;

const BLOCK_TAG = /^\s*\{%(if (!?)([\w:-]+)|else|endif)%\}\s*$/;
const INLINE_TAG = /\{%([\w:-]+)%\}/g;

type Frame = { parentActive: boolean; condition: boolean; inElse: boolean };

function isActive(stack: Frame[]): boolean {
  const top = stack.at(-1);
  if (!top) return true;
  return top.parentActive && (top.inElse ? !top.condition : top.condition);
}

/**
 * Renders `{%name%}` substitutions and line-level `{%if cond%}` / `{%else%}` / `{%endif%}` blocks.
 * The `{% %}` delimiters were picked because GitHub Actions (`${{ }}`) and Bash (`[[ ]]`) use neither.
 */
export function renderTemplate(source: string, vars: TemplateVars): string {
  const stack: Frame[] = [];
  const out: string[] = [];

  for (const line of source.split("\n")) {
    const tag = BLOCK_TAG.exec(line);
    if (tag) {
      const [, keyword, negation, name] = tag;
      if (keyword === "else") {
        const top = stack.at(-1);
        if (!top) throw new Error("{%else%} without {%if%}");
        top.inElse = true;
      } else if (keyword === "endif") {
        if (!stack.pop()) throw new Error("{%endif%} without {%if%}");
      } else {
        const value = vars[name ?? ""] === true || (typeof vars[name ?? ""] === "string" && vars[name ?? ""] !== "");
        stack.push({ parentActive: isActive(stack), condition: negation ? !value : value, inElse: false });
      }
      continue;
    }
    if (!isActive(stack)) continue;
    out.push(
      line.replace(INLINE_TAG, (_, name: string) => {
        const value = vars[name];
        if (typeof value !== "string") throw new Error(`unknown template variable: ${name}`);
        return value;
      }),
    );
  }

  if (stack.length > 0) throw new Error("unclosed {%if%}");
  return out.join("\n");
}
