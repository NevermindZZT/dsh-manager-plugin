import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "src", "client.js");
const stylesPath = path.join(root, "src", "styles.js");
const outputPath = path.join(root, "lib", "client.js");
const source = await fs.readFile(sourcePath, "utf8");
const styles = await fs.readFile(stylesPath, "utf8");
const tick = String.fromCharCode(96);
const marker = "const CSS = " + tick;
const start = styles.indexOf(marker);
const end = styles.indexOf(tick + ";", start);
if (start < 0 || end < 0)
  throw new Error("build: unable to extract settings card CSS");
const css = styles.slice(start + marker.length, end);
const body = source
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("import "))
  .join("\n")
  .replace("export const inject =", "exports.inject =")
  .replace("export function apply(ctx)", "exports.apply = function apply(ctx)");
const styleCode = [
  "const CSS = " + tick,
  css,
  tick + ";",
  "function adoptStyles() {",
  '  if (typeof document === "undefined") return;',
  '  const id = "@nevermindzzt/dsh-manager-plugin/settings-card";',
  "  if (document.querySelector('style[data-plugin-css=\"' + id + '\"]')) return;",
  '  const style = document.createElement("style");',
  '  style.dataset.plugin = "@nevermindzzt/dsh-manager-plugin";',
  "  style.dataset.pluginCss = id;",
  "  style.textContent = CSS;",
  "  document.head.appendChild(style);",
  "}",
  "",
].join("\n");
const output = [
  "window.__ModuleLoader__.load({",
  '  id: "@nevermindzzt/dsh-manager-plugin",',
  "  factory: (require) => {",
  '    const { jsx, jsxs } = require("react/jsx-runtime");',
  '    const { useEffect, useState } = require("react");',
  '    const { IconChevronDownOutline14 } = require("@deepseek-ai/dsh-client-ui-primitives");',
  "    const module = { exports: {} };",
  "    const exports = module.exports;",
  ...styleCode.split("\n").map((line) => "    " + line),
  ...body.split("\n").map((line) => "    " + line),
  "    return module.exports;",
  "  }",
  "});",
  "",
].join("\n");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, output, "utf8");
console.log("built " + path.relative(root, outputPath));
