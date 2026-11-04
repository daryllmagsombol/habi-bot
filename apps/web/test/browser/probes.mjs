/*
 * In-page probes for the design-verification suite.
 *
 * Each export is passed straight to `page.evaluate`, so it must stay
 * self-contained: no imports, no references to module scope, and no shared
 * helpers. Playwright serialises the function source, and these functions run
 * inside Chromium.
 */

/** Layout metrics for the horizontal-overflow assertion. */
export function auditOverflow() {
  const root = document.documentElement;
  const overflow = [];

  if (root.scrollWidth > root.clientWidth) {
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();

      if (rect.width > 0 && rect.right > root.clientWidth + 1) {
        overflow.push({
          tag: element.tagName.toLowerCase(),
          className: String(element.className).slice(0, 90),
          right: Math.round(rect.right),
        });

        if (overflow.length >= 5) break;
      }
    }
  }

  return {
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflow,
  };
}

/** The rendered heading outline, in document order, including hidden nodes. */
export function auditHeadings() {
  return [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => {
    const style = getComputedStyle(heading);
    const rect = heading.getBoundingClientRect();

    return {
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
      visible:
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0,
    };
  });
}

/**
 * Contrast for every element with its own visible text, plus visible
 * placeholders.
 *
 * The background is the nearest ancestor (or the element itself) with an
 * opaque `background-color`, which is how the painted stack resolves here:
 * surfaces are opaque, and translucent tints only appear on hover.
 */
export function auditContrast() {
  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/i.exec(value);

    if (match === null) return null;

    const parts = match[1]
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);

    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;

    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };

  const luminance = (color) =>
    0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);

  const ratio = (foreground, background) => {
    const first = luminance(foreground);
    const second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };

  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 1 &&
      rect.height > 1
    );
  };

  const backgroundFor = (element) => {
    let node = element;

    while (node !== null) {
      const color = parseColor(getComputedStyle(node).backgroundColor);

      if (color !== null && color.a >= 0.999) return color;

      node = node.parentElement;
    }

    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION']);

  let checked = 0;
  let skippedHidden = 0;
  const violations = [];

  for (const element of document.querySelectorAll('body *')) {
    if (skipTags.has(element.tagName)) continue;

    const text = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
      .trim();

    if (text === '') continue;

    if (!isVisible(element)) {
      skippedHidden += 1;
      continue;
    }

    const style = getComputedStyle(element);
    const color = parseColor(style.color);

    if (color === null || color.a === 0) continue;

    checked += 1;

    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const required = isLarge ? 3 : 4.5;
    const background = backgroundFor(element);
    const measured = ratio(color, background);

    if (measured + 0.005 < required) {
      violations.push({
        tag: element.tagName.toLowerCase(),
        text: text.replace(/\s+/g, ' ').slice(0, 60),
        color: style.color,
        background: `rgb(${background.r}, ${background.g}, ${background.b})`,
        fontSize,
        fontWeight,
        ratio: Math.round(measured * 100) / 100,
        required,
      });
    }
  }

  /* Placeholder text is visible but never a text node; measure it from the
   * pseudo-element so the composer hint is held to the same ratio. */
  for (const element of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if ((element.getAttribute('placeholder') ?? '').trim() === '') continue;
    if (!isVisible(element)) continue;

    const placeholderColor = getComputedStyle(element, '::placeholder').color;
    const color = parseColor(placeholderColor);

    if (color === null || color.a === 0) continue;

    checked += 1;

    const style = getComputedStyle(element);
    const fontSize = Number.parseFloat(style.fontSize);
    const isLarge = fontSize >= 24;
    const required = isLarge ? 3 : 4.5;
    const background = backgroundFor(element);
    const measured = ratio(color, background);

    if (measured + 0.005 < required) {
      violations.push({
        tag: `${element.tagName.toLowerCase()}::placeholder`,
        text: (element.getAttribute('placeholder') ?? '').slice(0, 60),
        color: placeholderColor,
        background: `rgb(${background.r}, ${background.g}, ${background.b})`,
        fontSize,
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        ratio: Math.round(measured * 100) / 100,
        required,
      });
    }
  }

  return { checked, skippedHidden, violations };
}

/**
 * Interactive targets in their primary dimension.
 *
 * Exclusions match the documented boundary: form labels and checkbox inputs
 * (the label is the target), and inline text links, which fall under the WCAG
 * 2.5.8 inline exception. A citation chip is `inline-flex` and stays checked.
 */
export function auditTargets() {
  const selector =
    'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
  const violations = [];
  let checked = 0;
  let exemptInline = 0;
  let exemptCheckboxes = 0;

  for (const element of document.querySelectorAll(selector)) {
    const tag = element.tagName.toLowerCase();

    if (
      tag === 'input' &&
      (element.type === 'checkbox' || element.type === 'radio' || element.type === 'hidden')
    ) {
      exemptCheckboxes += 1;
      continue;
    }

    if (element.disabled === true) continue;

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }

    if (tag === 'a' && style.display === 'inline') {
      exemptInline += 1;
      continue;
    }

    checked += 1;

    if (rect.height < 44) {
      violations.push({
        tag,
        label: (element.getAttribute('aria-label') ?? element.textContent ?? '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 60),
        height: Math.round(rect.height * 10) / 10,
      });
    }
  }

  return { checked, exemptInline, exemptCheckboxes, violations };
}

/** The theme the browser actually resolved, with no stored choice. */
export function readThemeState() {
  let storedTheme = null;

  try {
    storedTheme = window.localStorage.getItem('habi-theme');
  } catch {
    // Blocked storage reads as no stored choice, same as the theme helper.
  }

  return {
    mediaDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    attribute: document.documentElement.dataset.theme ?? null,
    canvasToken: getComputedStyle(document.documentElement).getPropertyValue('--p-canvas').trim(),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    storedTheme,
  };
}

/** The focused element, for keyboard-order assertions. */
export function readFocus() {
  const element = document.activeElement;

  if (element === null) return null;

  const rect = element.getBoundingClientRect();

  return {
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
    label: element.getAttribute('aria-label'),
    href: element.getAttribute('href'),
    panelNav: element.closest('nav[aria-label="Thread panels"]') !== null,
    top: Math.round(rect.top * 10) / 10,
  };
}

/**
 * Installed before navigation. Records when `data-theme` first appears on
 * `<html>` and when the document finishes parsing, so the test can prove the
 * stored choice is applied before content, not patched in after hydration.
 */
export function recordThemeTimeline() {
  const entries = [];

  const capture = (phase) => {
    const style = getComputedStyle(document.documentElement);

    entries.push({
      phase,
      theme: document.documentElement.dataset.theme ?? null,
      canvasToken: style.getPropertyValue('--p-canvas').trim(),
      at: Math.round(performance.now() * 100) / 100,
    });
  };

  new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'data-theme')) capture('mutation');
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });

  document.addEventListener('DOMContentLoaded', () => capture('domcontentloaded'));

  window.__habiThemeTimeline = entries;
}

/** Reads the timeline installed by `recordThemeTimeline`. */
export function readThemeTimeline() {
  return window.__habiThemeTimeline ?? [];
}

/** Body text, title, and status-shaped facts for the 404 boundary. */
export function readBoundary() {
  return {
    title: document.title,
    text: document.body.innerText,
    h1: [...document.querySelectorAll('h1')].map((heading) =>
      heading.textContent.trim().replace(/\s+/g, ' '),
    ),
    links: [...document.querySelectorAll('a[href]')].map((link) => ({
      href: link.getAttribute('href'),
      text: link.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
    })),
  };
}
