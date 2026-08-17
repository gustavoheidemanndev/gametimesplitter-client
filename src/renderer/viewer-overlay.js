const bridge = window.gameTimeSpliter;
const i18n = window.gtsI18n;
const t = (key, params) => i18n.t(key, params);
const byId = (id) => document.getElementById(id);
const root = byId('root');
const leaderField = byId('viewer-leader');
const deltaField = byId('viewer-delta');

let compactTime = false;
// Estado já reduzido pelo main (ViewerOverlayState). null = nenhuma corrida sendo assistida.
let currentState = null;
let dragControlsHideTimer = null;

const showDragControls = () => {
  if (dragControlsHideTimer !== null) {
    window.clearTimeout(dragControlsHideTimer);
    dragControlsHideTimer = null;
  }
  root.classList.add('drag-controls-visible');
};

const scheduleDragControlsHide = () => {
  if (dragControlsHideTimer !== null) window.clearTimeout(dragControlsHideTimer);
  dragControlsHideTimer = window.setTimeout(() => {
    root.classList.remove('drag-controls-visible');
    dragControlsHideTimer = null;
  }, 2_000);
};

root.addEventListener('pointerenter', showDragControls);
root.addEventListener('pointermove', showDragControls);
root.addEventListener('pointerleave', scheduleDragControlsHide);
showDragControls();
scheduleDragControlsHide();

const hexToRgba = (hex, alpha) => {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!match) return `rgba(0, 0, 0, ${alpha})`;
  const value = parseInt(match[1], 16);
  const clamped = Math.min(Math.max(Number(alpha) || 0, 0), 1);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${clamped})`;
};

const decimalSeparator = () => new Intl.NumberFormat(i18n.locale).formatToParts(1.1)
  .find((part) => part.type === 'decimal')?.value || '.';

/** Mesma convenção de sinal e de compactação do delta da overlay do runner. */
const formatDelta = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return t('viewer.overlayEmpty');
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const centiseconds = Math.floor((abs % 1_000) / 10);
  const fraction = compactTime ? '' : `${decimalSeparator()}${String(centiseconds).padStart(2, '0')}`;
  const value = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}${fraction}`
    : `${seconds}${fraction}`;
  return `${ms < 0 ? '-' : '+'}${value}`;
};

const deltaClass = (value) => value < 0 ? 'ahead' : value > 0 ? 'behind' : '';

/**
 * Sem líder — nenhum split comum ainda, sala recém-largada ou corrida encerrada — os dois campos
 * viram traço, conforme a regra do documento da feature.
 */
const render = () => {
  const empty = t('viewer.overlayEmpty');
  const leader = currentState?.leaderUsername;
  const delta = currentState?.deltaMs;
  const hasLeader = Boolean(leader) && delta !== null && delta !== undefined && Number.isFinite(delta);
  leaderField.textContent = hasLeader ? String(leader).slice(0, 24) : empty;
  deltaField.textContent = hasLeader ? formatDelta(delta) : empty;
  deltaField.classList.remove('ahead', 'behind');
  const semantic = hasLeader ? deltaClass(delta) : '';
  if (semantic) deltaField.classList.add(semantic);
};

const applyTheme = (theme) => {
  if (!theme) return;
  i18n.setLanguage(theme.language || 'en');
  compactTime = Boolean(theme.compactTime);
  const style = document.documentElement.style;
  const set = (name, value) => style.setProperty(name, value);
  window.overlayFonts?.ensure([theme.fontFamily, theme.timeFontFamily]);
  set('--font-family', theme.fontFamily); set('--time-font-family', theme.timeFontFamily);
  set('--font-weight', theme.fontWeight); set('--time-font-weight', theme.timeFontWeight);
  set('--name-font-size', `${theme.nameFontSize}px`); set('--delta-font-size', `${theme.deltaFontSize}px`);
  set('--padding', `${theme.padding}px`); set('--border-radius', `${theme.borderRadius}px`);
  set('--bg', hexToRgba(theme.backgroundColor, theme.backgroundOpacity));
  set('--edge', hexToRgba(theme.borderColor, .28)); set('--border-width', `${theme.borderWidth}px`);
  set('--text', theme.textColor); set('--muted', theme.mutedColor);
  set('--ahead', theme.aheadColor); set('--behind', theme.behindColor);
  root.classList.remove('align-spread', 'align-left', 'align-center', 'align-right');
  root.classList.add(`align-${theme.alignment || 'spread'}`);
  render();
};

const applyViewerState = (state) => {
  currentState = state && typeof state === 'object' ? state : null;
  render();
};

byId('close-viewer-overlay').addEventListener('click', () => void bridge.closeViewerOverlay());

bridge.onEvent((event) => {
  if (event.type === 'viewer-overlay-state') applyViewerState(event.data);
  else if (event.type === 'viewer-overlay-theme' && event.data) applyTheme(event.data);
  else if (event.type === 'state' && event.data?.viewer) applyViewerState(event.data.viewer.overlay);
});

window.addEventListener('gts-language-change', render);

i18n.applyToDocument();
(async () => {
  try {
    applyTheme(await bridge.getViewerOverlayTheme());
    // A janela pode ser aberta com uma corrida já em andamento, então o estado vem no boot.
    applyViewerState(await bridge.getViewerOverlayState());
  } catch {
    render();
  }
})();
