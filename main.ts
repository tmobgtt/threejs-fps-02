// YARDLINE entrypoint: hand the game to the grader.
//
// Copies game/ and screenshots/ from this repository into the output
// directory (MAKEFUN_OUTPUT_DIR, or /output inside the grader) and writes
// dossier.json there with the kit's own buildDossier, so the dossier the
// judge reads is exactly the one the sealed scorer rebuilds. The copy is a
// plain recursive file copy in sorted order; running this twice writes the
// same bytes both times.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-threejs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

mkdirSync(outDir, { recursive: true });
for (const part of ["game", "screenshots"]) {
  cpSync(join(here, part), join(outDir, part), { recursive: true });
}

const dossier = buildDossier(outDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(outDir, "dossier.json"), dossier);
console.log(`yardline: game + screenshots copied, dossier ${dossier.length} bytes -> ${outDir}`);
