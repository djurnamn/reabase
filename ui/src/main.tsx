const stage = document.getElementById("boot-stage");
if (stage) stage.textContent = "Loading… (module executing)";

import React from "react";
import ReactDOM from "react-dom/client";
import { ReaperApp, ConfirmProvider } from "@djui/reaper-webview";

import "djui/styles/reset.scss";
import "djui/styles/global.scss";

import { App } from "./App";

if (stage) stage.textContent = "Loading… (imports resolved)";

// reaperConfig (the djui theme @djui/reaper-webview exposes) is single-mode
// dark, and window.reaper.mode() isn't in the bridge yet — so pin dark.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ReaperApp mode="dark">
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ReaperApp>
  </React.StrictMode>,
);
