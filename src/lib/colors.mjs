/**
 * ANSI color utilities for terminal output
 * Uses 24-bit true color (RGB) for nice dark-theme friendly colors
 */

// 24-bit ANSI escape: \x1b[38;2;R;G;Bm (foreground)
// Reset: \x1b[0m

// Soft coral pink for deletions/old values - easy on dark backgrounds
const PINK = '\x1b[38;2;255;121;121m';

// Mint green for additions/new values - easy on dark backgrounds  
const GREEN = '\x1b[38;2;123;237;159m';

// Dim gray for less important info
const DIM = '\x1b[38;2;140;140;140m';

// Yellow for warnings/highlights
const YELLOW = '\x1b[38;2;255;209;102m';

// Cyan for info
const CYAN = '\x1b[38;2;102;217;239m';

// Reset to default
const RESET = '\x1b[0m';

/**
 * Colorize text with pink (for old/deleted values)
 */
export function pink(text) {
  return `${PINK}${text}${RESET}`;
}

/**
 * Colorize text with green (for new/added values)
 */
export function green(text) {
  return `${GREEN}${text}${RESET}`;
}

/**
 * Colorize text with dim gray
 */
export function dim(text) {
  return `${DIM}${text}${RESET}`;
}

/**
 * Colorize text with yellow
 */
export function yellow(text) {
  return `${YELLOW}${text}${RESET}`;
}

/**
 * Colorize text with cyan
 */
export function cyan(text) {
  return `${CYAN}${text}${RESET}`;
}

/**
 * Format a diff line showing old -> new value
 */
export function diffLine(field, from, to) {
  return `  ${field}: ${pink(from)} → ${green(to)}`;
}

/**
 * Format a removal line (-)
 */
export function removal(text) {
  return `${PINK}- ${text}${RESET}`;
}

/**
 * Format an addition line (+)
 */
export function addition(text) {
  return `${GREEN}+ ${text}${RESET}`;
}

export const colors = {
  pink: PINK,
  green: GREEN,
  dim: DIM,
  yellow: YELLOW,
  cyan: CYAN,
  reset: RESET,
};
