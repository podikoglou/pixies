import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./router";
import "@fontsource/geist-sans";
import "highlight.js/styles/github-dark.css";
import "leaflet/dist/leaflet.css";
import "./styles/globals.css";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", prefersDark);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<div className="root">
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</div>
	</StrictMode>,
);
