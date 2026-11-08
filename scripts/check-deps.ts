/**
 * Architecture check: `npm run check:deps`
 *  1. Circular imports anywhere in src/ (excluding the generated Prisma client).
 *  2. Layer boundaries (docs/SYSTEM_ARCHITECTURE.md §3):
 *       lib/**        → may not import modules/, app/, components/
 *       modules/**    → may not import app/, components/
 *       components/** → may not import app/
 *       chatbot/**    → may not import modules/   (ADR-011)
 *  Type-only imports count too (they still couple layers).
 * Uses the TypeScript compiler API only — no external tooling.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const EXCLUDE = [join(SRC, "generated")];
const EXT = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDE.some((e) => p.startsWith(e))) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.some((e) => p.endsWith(e)) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // package import
  for (const cand of [base, ...EXT.map((e) => base + e), ...EXT.map((e) => join(base, "index" + e))]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function importsOf(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  sf.forEachChild(function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  });
  return specs.map((s) => resolveImport(file, s)).filter((x): x is string => !!x && !EXCLUDE.some((e) => x.startsWith(e)));
}

const layer = (file: string) => relative(SRC, file).split(sep)[0];
const RULES: Record<string, string[]> = {
  lib: ["modules", "app", "components"],
  modules: ["app", "components"],
  components: ["app"],
  chatbot: ["modules"],
};

const files = walk(SRC);
const graph = new Map(files.map((f) => [f, importsOf(f)]));
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

// ── boundaries
const violations: string[] = [];
for (const [from, deps] of graph) {
  const forbidden = RULES[layer(from)] ?? [];
  for (const to of deps) if (forbidden.includes(layer(to))) violations.push(`${rel(from)} → ${rel(to)}`);
}

// ── cycles (Tarjan SCC)
let index = 0;
const idx = new Map<string, number>();
const low = new Map<string, number>();
const stack: string[] = [];
const onStack = new Set<string>();
const cycles: string[][] = [];
function strong(v: string) {
  idx.set(v, index);
  low.set(v, index++);
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) {
      strong(w);
      low.set(v, Math.min(low.get(v)!, low.get(w)!));
    } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
  }
  if (low.get(v) === idx.get(v)) {
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1 || (graph.get(v) ?? []).includes(v)) cycles.push(scc.map(rel));
  }
}
for (const f of files) if (!idx.has(f)) strong(f);

const edges = [...graph.values()].reduce((n, d) => n + d.length, 0);
console.log(`scanned ${files.length} files, ${edges} internal imports`);
console.log(cycles.length ? `✗ ${cycles.length} circular dependency group(s):` : "✓ no circular dependencies");
for (const c of cycles) console.log("   " + c.join("  ⇄  "));
console.log(violations.length ? `✗ ${violations.length} layer-boundary violation(s):` : "✓ no layer-boundary violations");
for (const v of violations) console.log("   " + v);
if (cycles.length || violations.length) process.exitCode = 1;
