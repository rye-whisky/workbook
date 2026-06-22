import fs from "node:fs";
import path from "node:path";

const target = path.resolve("dist/server.js");
const source = fs.readFileSync(target, "utf8");
fs.writeFileSync(target, source.replaceAll('from "sqlite"', 'from "node:sqlite"'));
