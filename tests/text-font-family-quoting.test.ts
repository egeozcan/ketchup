import { describe, expect, it } from 'vitest';
import { buildFontString } from '../src/tools/text.ts';

/**
 * Bug: buildFontString does not quote font family names that contain spaces.
 *
 * The CSS font shorthand (used by canvas ctx.font) requires font family names
 * with spaces to be quoted, e.g. `24px 'Times New Roman'`. Without quotes, the
 * browser/canvas may interpret each space-separated word as a separate font
 * family fallback, breaking font selection for multi-word names like
 * "Times New Roman", "Courier New", etc.
 *
 * Root cause: src/tools/text.ts, buildFontString()
 *   The function interpolates fontFamily directly without quoting:
 *     `${fontSize}px ${fontFamily}`
 *   producing "24px Times New Roman" instead of "24px 'Times New Roman'".
 *
 * The fix: wrap fontFamily in quotes when it contains a space (or always quote):
 *   const quoted = fontFamily.includes(' ') ? `'${fontFamily}'` : fontFamily;
 *   return `... ${fontSize}px ${quoted}`;
 *
 * Impact: Text rendered with multi-word font families ("Times New Roman",
 * "Courier New") silently falls back to the default font, producing different
 * output than what the user selected in the font dropdown.
 */
describe('buildFontString must quote multi-word font families', () => {
  it('should quote a font family that contains a space', () => {
    const result = buildFontString(24, 'Times New Roman', false, false);
    // The CSS font shorthand requires multi-word font family names to be quoted.
    // Expected: "24px 'Times New Roman'"
    // Bug:      "24px Times New Roman"
    expect(result).toBe("24px 'Times New Roman'");
  });

  it('should quote Courier New', () => {
    const result = buildFontString(16, 'Courier New', true, false);
    // Expected: "bold 16px 'Courier New'"
    expect(result).toBe("bold 16px 'Courier New'");
  });

  it('should not add quotes to single-word families', () => {
    const result = buildFontString(24, 'sans-serif', false, false);
    // Single-word (or generic) families should not be quoted
    expect(result).toBe('24px sans-serif');
  });

  it('should not add quotes to generic family keywords', () => {
    const result = buildFontString(12, 'monospace', false, false);
    expect(result).toBe('12px monospace');
  });

  it('should handle bold + italic + quoted family', () => {
    const result = buildFontString(20, 'Times New Roman', true, true);
    expect(result).toBe("italic bold 20px 'Times New Roman'");
  });
});
