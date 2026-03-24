const form = document.getElementById("stash-form");
const minutesInput = document.getElementById("minutes-input");
const statusMessage = document.getElementById("status-message");

minutesInput.focus();
minutesInput.select();

function setStatus(message) {
  statusMessage.textContent = message;
}

function setBusy(isBusy) {
  form.querySelector("button").disabled = isBusy;
  minutesInput.disabled = isBusy;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const rawMinutes = minutesInput.value.trim();
  if (!/^\d+$/.test(rawMinutes)) {
    setStatus("Enter a whole number of minutes.");
    minutesInput.focus();
    minutesInput.select();
    return;
  }

  const minutes = Number.parseInt(rawMinutes, 10);
  if (minutes <= 0) {
    setStatus("Enter a whole number of minutes greater than zero.");
    minutesInput.focus();
    minutesInput.select();
    return;
  }

  setBusy(true);
  setStatus("");

  try {
    const response = await browser.runtime.sendMessage({
      type: "stash-for-minutes",
      minutes,
    });

    if (!response?.ok) {
      setStatus(response?.error ?? "Backstash could not stash this tab.");
      setBusy(false);
      minutesInput.focus();
      minutesInput.select();
      return;
    }

    window.close();
  } catch (error) {
    setStatus("Backstash could not stash this tab.");
    setBusy(false);
    console.error("Failed to submit stash request:", error);
  }
});
