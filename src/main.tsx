import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import SettingsApp from "./components/SettingsApp";
import { currentWindowLabel } from "./platform";
import "./styles.css";

// Bean's window and the Settings window load the same page.
const isSettings = currentWindowLabel() === "settings";
if (isSettings) document.documentElement.classList.add("is-settings-window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isSettings ? <SettingsApp /> : <App />}</StrictMode>,
);
