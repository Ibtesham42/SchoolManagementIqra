import { writeFileSync } from "node:fs";
import { renderMatrixMarkdown } from "../src/lib/rbac/matrix";

writeFileSync(new URL("../docs/RBAC_MATRIX.md", import.meta.url), renderMatrixMarkdown(), "utf8");
console.log("docs/RBAC_MATRIX.md written");
