# env

## Sets up

- `.gitignore` gets `.env.keys`: the private keys never reach git.
- `.worktreeinclude` gets `.env.keys`: tools that create worktrees (Claude Code, T3 Code) copy the keys into each new worktree.
- `env:encrypt` script: `dotenvx encrypt -f .env.dev -f .env.production -fk .env.keys`, run after editing either file by hand. It encrypts only values that are still plain text.
- `@dotenvx/dotenvx` as a dev dependency.
- The Tailor step adds the rest: the two encrypted env files, the dev script wrapper, and a typed loader.

`<pm-exec>` below is `bunx` in a bun project and `pnpm exec` in a pnpm one.

The shape: settings live in two committed, encrypted files, `.env.dev` and `.env.production`. The root `.env.keys` holds `DOTENV_PRIVATE_KEY_DEV` and `DOTENV_PRIVATE_KEY_PRODUCTION`, the only keys the project has. Development runs without any key, on safe defaults. CI and production get `DOTENV_PRIVATE_KEY_PRODUCTION` from a secret.

## Tailor

1. **Inventory the settings.** List every variable the code reads (`grep -rn "process.env\.\|import.meta.env\.\|Bun.env\." --include=*.ts --include=*.tsx . | grep -v node_modules`) and every existing env file (`ls -a | grep "^\.env"`). For each variable, decide: secret or not, needed in dev or only in production, and the safe dev default (a local URL, a generated value, a feature switched off). Done when every variable read by the code appears in your list with those three answers.
2. **Write the two files, then encrypt them with one keys file.** Put the dev values in `.env.dev` and the production values in `.env.production`. Production credentials never go in `.env.dev`. Then run:

   ```sh
   <pm-exec> dotenvx encrypt -f .env.dev -fk .env.keys
   <pm-exec> dotenvx encrypt -f .env.production -fk .env.keys
   ```

   Pass `-fk .env.keys` (the root file) every time, so dotenvx reuses the existing key instead of writing a new one. When the old setup had `.env`, `.env.local`, or `.env.example`, move their settings into the two files and delete the old files; an extra env file is one more place for a secret to leak. Keep any production secret you cannot see out of `.env.production` and list it for the owner. Done when `ls -a | grep "^\.env"` prints `.env.dev`, `.env.keys`, `.env.production` (plus `.env.example` only if a doc tool needs it), and `grep -c "^DOTENV_PRIVATE_KEY_" .env.keys` prints `2`.
3. **Wire the dev script.** Prefix the command of the `dev` script (and other local scripts that need settings) with `dotenvx run -f .env.dev -fk .env.keys --`. Example: `"dev": "dotenvx run -f .env.dev -fk .env.keys -- vite"`. Production start scripts use `dotenvx run --strict -f .env.production --`: `--strict` exits non-zero when the key is missing. Done when `<pm> run dev` starts with `.env.keys` moved away (step 5 of Verify).
4. **Add the typed loader at the app boundary.** Without the key, dotenvx still injects each encrypted value as the literal text `encrypted:...`. The loader treats that text as unset, falls back to dev defaults outside production, and validates everything with zod once, at startup. Place it where the app starts (for example `src/env.ts`), add `zod` as a dependency if the project has none, and replace every direct `process.env` read with the exported `env`:

   ```ts
   import { z } from "zod";

   const schema = z.object({
     PORT: z.coerce.number().int().positive(),
     DATABASE_URL: z.url(),
     STRIPE_SECRET_KEY: z.string().min(1),
   });
   type Name = keyof typeof schema.shape;

   /** Used only outside production, when the value is unset or still encrypted (no private key). */
   const devDefaults: Record<Name, string> = {
     PORT: "3000",
     DATABASE_URL: "postgres://localhost:5432/app_dev",
     STRIPE_SECRET_KEY: "sk_test_placeholder",
   };

   const isProduction = process.env.NODE_ENV === "production";

   function readSetting(name: Name): string | undefined {
     const value = process.env[name];
     const usable = value === undefined || value.startsWith("encrypted:") ? undefined : value;
     return usable ?? (isProduction ? undefined : devDefaults[name]);
   }

   const names: readonly Name[] = schema.keyof().options;
   const parsed = schema.safeParse(Object.fromEntries(names.map((name) => [name, readSetting(name)])));
   if (!parsed.success) {
     const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
     throw new Error(`Invalid environment settings: ${fields}. See .env.${isProduction ? "production" : "dev"}.`);
   }

   export const env = parsed.data;
   ```

   Keep one entry per variable from step 1. The error names fields, never values. The snippet targets zod 4; on zod 3, write `z.string().url()` for `z.url()`. For a browser bundle, validate only the public variables the bundler exposes, in a separate client loader. Done when `grep -rn "process.env\." --include=*.ts --include=*.tsx . | grep -v node_modules` lists only the loader (and build config files), and the app starts in dev with no `.env.keys`.
