// Adds a sprite sheet (for example a Higgsfield AutoSprite export) to Bean's
// asset manifest.
//
//   npm run add:sprite -- run ~/Downloads/bean-run.png --fps 12 --facing right
//   npm run add:sprite -- happy ~/Downloads/bean-jump.png --frames 16 --columns 4
//
// Targets are Bean's states (idle, noticed, thinking, message, happy, sleepy,
// soundOff) or her motions (run, walk). Frames and columns default to a grid
// of square --frame-size cells (256 px, AutoSprite's default).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const states = ["idle", "noticed", "thinking", "message", "happy", "sleepy", "soundOff"];
const motions = ["run", "walk"];

const [target, source, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined)
    throw new Error(`Expected --option value pairs, received ${rest.slice(i).join(" ")}`);
  options[rest[i].slice(2)] = rest[i + 1];
}
if (![...states, ...motions].includes(target) || !source)
  throw new Error(`Usage: npm run add:sprite -- <${[...states, ...motions].join("|")}> <sheet.png> [--fps 12] [--frames n] [--columns n] [--frame-size 256] [--facing left|right] [--loop false]`);

const png = readFileSync(source);
if (png.toString("ascii", 1, 4) !== "PNG") throw new Error(`${source} is not a PNG file`);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
const frameSize = Number(options["frame-size"] ?? 256);
const columns = Number(options.columns ?? Math.max(1, Math.round(width / frameSize)));
const rows = Math.max(1, Math.round(height / (width / columns)));
const frames = Number(options.frames ?? columns * rows);
const fps = Number(options.fps ?? 12);
for (const [name, value] of Object.entries({ columns, frames, fps }))
  if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid ${name}: ${value}`);
if (frames > columns * rows) throw new Error(`${frames} frames do not fit a ${columns}×${rows} sheet`);

const spritesDir = join(root, "public/bean/sprites");
mkdirSync(spritesDir, { recursive: true });
const fileName = `${target}.png`;
copyFileSync(source, join(spritesDir, fileName));

const sprite = { src: `/bean/sprites/${fileName}`, frames, fps };
if (columns !== frames) sprite.columns = columns;
if (options.facing) sprite.facing = options.facing;
if (options.loop === "false") sprite.loop = false;

const manifestPath = join(root, "public/bean/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = "2.0";
if (states.includes(target)) manifest.states[target] = sprite;
else manifest.motions = { ...manifest.motions, [target]: sprite };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Added ${basename(source)} as ${target}: ${frames} frames, ${columns} per row, ${fps} fps`);
