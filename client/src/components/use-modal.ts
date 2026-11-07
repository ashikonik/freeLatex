import { useEffect } from 'react';

/**
 * Close a modal when the reader presses Escape.
 *
 * A modal that can only be dismissed with the mouse is a modal that traps
 * somebody who is working from the keyboard, so the key that means "go back"
 * is honoured here.
 *
 * @param onClose Called when the reader presses Escape.
 */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
}
