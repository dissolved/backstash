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

  const minutes = BackstashPresets.parseDurationInputToMinutes(
    minutesInput.value,
  );
  if (minutes === null) {
    setStatus("Enter a duration like 15, 15m, 2h, or 3d.");
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
