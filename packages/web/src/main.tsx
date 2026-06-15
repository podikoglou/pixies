import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<div className="root">
			<RouterProvider router={router} />
		</div>
	</StrictMode>,
);
