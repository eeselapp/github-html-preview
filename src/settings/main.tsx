import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const AUTO_OPEN_KEY = 'autoOpenPreview';

function App() {
  const [autoOpen, setAutoOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    chrome.storage.local
      .get(AUTO_OPEN_KEY)
      .then((stored) => setAutoOpen(Boolean(stored[AUTO_OPEN_KEY])))
      .finally(() => setReady(true));
  }, []);

  function updateAutoOpen(value: boolean) {
    setAutoOpen(value);
    void chrome.storage.local.set({ [AUTO_OPEN_KEY]: value });
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8 flex items-center gap-4">
        <img src="/public/logo.png" alt="" className="size-12 rounded-xl" />
        <div>
          <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">eesel</p>
          <h1 className="text-2xl font-semibold tracking-tight">HTML Preview Settings</h1>
        </div>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <label className="flex cursor-pointer items-center justify-between gap-6">
          <span>
            <span className="block font-medium">Open previews automatically</span>
            <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">
              Show the preview when you open an HTML file on GitHub.
            </span>
          </span>
          <input
            type="checkbox"
            className="size-5 shrink-0 accent-indigo-600"
            checked={autoOpen}
            disabled={!ready}
            onChange={(event) => updateAutoOpen(event.target.checked)}
          />
        </label>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