5. **Give CI the production key.** In each workflow job that needs production settings, expose the secret and run through dotenvx:

   ```yaml
   env:
     DOTENV_PRIVATE_KEY_PRODUCTION: ${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}
   run: <pm-exec> dotenvx run --strict -f .env.production -- <pm> run build
   ```

   Jobs that only lint or test run on dev defaults and get no key. Done when every workflow job that reads `.env.production` lists the secret and nothing else references `.env.keys`.
6. **Document it.** When `agent-docs` is selected, fill the loader path in the "Environment settings" section of `AGENTS.md`. Done when that section names the loader file.

## Owner steps

- Store the production key as a repository secret. This reads it from the local `.env.keys` without printing it:

  ```sh
  sed -n 's/^DOTENV_PRIVATE_KEY_PRODUCTION=//p' .env.keys | tr -d '"' | gh secret set DOTENV_PRIVATE_KEY_PRODUCTION
  ```

- Share `.env.keys` with each developer through a password manager, never through git or chat. For a deploy target (Vercel, Fly, Railway, a server), set `DOTENV_PRIVATE_KEY_PRODUCTION` in its secret store, the same way.
- Add any production secret the agent could not see: `<pm-exec> dotenvx set <NAME> <value> -f .env.production -fk .env.keys`, then commit `.env.production`.

## Verify

- `git check-ignore -v .env.keys` prints the `.gitignore` line, and `git ls-files .env.keys` prints nothing.
- Every value in both files is encrypted: `grep -hvE '^\s*(#|$)|^DOTENV_PUBLIC_KEY' .env.dev .env.production | grep -v '="\?encrypted:'` prints nothing.
- `grep -c "^DOTENV_PRIVATE_KEY_" .env.keys` prints `2`, and `grep -c "^DOTENV_PUBLIC_KEY_" .env.dev .env.production` prints `1` for each.
- With the key: `<pm-exec> dotenvx run -f .env.dev -fk .env.keys -- node -e "console.log(Object.keys(process.env).length)"` exits 0.
- Without the key: `mv .env.keys /tmp/keys.bak && <pm> run dev`. The app starts on dev defaults (dotenvx prints `MISSING_PRIVATE_KEY` warnings; that is expected). Then `mv /tmp/keys.bak .env.keys`.
- `gh secret list | grep DOTENV_PRIVATE_KEY_PRODUCTION` prints one line after the owner step.

## Prior art

- Two committed encrypted files, one root `.env.keys`, `-fk` to stop dotenvx from making new key pairs, dev runs without a key, no `.env.local` or other extra files: openbot `AGENTS.md`, "Account service environment settings".
- `.env.keys` in `.worktreeinclude`: openbot `.worktreeinclude` copies `remote/.env.keys` and local state into new worktrees.
- `--strict` for production and the `encrypted:` passthrough without a key: checked against dotenvx 1.75.1 (`dotenvx run` exits 0 and injects the ciphertext when the key is missing; `--strict` exits 1).
- zod validation at the boundary: no studied repo validates env this way (openbot uses Effect schemas elsewhere). Added because a typo in a variable name otherwise surfaces as `undefined` deep inside a request.
