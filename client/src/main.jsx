import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

try { const t = localStorage.getItem("sa_theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
createRoot(document.getElementById("root")).render(<App />);
