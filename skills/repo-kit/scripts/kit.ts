#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { adopt, check, execute, LOCK_FILE, plan, readLock, remove } from "./lib/apply.ts";
import { detect } from "./lib/detect.ts";
import { loadModules } from "./lib/modules.ts";

const USAGE = `Usage: kit.ts <command> [options]

Commands:
  modules                      List the modules this kit ships.
  detect                       Print the project's stack and the recorded selection as JSON.
  plan --modules <ids|all>     Print what apply would do. Writes nothing.
  apply --modules <ids|all>    Write files, merge package.json and .gitignore, update ${LOCK_FILE}.
  check                        List managed files that are missing, edited, or outdated. Exits 1 on drift.
  adopt <path...>              Mark files as project-owned; later runs propose changes in *.repo-kit-new.
  remove <module>              Delete the module's untouched files and drop it from ${LOCK_FILE}.

Options:
  --root <dir>                 Project root (default: current directory).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string", default: "." }, modules: { type: "string" }, help: { type: "boolean" } },
});

const [command, ...rest] = positionals;
const root = resolve(values.root);
const modules = loadModules(resolve(import.meta.dirname, "../modules"));
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function requestedModules(): string[] {
  if (!values.modules) {
    console.error("--modules is required (comma-separated ids, or all)");
    process.exit(2);
  }
  return values.modules === "all" ? [...modules.keys()] : values.modules.split(",").map((id) => id.trim());
}

/** Plans carry full file contents; the summary keeps the output readable. */
function summarize(result: ReturnType<typeof plan>) {
  return {
    ...result,
    actions: result.actions.map((action) => {
      if (!("content" in action)) return action;
      const { content: _content, ...rest } = action;
      return rest;
    }),
  };
}

switch (command) {
  case "modules":
    print([...modules.values()].map(({ id, summary, requires }) => ({ id, summary, requires })));
    break;
  case "detect":
    print({ ...detect(root), lock: readLock(root) });
    break;
  case "plan":
    print(summarize(plan({ root, detection: detect(root), modules, requested: requestedModules() })));
    break;
  case "apply": {
    const result = plan({ root, detection: detect(root), modules, requested: requestedModules() });
    execute(root, result);
    print(summarize(result));
    break;
  }
  case "check": {
    const drift = check({ root, detection: detect(root), modules });
    print(drift);
    if (drift.length > 0) process.exit(1);
    break;
  }
  case "adopt":
    adopt(root, rest, modules);
    print({ adopted: rest });
    break;
  case "remove": {
    const [id] = rest;
    if (!id) {
      console.error("remove needs a module id");
      process.exit(2);
    }
    print(remove(root, id, modules));
    break;
  }
  default:
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
}
