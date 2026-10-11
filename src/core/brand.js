// The AKA IND maker's mark, traced from the master artwork and snapped to its exact geometry.
// Single path, even-odd fill, drawn in currentColor so it follows the theme.
// SPDX-License-Identifier: AGPL-3.0-or-later  (the mark itself is a trademark of AKA IND Technologies Inc.; see NOTICE)
export const AKA_PATH = 'M158 0 0 276h52l50-87h56v87h46v-106.5L295.5 276H342v-87h56l50 87h52L342 0h-46l-92 95.5V0zM158 92l-30 52h30zm184 0v52h30zm-46-26-64 65.7L296 206z';
export const akaSVG = (title = 'AKA IND') =>
  `<svg viewBox="0 0 500 276" role="img" aria-label="${title}"><path fill="currentColor" fill-rule="evenodd" d="${AKA_PATH}"/></svg>`;
