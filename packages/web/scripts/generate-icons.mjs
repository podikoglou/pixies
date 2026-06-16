import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "assets");
const PUBLIC = resolve(__dirname, "..", "public");

mkdirSync(PUBLIC, { recursive: true });

const SIZES = {
	"icon-192.png": { src: "icon.svg", size: 192 },
	"icon-512.png": { src: "icon.svg", size: 512 },
	"apple-touch-icon.png": { src: "icon.svg", size: 180 },
	"icon-512-maskable.png": { src: "icon-maskable.svg", size: 512 },
};

async function main() {
	for (const [filename, { src, size }] of Object.entries(SIZES)) {
		const svg = readFileSync(resolve(ASSETS, src), "utf-8");
		await sharp(Buffer.from(svg))
			.resize(size, size)
			.png()
			.toFile(resolve(PUBLIC, filename));
		console.log(`✅ ${filename} (${size}×${size})`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
