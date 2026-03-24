# Backstash

Backstash is a Firefox extension for **temporarily stashing tabs** and restoring them later — helping reduce tab clutter and improve focus.

Unlike tab suspension tools, Backstash removes tabs entirely and brings them back when you actually need them.


## ✨ Features

- Stash the current tab for later
- Automatically restore stashed tabs after a delay
- Restore tabs in the **same container** (Multi-Account Containers support)
- Restore tabs in the **background** (no focus interruption)
- Optional notifications when tabs are restored
- Keyboard-first workflow (in progress)


## 🚧 Status

This project is in early development. See TODO.md
Browser-specific verification lives in `TESTING.md`.


## 🧠 Concept

Backstash is designed around a simple workflow:

> “Not now — but later.”

Instead of leaving tabs open indefinitely, you stash them with intent and let them return at the right time.


## 🔧 Development

### Requirements

- Node.js (managed via asdf recommended)
- npm

### Setup

```bash
npm install
````

### Linting

```bash
npm run lint
```

### Automated tests

```bash
npm test
```

### Running the extension

1. Open Firefox
2. Navigate to: `about:debugging`
3. Click **"This Firefox"**
4. Click **"Load Temporary Add-on"**
5. Select `manifest.json`


## 🗺 Roadmap (high-level)

* Restore to original window
* Custom stash durations
* Date/time-based stashing
* Notification batching
* Tab group support (if Firefox APIs allow)

See `TODO.md` for details.

## 🤝 Contributing

This is currently a personal project, but issues and ideas are welcome.


## 📜 License

MIT
