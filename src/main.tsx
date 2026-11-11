import { createRoot } from "react-dom/client";
import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/svalbard-light.css";
import "@bryntum/gantt/fontawesome/css/fontawesome.css";
import "@bryntum/gantt/fontawesome/css/solid.css";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
