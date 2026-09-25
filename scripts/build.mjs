import fs from "node:fs/promises";
import path from "node:path";
import prettier from "prettier";

const root = process.cwd();
const sourcePath = path.join(root, "src", "client.js");
const outputPath = path.join(root, "lib", "client.js");
const source = await fs.readFile(sourcePath, "utf8");
const body = source
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("import "))
  .join("\n")
  .replace(/^export const name =/m, "exports.name =")
  .replace(/^export const inject =/m, "exports.inject =")
  .replace(/^export function apply\(/m, "exports.apply = function apply(");
if (/^\s*export /m.test(body)) {
  throw new Error("build: unhandled export remains in client entry");
}
const output = [
  "window.__ModuleLoader__.load({",
  '  id: "@nevermindzzt/dsh-manager-plugin",',
  "  factory: (require) => {",
  "    const module = { exports: {} };",
  "    const exports = module.exports;",
  '    const { jsx, jsxs } = require("react/jsx-runtime");',
  '    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
  ...body.split("\n").map((line) => "    " + line),
  "    return module.exports;",
  "  },",
  "});",
  "",
].join("\n");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const formatted = await prettier.format(output, { filepath: outputPath });
await fs.writeFile(outputPath, formatted, "utf8");
console.log("built " + path.relative(root, outputPath));
