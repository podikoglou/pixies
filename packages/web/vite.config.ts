import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Read `.env` from the monorepo root so the web SPA shares the single root
	// `.env` with the server (PIXIES_* + VITE_* live together).
	envDir: path.resolve(__dirname, "../../"),
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		proxy: {
			"/conversations": "http://localhost:3000",
			"/health": "http://localhost:3000",
		},
		allowedHosts: ["osaka.tarpon-ghost.ts.net"],
	},
	build: {
		outDir: "dist",
	},
});
