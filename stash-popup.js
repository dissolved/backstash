const form = document.getElementById("stash-form");
const minutesInput = document.getElementById("minutes-input");
const statusMessage = document.getElementById("status-message");
const stashesList = document.getElementById("stashes-list");
const stashesEmpty = document.getElementById("stashes-empty");
const restoreAllButton = document.getElementById("restore-all-button");

minutesInput.focus();
minutesInput.select();

function setStatus(message) {
  statusMessage.textContent = message;
}

function setBusy(isBusy) {
  form.querySelector("button").disabled = isBusy;
  minutesInput.disabled = isBusy;
}

function formatWakeAt(wakeAt) {
  return new Date(wakeAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function renderStashes(stashes) {
  stashesList.textContent = "";
  stashesEmpty.hidden = stashes.length > 0;
  restoreAllButton.disabled = stashes.length === 0;

  for (const stash of stashes) {
    const item = document.createElement("li");
    item.className = "stash-item";

    const content = document.createElement("div");

    const title = document.createElement("p");
    title.className = "stash-title";
    title.textContent = stash.title || stash.url;

    const meta = document.createElement("p");
    meta.className = "stash-meta";
    meta.textContent = `Restores ${formatWakeAt(stash.wakeAt)}`;

    content.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "stash-actions";

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "stash-restore-button";
    restoreButton.textContent = "Restore now";
    restoreButton.addEventListener("click", async () => {
      restoreButton.disabled = true;
      cancelButton.disabled = true;
      setStatus("");

      try {
        const response = await browser.runtime.sendMessage({
          type: "restore-stash-now",
          stashId: stash.id,
        });

        if (!response?.ok) {
          setStatus("Backstash could not restore that stash.");
          restoreButton.disabled = false;
          cancelButton.disabled = false;
          return;
        }

        await refreshStashes();
      } catch (error) {
        setStatus("Backstash could not restore that stash.");
        restoreButton.disabled = false;
        cancelButton.disabled = false;
        console.error("Failed to restore stash:", error);
      }
    });

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "secondary-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", async () => {
      restoreButton.disabled = true;
      cancelButton.disabled = true;
      setStatus("");

      try {
        const response = await browser.runtime.sendMessage({
          type: "cancel-stash",
          stashId: stash.id,
        });

        if (!response?.ok) {
          setStatus("Backstash could not cancel that stash.");
          restoreButton.disabled = false;
          cancelButton.disabled = false;
          return;
        }

        await refreshStashes();
      } catch (error) {
        setStatus("Backstash could not cancel that stash.");
        restoreButton.disabled = false;
        cancelButton.disabled = false;
        console.error("Failed to cancel stash:", error);
      }
    });

    actions.append(restoreButton, cancelButton);
    item.append(content, actions);
    stashesList.append(item);
  }
}

async function refreshStashes() {
  try {
    const stashes = await browser.runtime.sendMessage({
      type: "list-stashes",
    });
    renderStashes(stashes ?? []);
  } catch (error) {
    setStatus("Backstash could not load current stashes.");
    console.error("Failed to load stashes:", error);
  }
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

restoreAllButton.addEventListener("click", async () => {
  restoreAllButton.disabled = true;
  setStatus("");

  try {
    const response = await browser.runtime.sendMessage({
      type: "restore-all-stashes",
    });

    if (!response?.ok && response?.restoredCount === 0) {
      setStatus("No stashed tabs are available to restore.");
      restoreAllButton.disabled = false;
      return;
    }

    await refreshStashes();
  } catch (error) {
    setStatus("Backstash could not restore all stashes.");
    restoreAllButton.disabled = false;
    console.error("Failed to restore all stashes:", error);
  }
});

refreshStashes();
