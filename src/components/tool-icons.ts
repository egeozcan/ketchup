import { svg } from 'lit';
import type { ToolType } from '../types.js';

/**
 * Friendly, recognizable SVG icons for every tool.
 * Each icon is a 24x24 viewBox SVG template.
 */
export const toolIcons: Record<ToolType, ReturnType<typeof svg>> = {
  // Select — dashed rectangle
  select: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="4 3"/>
    </svg>`,

  // Pencil — classic pencil shape
  pencil: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
    </svg>`,

  // Marker — thick marker/highlighter
  marker: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z"/>
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
      <path d="M2 2l7.586 7.586"/>
      <circle cx="11" cy="11" r="2"/>
    </svg>`,

  // Eraser — rectangular eraser
  eraser: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 20H7L3 16a1 1 0 0 1 0-1.41l9.59-9.59a2 2 0 0 1 2.82 0L20.5 10.1a2 2 0 0 1 0 2.82L13 20"/>
      <path d="M6 14l4 4"/>
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
      <path d="M2.5 2.5l9 9"/>
      <path d="M7.5 7.5L16 16a2 2 0 0 1 0 2.83l-1.17 1.17a2 2 0 0 1-2.83 0L4.5 12.5a2 2 0 0 1 0-2.83L7.5 7.5z"/>
      <path d="M20 14c.5 1.5 1 3 1 4a2 2 0 0 1-4 0c0-1 .5-2.5 1-4l1-2 1 2z"/>
    </svg>`,

  // Stamp — image/stamp icon
  stamp: svg`
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
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
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <line x1="10" y1="11" x2="10" y2="17"/>
      <line x1="14" y1="11" x2="14" y2="17"/>
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
};
