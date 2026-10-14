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
    title.title = stash.title || stash.url;

    const meta = document.createElement("p");
    meta.className = "stash-meta";
    meta.textContent = `Restores ${formatWakeAt(stash.wakeAt)}`;
    if (stash.status === "stashing") {
      meta.textContent = "Stashing was interrupted. The source tab may still be open; check your tabs before restoring this saved copy.";
    } else if (stash.status === "stashed") {
      meta.textContent = "Source tab closed. Finish scheduling this saved tab.";
    } else if (stash.status === "restoring") {
      meta.textContent = "A previous restore may have opened this tab. Check your tabs before restoring again.";
    } else if (stash.status === "restored") {
      meta.textContent = "Tab already restored. Cleanup is still pending.";
    } else if (stash.retryExhausted) {
      meta.textContent = "Automatic retries stopped. Choose Restore to try again.";
    } else if (stash.nextRetryAt !== null && stash.nextRetryAt !== undefined) {
      meta.textContent = `Retry due ${formatWakeAt(stash.nextRetryAt)}`;
    }

    const footer = document.createElement("div");
    footer.className = "stash-footer";

    const actions = document.createElement("div");
    actions.className = "stash-actions";

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "stash-action-link";
    restoreButton.textContent = "Restore";
    if (stash.status === "stashing") restoreButton.textContent = "Restore saved copy";
    if (stash.status === "stashed") restoreButton.textContent = "Finish scheduling";
    if (stash.status === "restoring") restoreButton.textContent = "Restore again";
    if (stash.status === "restored") restoreButton.textContent = "Finish cleanup";
    restoreButton.addEventListener("click", async () => {
      restoreButton.disabled = true;
      cancelButton.disabled = true;
      setStatus("");

      try {
        const response = await browser.runtime.sendMessage({
          type: stash.status === "stashed" ? "finish-stash" : "restore-stash-now",
          stashId: stash.id,
          confirmRestore: stash.status === "restoring" || stash.status === "stashing",
        });

        if (!response?.ok) {
          restoreButton.disabled = false;
          cancelButton.disabled = false;
          await refreshStashes();
          setStatus(response?.error ?? "Backstash could not restore that stash.");
          return;
        }

        await refreshStashes();
        if (response.cleanupPending) setStatus("Tab restored. Cleanup is still pending.");
        if (response.alarmPending) setStatus(response.error);
      } catch (error) {
        setStatus("Backstash could not restore that stash.");
        restoreButton.disabled = false;
        cancelButton.disabled = false;
        console.error("Failed to restore stash:", error);
      }
    });

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "stash-action-link";
    cancelButton.dataset.tone = "danger";
    cancelButton.textContent = "Delete";
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

    const separator = document.createElement("span");
    separator.className = "stash-action-separator";
    separator.textContent = "|";

    actions.append(restoreButton, separator, cancelButton);
    footer.append(meta, actions);
    content.append(title, footer);
    item.append(content);
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
      if (response?.stashSaved) await refreshStashes();
      setStatus(response?.error ?? "Backstash could not stash this tab.");
      setBusy(false);
      minutesInput.focus();
      minutesInput.select();
      return;
    }

    if (response.alarmPending) {
      await refreshStashes();
      setStatus(response.error);
      setBusy(false);
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
      await refreshStashes();
      setStatus(response.failedCount > 0
        ? "Some stashes could not be restored. Check the list for recovery actions."
        : "No stashed tabs are available to restore.");
      return;
    }

    await refreshStashes();
    if (response?.failedCount > 0 || response?.cleanupPendingCount > 0) {
      setStatus("Some stashes still need attention. Check the list for recovery actions.");
    }
  } catch (error) {
    setStatus("Backstash could not restore all stashes.");
    restoreAllButton.disabled = false;
    console.error("Failed to restore all stashes:", error);
  }
});

refreshStashes();
