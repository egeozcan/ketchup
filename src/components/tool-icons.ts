import { svg } from 'lit';
import type { ToolType } from '../types.js';

/**
 * Friendly, recognizable SVG icons for every tool.
 * Each icon is a 24x24 viewBox SVG template.
 */
export const toolIcons: Record<ToolType, ReturnType<typeof svg>> = {
  // Select — dashed marquee (MS Paint style)
  select: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">
      <rect x="4" y="4" width="16" height="16" stroke-dasharray="4 4" />
    </svg>`,

  // Pencil — classic pencil shape
  pencil: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
    </svg>`,

  // Marker — thick marker/highlighter
  marker: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m9 11-6 6v3h9l3-3"/>
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
    </svg>`,

  // Eraser — rectangular eraser
  eraser: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
      <path d="M22 21H7"/>
      <path d="m5 11 9 9"/>
    </svg>`,

  // Line — diagonal line
  line: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="5" y1="19" x2="19" y2="5"/>
    </svg>`,

  // Rectangle — simple rectangle
  rectangle: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
    </svg>`,

  // Circle — simple circle/ellipse
  circle: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
    </svg>`,

  // Triangle
  triangle: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3L22 21H2z"/>
    </svg>`,

  // Fill — paint bucket
  fill: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/>
      <path d="m5 2 5 5"/>
      <path d="M2 13h15"/>
      <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>
    </svg>`,

  // Stamp — rubber stamp
  stamp: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 22h20"/>
      <path d="M6 12v-4c0-2.2 1.8-4 4-4h4c2.2 0 4 1.8 4 4v4"/>
      <path d="M6 12h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Z"/>
      <path d="M9 13v-1"/>
      <path d="M15 13v-1"/>
    </svg>`,

  // Hand — pan/drag tool
  hand: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v1"/>
      <path d="M14 10V4a2 2 0 0 0-4 0v6"/>
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>
      <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
    </svg>`,
};

export const actionIcons = {
  undo: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
    </svg>`,

  redo: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/>
    </svg>`,

  save: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>`,

  clear: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18"/>
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
    </svg>`,
};

export const toolLabels: Record<ToolType, string> = {
  select: 'Select',
  pencil: 'Pencil',
  marker: 'Marker',
  eraser: 'Eraser',
  line: 'Line',
  rectangle: 'Rectangle',
  circle: 'Circle',
  triangle: 'Triangle',
  fill: 'Fill',
  stamp: 'Stamp',
  hand: 'Hand (Pan)',
};
