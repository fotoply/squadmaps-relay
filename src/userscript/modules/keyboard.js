// filepath: src/userscript/modules/keyboard.js
// Centralized keyboard shortcuts for the userscript.
// Safe to call multiple times; installs a single window keydown listener.

import {
  undo,
  redo,
  deleteAtCursor,
  triggerEditAtCursor,
  stopManualEditing,
  clickToolbarSave,
  isToolbarEditModeActive,
  hasActiveEditedLayer,
  hasHoveredLayer,
} from './draw.js';

let __installed = false;

function isTypingInEditable(el) {
  try {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    // Also treat elements inside a contenteditable container as editable
    let p = el;
    while (p && p !== document.body) {
      try { if (p.isContentEditable) return true; } catch (_) {}
      p = p.parentElement;
    }
  } catch (_) {}
  return false;
}

function shouldHandleEvent(e) {
  try {
    // Ignore if typing in an input or editable element
    if (isTypingInEditable(e.target)) return false;
    // Ignore if any modifier other than Ctrl is pressed for our shortcuts
    // We still allow Shift for uppercase letters but our comparisons handle both cases.
    return true;
  } catch (_) { return true; }
}

function onKeyDown(e) {
  try {
    if (!shouldHandleEvent(e)) return;

    const key = e.key;
    const ctrl = !!e.ctrlKey; // Mac users can still use Ctrl in browser; meta is reserved by the page for map clicks

    // Undo/redo
    if (ctrl && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }
    if (ctrl && (key === 'y' || key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }

    // Escape: close radial marker menu if open (and optionally stop manual edit)
    if (key === 'Escape') {
      try { if (typeof window.__squadCloseMarkerRadial === 'function') window.__squadCloseMarkerRadial(); } catch (_) {}
      return;
    }

    // While toolbar edit mode is active, E/Enter acts like Save
    if (isToolbarEditModeActive() && (key === 'e' || key === 'E' || key === 'Enter')) {
      e.preventDefault();
      const ok = clickToolbarSave();
      if (!ok) {
        // Fallback: stop any manual editing state
        stopManualEditing();
      }
      return;
    }

    // Delete layer under cursor
    if (key === 'Delete' || key === 'Backspace' || key === 'd' || key === 'D') {
      e.preventDefault();
      deleteAtCursor(e);
      return;
    }

    // Edit layer under cursor or stop current manual edit
    if (key === 'e' || key === 'E' || key === 'Enter') {
      e.preventDefault();
      if (!isToolbarEditModeActive() && !hasHoveredLayer() && hasActiveEditedLayer()) {
        stopManualEditing();
        return;
      }
      triggerEditAtCursor(e);
      return;
    }
  } catch (_) {}
}

export function initKeyboard() {
  try {
    if (__installed) return;
    window.addEventListener('keydown', onKeyDown);
    __installed = true;
  } catch (_) {}
}

