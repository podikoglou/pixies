import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "highlight.js/styles/github-dark.css";
import "./styles/globals.css";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.classList.toggle("dark", prefersDark);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<div className="root">
			<RouterProvider router={router} />
		</div>
	</StrictMode>,
);
