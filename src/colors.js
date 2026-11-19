// Colour names accepted on the command line and in the config, as 0xRRGGBB.
export const COLORS = {
  off: 0x000000,
  red: 0xff2222,
  green: 0x22cc55,
  blue: 0x2277ff,
  amber: 0xffaa00,
  orange: 0xff6600,
  yellow: 0xffdd00,
  purple: 0xaa55ff,
  pink: 0xff44aa,
  cyan: 0x22ddff,
  white: 0xffffff,
};

/** "amber", "#ff8800" or "ff8800" -> number; throws on anything else. */
export function parseColor(text) {
  const key = String(text).trim().toLowerCase();
  if (key in COLORS) return COLORS[key];
  const hex = /^#?([0-9a-f]{6})$/i.exec(key);
  if (hex) return parseInt(hex[1], 16);
  throw new Error(`unknown colour "${text}" (use ${Object.keys(COLORS).join(", ")} or #rrggbb)`);
}

export function ring(color, brightness = 0.5, effect = 1) {
  return { e: color === 0 ? 0 : effect, b: brightness, s: 0, m: 0, c: color };
}

export function keyLight(id, color, brightness = 1, effect = 1, speed = 0) {
  return { id, c: color, b: brightness, e: color === 0 ? 0 : effect, s: speed };
}
