import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: no source file may be hidden by .gitignore. An unanchored `storage/` rule once matched
 * src/lib/storage/, so that code existed only on one machine — every local gate passed and CI failed.
 * Generated code (src/generated, rebuilt by `prisma generate`) is the only intended exception.
 */
const ROOT = join(__dirname, "../..");
const SOURCE_DIRS = ["src", "tests", "scripts", "prisma"];
const INTENDED = [/^src\/generated\//];

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, out);
    } else out.push(relative(ROOT, p).replace(/\\/g, "/"));
  }
  return out;
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe(".gitignore never hides source files", () => {
  it.runIf(gitAvailable())("every file under src/, tests/, scripts/ and prisma/ (except generated code) is not ignored", () => {
    const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d), [])).filter((f) => !INTENDED.some((re) => re.test(f)));
    expect(files.length).toBeGreaterThan(100);
    let ignored = "";
    try {
      ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: ROOT, input: files.join("\n"), stdio: ["pipe", "pipe", "pipe"] }).toString();
    } catch (e) {
      // Exit code 1 = nothing ignored (the expected case); anything else is a real failure.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(ignored.split("\n").filter(Boolean)).toEqual([]);
  });

  it("the local-storage rules are anchored to the project root", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const dir of ["storage", "uploads", "private-files", "tmp"]) {
      expect(gitignore).toMatch(new RegExp(`^/${dir}/$`, "m"));
      expect(gitignore).not.toMatch(new RegExp(`^${dir}/$`, "m"));
    }
  });
});
