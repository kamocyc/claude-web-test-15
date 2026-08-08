/**
 * Browser file in/out.
 *
 * Deliberately Blob + anchor for export and a hidden `<input type="file">` for
 * import. The File System Access API is nicer but does not exist in headless
 * Chromium under Playwright, and a code path the test suite cannot reach is a
 * code path that silently rots.
 */

export function downloadText(fileName: string, text: string, mime = 'application/json'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  // Leave the anchor in place for a moment: Chromium reads `download` after the
  // click returns, and removing it synchronously loses the suggested filename.
  setTimeout(() => {
    if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 1000);
}

export interface PickedFile {
  name: string;
  text: string;
}

/**
 * Open the OS file picker and resolve with the chosen file's text, or
 * `undefined` if the user cancelled.
 */
export function pickTextFile(accept = '.json,application/json'): Promise<PickedFile | undefined> {
  if (typeof document === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = (): void => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(undefined);
        return;
      }
      void file
        .text()
        .then((text) => {
          cleanup();
          resolve({ name: file.name, text });
        })
        .catch(() => {
          cleanup();
          resolve(undefined);
        });
    });

    input.addEventListener('cancel', () => {
      cleanup();
      resolve(undefined);
    });

    input.click();
  });
}

/** Read a `File` handed over by a drop or a controlled `<input>`. */
export async function readFile(file: File): Promise<PickedFile> {
  return { name: file.name, text: await file.text() };
}
