"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

/** Keyboard behavior for custom content mounted inside the shared Modal. */
export function useDialogFocus(onClose: () => void) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      // Let an open picker handle Escape first, including when its menu is
      // portaled outside the dialog. A second Escape closes this dialog.
      if (dialog.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
      ) ?? [],
    ).filter((element) => !element.closest("[hidden], [inert]"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) {
      event.preventDefault();
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog.current)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return { dialog, onKeyDown };
}
