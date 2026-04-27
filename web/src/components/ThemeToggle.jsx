import React, { useEffect, useState } from 'react';

const THEME_KEY = 'theme';

function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.dataset.theme = theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) {
      // ignore
    }
    return document.documentElement.dataset.theme || 'dark';
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    setTheme(next);
  }

  return (
    <button className="theme-toggle" onClick={toggle} title={`Toggle theme (currently ${theme})`}>
      <span className="theme-icon">{theme === 'dark' ? '🌙' : '☀︎'}</span>
    </button>
  );
}
