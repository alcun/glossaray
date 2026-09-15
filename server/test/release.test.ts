import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

// server/package.json holds the only version, and every release opens the
// changelog with it.
const root = join(import.meta.dir, "..", "..");
const escaped = pkg.version.replaceAll(".", "\\.");

describe("release version", () => {
  test("the changelog opens with this version and a date", () => {
    const heading = readFileSync(join(root, "CHANGELOG.md"), "utf8").match(/^## (.+)$/m)?.[1];
    expect(heading).toMatch(new RegExp(`^\\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`));
  });

  test("no source file types a release version", () => {
    const src = join(root, "server", "src");
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /\b(version|VERSION)['"]?\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/.test(readFileSync(join(src, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
