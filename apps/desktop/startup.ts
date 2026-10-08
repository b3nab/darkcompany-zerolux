import { invoke } from "@tauri-apps/api/core";

interface StartupView {
  status: string;
  error: string | null;
  choosing: boolean;
  url: string;
}

declare global {
  interface Window {
    zeroluxDesktopState: (view: StartupView) => void;
  }
}

const status = document.getElementById("status")!;
const error = document.getElementById("error")!;
const choices = document.getElementById("choices") as HTMLFieldSetElement;
const address = document.getElementById("address") as HTMLInputElement;

window.zeroluxDesktopState = (view) => {
  status.textContent = view.status;
  error.textContent = view.error ?? "";
  choices.hidden = !view.choosing;
  choices.disabled = !view.choosing;
  if (document.activeElement !== address) address.value = view.url;
};

async function choose(
  choice: { mode: "local" } | { mode: "existing"; url: string },
) {
  choices.disabled = true;
  error.textContent = "";
  try {
    await invoke("choose_workspace", { choice });
  } catch (failure) {
    error.textContent = String(failure);
    choices.disabled = false;
  }
}

document.getElementById("connection")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void choose({ mode: "existing", url: address.value.trim() });
});
document.getElementById("local")!.addEventListener("click", () => {
  void choose({ mode: "local" });
});
