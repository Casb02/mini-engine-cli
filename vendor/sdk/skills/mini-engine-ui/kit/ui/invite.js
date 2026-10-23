// MiniEngineUI invite helpers. Only dependency: ./qr.js (uqr 0.1.3, MIT, see qr-LICENSE.txt).
import { renderSVG } from './qr.js';

/** @typedef {{ copy: string, copied: string, showQr: string, close: string, scan: string }} InviteLabels */

/** @type {InviteLabels} */
const defaults = { copy: 'Copy the join link', copied: 'Copied', showQr: 'Show a QR code to join', close: 'Close', scan: 'Scan to join' };

/** @param {string} code */
export function joinUrl(code) {
  return `${location.origin}/home/join?room=${encodeURIComponent(code)}`;
}

/** Dark on white, quiet zone of 4 modules. Holds no user text, so it may go into innerHTML. @param {string} text */
export function qrSvg(text) {
  return renderSVG(text, { border: 4, whiteColor: '#ffffff', blackColor: '#000000' });
}

/** Owns the button's text: the code, or the copied label for 1.5 s. @param {HTMLElement} button @param {string} code @param {Partial<InviteLabels>} [labels] */
export function bindCopyCode(button, code, labels = {}) {
  const text = { ...defaults, ...labels };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  button.textContent = code;
  button.title = text.copy;
  button.setAttribute('aria-label', `${code}. ${text.copy}`);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl(code));
    } catch {
      return;
    }
    button.textContent = text.copied;
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = code; }, 1500);
  });
}

/** @param {HTMLElement} button @param {string} code @param {Partial<InviteLabels>} [labels] */
export function bindQrDialog(button, code, labels = {}) {
  const text = { ...defaults, ...labels };
  /** @type {HTMLDialogElement | undefined} */
  let dialog;
  button.setAttribute('aria-haspopup', 'dialog');
  if (!button.title) button.title = text.showQr;
  button.addEventListener('click', () => {
    dialog ??= createDialog(code, text);
    if (!dialog.open) dialog.showModal();
  });
}

/** @param {string} code @param {InviteLabels} text */
function createDialog(code, text) {
  const dialog = document.createElement('dialog');
  dialog.className = 'me-dialog';
  dialog.setAttribute('aria-label', text.scan);
  const body = document.createElement('div');
  body.className = 'me-dialog-body';
  const qr = document.createElement('div');
  qr.className = 'me-qr';
  qr.setAttribute('role', 'img');
  qr.setAttribute('aria-label', `${text.scan}: ${joinUrl(code)}`);
  qr.innerHTML = qrSvg(joinUrl(code));
  const label = document.createElement('p');
  label.className = 'me-label';
  label.textContent = text.scan;
  const codeText = document.createElement('p');
  codeText.className = 'me-code';
  codeText.textContent = code;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'me-button is-wide';
  close.textContent = text.close;
  close.addEventListener('click', () => dialog.close());
  body.append(qr, label, codeText, close);
  dialog.append(body);
  // The dialog itself has no padding, so a click whose target is the dialog landed on the backdrop.
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  return dialog;
}
