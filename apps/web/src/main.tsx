import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// A placeholder until Task 5's lane view.
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <h1>Manufactory Idle</h1>
  </StrictMode>,
);
